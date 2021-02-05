import { Tipset } from "./things/tipset";
import { BlockHeader } from "./things/block-header";
import { CID } from "./things/cid";
import { RootCID } from "./things/root-cid";
import { Quantity, utils } from "@ganache/utils";
import Emittery from "emittery";
import { DealInfo } from "./things/deal-info";
import { StartDealParams } from "./things/start-deal-params";
import { StorageDealStatus } from "./types/storage-deal-status";
import IPFSServer from "./ipfs-server";
import dagCBOR from "ipld-dag-cbor";
import { RetrievalOrder } from "./things/retrieval-order";
import { FilecoinInternalOptions } from "@ganache/filecoin-options";
import { QueryOffer } from "./things/query-offer";
import { Ticket } from "./things/ticket";
import { FileRef } from "./things/file-ref";
import fs from "fs";
import path from "path";
import { IPFS, CID as IPFS_CID } from "ipfs";
import { Account } from "./things/account";
import Database from "./database";
import TipsetManager from "./data-managers/tipset-manager";
import BlockHeaderManager from "./data-managers/block-header-manager";
import { SignedMessage } from "./things/signed-message";
import { Message } from "./things/message";
import { MessageSendSpec } from "./things/message-send-spec";
import { Address, AddressProtocol } from "./things/address";
import { Signature } from "./things/signature";
import { SigType } from "./things/sig-type";
import { Sema } from "async-sema";
import SignedMessageManager from "./data-managers/message-manager";
import BlockMessagesManager from "./data-managers/block-messages-manager";
import { BlockMessages } from "./things/block-messages";
import AccountManager from "./data-managers/account-manager";
import PrivateKeyManager from "./data-managers/private-key-manager";
import { fillGasInformation, getBaseFee, getMinerFee } from "./gas";
import { checkMessage } from "./message";

export type BlockchainEvents = {
  ready(): void;
  tipset: Tipset;
};

// Reference implementation: https://git.io/JtEVW
const BurntFundsAddress = "t099";

export default class Blockchain extends Emittery.Typed<
  BlockchainEvents,
  keyof BlockchainEvents
> {
  public tipsetManager: TipsetManager | null;
  public blockHeaderManager: BlockHeaderManager | null;
  public accountManager: AccountManager | null;
  public privateKeyManager: PrivateKeyManager | null;
  public signedMessagesManager: SignedMessageManager | null;
  public blockMessagesManager: BlockMessagesManager | null;

  readonly miner: string; // using string until we can support more address types in Address
  readonly #miningLock: Sema;

  public messagePool: Array<SignedMessage>;
  readonly #messagePoolLock: Sema;

  readonly deals: Array<DealInfo> = [];
  readonly dealsByCid: Record<string, DealInfo> = {};
  readonly inProcessDeals: Array<DealInfo> = [];

  readonly options: FilecoinInternalOptions;

  private ipfsServer: IPFSServer;
  private miningTimeout: NodeJS.Timeout | null;
  private rng: utils.RandomNumberGenerator;

  readonly #database: Database;

  private ready: boolean;

  constructor(options: FilecoinInternalOptions) {
    super();
    this.options = options;

    this.rng = new utils.RandomNumberGenerator(this.options.wallet.seed);

    this.miner = "t01000";

    this.messagePool = [];
    this.#messagePoolLock = new Sema(1);

    this.ready = false;

    // Create the IPFS server
    this.ipfsServer = new IPFSServer(this.options.chain);

    this.miningTimeout = null;
    // to prevent us from stopping while mining or mining
    // multiple times simultaneously
    this.#miningLock = new Sema(1);

    // We set these to null since they get initialized in
    // an async callback below. We could ignore the TS error,
    // but this is more technically correct (and check for not null later)
    this.tipsetManager = null;
    this.blockHeaderManager = null;
    this.accountManager = null;
    this.privateKeyManager = null;
    this.signedMessagesManager = null;
    this.blockMessagesManager = null;

    this.#database = new Database(options.database);
    this.#database.once("ready").then(async () => {
      this.blockHeaderManager = await BlockHeaderManager.initialize(
        this.#database.blocks!
      );
      this.tipsetManager = await TipsetManager.initialize(
        this.#database.tipsets!,
        this.blockHeaderManager
      );
      this.privateKeyManager = await PrivateKeyManager.initialize(
        this.#database.privateKeys!
      );
      this.accountManager = await AccountManager.initialize(
        this.#database.accounts!,
        this.privateKeyManager
      );
      this.signedMessagesManager = await SignedMessageManager.initialize(
        this.#database.signedMessages!
      );
      this.blockMessagesManager = await BlockMessagesManager.initialize(
        this.#database.blockMessages!,
        this.signedMessagesManager
      );

      const controllableAccounts = await this.accountManager.getControllableAccounts();
      if (controllableAccounts.length === 0) {
        for (let i = 0; i < this.options.wallet.totalAccounts; i++) {
          await this.accountManager.putAccount(
            Account.random(this.options.wallet.defaultBalance, this.rng)
          );
        }
      }

      const recordedGenesisTipset = await this.tipsetManager.getTipsetWithBlocks(
        0
      );
      if (recordedGenesisTipset === null) {
        // Create genesis tipset
        const genesisBlock = new BlockHeader({
          ticket: new Ticket({
            // Reference implementation https://git.io/Jt31s
            vrfProof: this.rng.getBuffer(32)
          }),
          parents: [
            // Both lotus and lotus-devnet always have the Filecoin genesis CID
            // hardcoded here. Reference implementation: https://git.io/Jt3oK
            new RootCID({
              "/": "bafyreiaqpwbbyjo4a42saasj36kkrpv4tsherf2e7bvezkert2a7dhonoi"
            })
          ]
        });

        const genesisTipset = new Tipset({
          blocks: [genesisBlock],
          height: 0
        });

        this.tipsetManager.earliest = genesisTipset; // initialize earliest
        await this.tipsetManager.putTipset(genesisTipset); // sets latest
        await this.#database.db!.put(
          "latest-tipset",
          Quantity.from(0).toBuffer()
        );
      } else {
        this.tipsetManager.earliest = recordedGenesisTipset; // initialize earliest
        const data: Buffer = await this.#database.db!.get("latest-tipset");
        const height = Quantity.from(data).toNumber();
        const latestTipset = await this.tipsetManager.getTipsetWithBlocks(
          height
        );
        this.tipsetManager.latest = latestTipset!; // initialize latest
      }

      await this.ipfsServer.start();

      // Fire up the miner if necessary
      if (this.options.miner.blockTime > 0) {
        const intervalMine = () => {
          this.mineTipset();
        };

        this.miningTimeout = setInterval(
          intervalMine,
          this.options.miner.blockTime * 1000
        );

        utils.unref(this.miningTimeout);
      }

      // Get this party started!
      this.ready = true;
      this.emit("ready");

      // Don't log until things are all ready
      this.logLatestTipset();
    });
  }

  async waitForReady() {
    return new Promise(resolve => {
      if (this.ready) {
        resolve(void 0);
      } else {
        this.on("ready", resolve);
      }
    });
  }

  /**
   * Gracefully shuts down the blockchain service and all of its dependencies.
   */
  async stop() {
    // make sure we wait until other stuff is finished,
    // prevent it from starting up again by not releasing
    await this.#miningLock.acquire();
    await this.#messagePoolLock.acquire();

    if (this.miningTimeout) {
      clearInterval(this.miningTimeout);
    }
    if (this.ipfsServer) {
      await this.ipfsServer.stop();
    }
    if (this.#database) {
      await this.#database.close();
    }
  }

  get ipfs(): IPFS | null {
    return this.ipfsServer.node;
  }

  genesisTipset(): Tipset {
    if (!this.tipsetManager || !this.tipsetManager.earliest) {
      throw new Error(
        "Could not get genesis tipset due to not being initialized yet"
      );
    }
    return this.tipsetManager.earliest;
  }

  latestTipset(): Tipset {
    if (!this.tipsetManager || !this.tipsetManager.latest) {
      throw new Error(
        "Could not get latest tipset due to not being initialized yet"
      );
    }
    return this.tipsetManager.latest;
  }

  // Reference Implementation: https://git.io/JtWnM
  async push(message: Message, spec: MessageSendSpec): Promise<SignedMessage> {
    await this.waitForReady();

    if (message.method !== 0) {
      throw new Error(
        `Unsupported Method (${message.method}); only value transfers (Method: 0) are supported in Ganache.`
      );
    }

    if (message.nonce !== 0) {
      throw new Error(
        `MpoolPushMessage expects message nonce to be 0, was ${message.nonce}`
      );
    }

    // the reference implementation doesn't allow the address to be
    // the ID protocol, but we're only going to support BLS for now
    if (
      Address.parseProtocol(message.from) === AddressProtocol.ID ||
      Address.parseProtocol(message.from) === AddressProtocol.Unknown
    ) {
      throw new Error(
        "The From address is an invalid protocol; please use a BLS or SECP256K1 address."
      );
    }
    if (
      Address.parseProtocol(message.to) === AddressProtocol.ID ||
      Address.parseProtocol(message.to) === AddressProtocol.Unknown
    ) {
      throw new Error(
        "The To address is an invalid protocol; please use a BLS or SECP256K1 address."
      );
    }

    fillGasInformation(message, spec);

    try {
      await this.#messagePoolLock.acquire();

      const account = await this.accountManager!.getAccount(message.from);
      const pendingMessagesForAccount = this.messagePool.filter(
        queuedMessage => queuedMessage.message.from === message.from
      );

      if (pendingMessagesForAccount.length === 0) {
        // account.nonce already stores the "next nonce"
        // don't add more to it
        message.nonce = account.nonce;
      } else {
        // in this case, we have messages in the pool with
        // already incremented nonces (account.nonce only
        // increments when the block is mined). this will
        // generate a nonce greater than any other nonce
        const nonceFromPendingMessages = pendingMessagesForAccount.reduce(
          (nonce, m) => {
            return Math.max(nonce, m.message.nonce);
          },
          account.nonce
        );
        message.nonce = nonceFromPendingMessages + 1;
      }

      // check if enough funds
      const messageBalanceRequired =
        message.gasFeeCap * BigInt(message.gasLimit) + message.value;
      const pendingBalanceRequired = pendingMessagesForAccount.reduce(
        (balanceSpent, m) => {
          return (
            balanceSpent +
            m.message.gasFeeCap * BigInt(m.message.gasLimit) +
            m.message.value
          );
        },
        0n
      );
      const totalRequired = messageBalanceRequired + pendingBalanceRequired;
      if (account.balance.value < totalRequired) {
        throw new Error(
          `mpool push: not enough funds: ${
            account.balance.value - pendingBalanceRequired
          } < ${messageBalanceRequired}`
        );
      }

      // sign the message
      const signature = await account.address.signMessage(message);
      const signedMessage = new SignedMessage({
        Message: message.serialize(),
        Signature: new Signature({
          type: SigType.SigTypeBLS,
          data: signature
        }).serialize()
      });

      // add to pool
      await this.pushSigned(signedMessage, false);

      this.#messagePoolLock.release();

      return signedMessage;
    } catch (e) {
      this.#messagePoolLock.release();
      throw e;
    }
  }

  async pushSigned(
    signedMessage: SignedMessage,
    acquireLock: boolean = true
  ): Promise<RootCID> {
    const error = await checkMessage(signedMessage);
    if (error) {
      throw error;
    }

    try {
      if (acquireLock) {
        await this.#messagePoolLock.acquire();
      }

      this.messagePool.push(signedMessage);

      if (acquireLock) {
        this.#messagePoolLock.release();
      }

      if (this.options.miner.blockTime === 0) {
        // we should instamine this message
        // purposely not awaiting on this as we'll
        // deadlock for Filecoin.MpoolPushMessage calls
        this.mineTipset();
      }

      return new RootCID({
        root: signedMessage.cid
      });
    } catch (e) {
      if (acquireLock) {
        this.#messagePoolLock.release();
      }
      throw e;
    }
  }

  // Note that this is naive - it always assumes the first block in the
  // previous tipset is the parent of the new blocks.
  async mineTipset(numNewBlocks: number = 1): Promise<void> {
    await this.waitForReady();

    try {
      await this.#miningLock.acquire();

      // let's grab the messages going into the next tipset
      // immediately and clear the message pool for the next tipset
      let nextMessagePool: Array<SignedMessage>;
      try {
        await this.#messagePoolLock.acquire();
        nextMessagePool = ([] as Array<SignedMessage>).concat(this.messagePool);
        this.messagePool = [];
        this.#messagePoolLock.release();
      } catch (e) {
        this.#messagePoolLock.release();
        throw e;
      }

      let previousTipset: Tipset = this.latestTipset();
      const newTipsetHeight = previousTipset.height + 1;

      let newBlocks: Array<BlockHeader> = [];

      for (let i = 0; i < numNewBlocks; i++) {
        newBlocks.push(
          new BlockHeader({
            miner: this.miner,
            parents: [previousTipset.cids[0]],
            height: newTipsetHeight,
            // Determined by interpreting the description of `weight`
            // as an accumulating weight of win counts (which default to 1)
            // See the description here: https://spec.filecoin.io/#section-glossary.weight
            parentWeight:
              BigInt(previousTipset.blocks[0].electionProof.winCount) +
              previousTipset.blocks[0].parentWeight
          })
        );
      }

      if (nextMessagePool.length > 0) {
        const successfulMessages: SignedMessage[] = [];
        for (const signedMessage of nextMessagePool) {
          const { from, to, value } = signedMessage.message;

          const baseFee = getBaseFee();
          if (baseFee !== 0) {
            const successful = await this.accountManager!.transferFunds(
              from,
              BurntFundsAddress,
              getMinerFee(signedMessage.message)
            );

            if (!successful) {
              // While we should have checked this when the message was sent,
              // we double check here just in case
              const fromAccount = await this.accountManager!.getAccount(from);
              console.warn(
                `Could not burn the base fee of ${baseFee} attoFIL from address ${from} due to lack of funds. ${fromAccount.balance.value} attoFIL available`
              );
              continue;
            }
          }

          // send mining funds
          let successful = await this.accountManager!.transferFunds(
            from,
            this.miner,
            getMinerFee(signedMessage.message)
          );

          if (!successful) {
            // While we should have checked this when the message was sent,
            // we double check here just in case
            const fromAccount = await this.accountManager!.getAccount(from);
            console.warn(
              `Could not transfer the mining fees of ${getMinerFee(
                signedMessage.message
              )} attoFIL from address ${from} due to lack of funds. ${
                fromAccount.balance.value
              } attoFIL available`
            );
            continue;
          }

          successful = await this.accountManager!.transferFunds(
            from,
            to,
            value
          );

          if (!successful) {
            // While we should have checked this when the message was sent,
            // we double check here just in case
            const fromAccount = await this.accountManager!.getAccount(from);
            console.warn(
              `Could not transfer ${value} attoFIL from address ${from} to address ${to} due to lack of funds. ${fromAccount.balance.value} attoFIL available`
            );

            // do not revert miner transfer as the miner attempted to mine
            continue;
          }

          // TODO: figure out nonce/error logic
          this.accountManager!.incrementNonce(from);

          successfulMessages.push(signedMessage);
        }

        // TODO: fill newBlocks[0].blsAggregate?
        await this.blockMessagesManager!.putBlockMessages(
          newBlocks[0].cid,
          BlockMessages.fromSignedMessages(successfulMessages)
        );
      }

      const newTipset = new Tipset({
        blocks: newBlocks,
        height: newTipsetHeight
      });

      await this.tipsetManager!.putTipset(newTipset);
      await this.#database.db!.put(
        "latest-tipset",
        Quantity.from(newTipsetHeight).toBuffer()
      );

      // Advance the state of all deals in process.
      for (const deal of this.inProcessDeals) {
        deal.advanceState();

        if (deal.state == StorageDealStatus.Active) {
          // Remove the deal from the in-process array
          this.inProcessDeals.splice(this.inProcessDeals.indexOf(deal), 1);
        }
      }

      this.logLatestTipset();

      this.emit("tipset", newTipset);

      this.#miningLock.release();
    } catch (e) {
      this.#miningLock.release();
      throw e;
    }
  }

  async hasLocal(cid: string): Promise<boolean> {
    if (!this.ipfsServer.node) {
      return false;
    }

    try {
      // This stat will fail if the object doesn't exist.
      await this.ipfsServer.node.object.stat(cid, {
        timeout: 500 // Enforce a timeout; otherwise will hang if CID not found
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  private async getIPFSObjectSize(cid: string): Promise<number> {
    if (!this.ipfsServer.node) {
      return 0;
    }

    let stat = await this.ipfsServer.node.object.stat(cid, {
      timeout: 500 // Enforce a timeout; otherwise will hang if CID not found
    });

    return stat.CumulativeSize;
  }

  private async downloadFile(cid: string, ref: FileRef): Promise<void> {
    if (!this.ipfsServer.node) {
      throw new Error("IPFS server is not running");
    }

    const dirname = path.dirname(ref.path);
    let fileStream: fs.WriteStream;
    try {
      try {
        if (!fs.existsSync(dirname)) {
          await fs.promises.mkdir(dirname, { recursive: true });
        }
        fileStream = fs.createWriteStream(`${ref.path}.partial`, {
          encoding: "binary"
        });
      } catch (e) {
        throw new Error(
          `Could not create file.\n  CID: ${cid}\n  Path: ${
            ref.path
          }\n  Error: ${e.toString()}`
        );
      }

      const chunks = this.ipfsServer.node.files.read(new IPFS_CID(cid), {
        timeout: 500 // Enforce a timeout; otherwise will hang if CID not found
      });

      for await (const chunk of chunks) {
        try {
          await new Promise<void>((resolve, reject) => {
            const shouldContinue = fileStream.write(chunk, error => {
              if (error) {
                reject(error);
              } else {
                if (shouldContinue) {
                  resolve();
                } else {
                  fileStream.once("drain", resolve);
                }
              }
            });
          });
        } catch (e) {
          throw new Error(
            `Could not save file.\n  CID: ${cid}\n  Path: ${
              ref.path
            }\n  Error: ${e.toString()}`
          );
        }
      }

      await fs.promises.rename(`${ref.path}.partial`, ref.path);
    } finally {
      // @ts-ignore
      if (fileStream) {
        fileStream.close();
      }
    }
  }

  async startDeal(proposal: StartDealParams): Promise<RootCID> {
    await this.waitForReady();

    if (!proposal.wallet) {
      throw new Error(
        "StartDealParams.Wallet not provided and is required to start a storage deal."
      );
    }

    // Get size of IPFS object represented by the proposal
    let size = await this.getIPFSObjectSize(proposal.data.root.root.value);

    // have to specify type since node types are not correct
    const account = await this.accountManager!.getAccount(
      proposal.wallet.value
    );
    if (!account.address.privateKey) {
      throw new Error(
        `Invalid StartDealParams.Wallet provided. Ganache doesn't have the private key for account with address ${proposal.wallet.value}`
      );
    }

    let signature = await account.address.signProposal(proposal);

    // TODO: I'm not sure if should pass in a hex string or the Buffer alone.
    // I *think* it's the string, as that matches my understanding of the Go code.
    // That said, node that Buffer vs. hex string returns a different CID...
    let proposalRawCid = await dagCBOR.util.cid(signature.toString("hex"));
    let proposalCid = new CID(proposalRawCid.toString());

    let deal = new DealInfo({
      proposalCid: new RootCID({
        root: proposalCid
      }),
      state: StorageDealStatus.Validating, // Not sure if this is right, but we'll start here
      message: "",
      provider: this.miner,
      pieceCid: proposal.data.pieceCid,
      size:
        proposal.data.pieceSize ||
        (await this.getIPFSObjectSize(proposal.data.root.root.value)),
      pricePerEpoch: proposal.epochPrice,
      duration: proposal.minBlocksDuration,
      dealId: this.deals.length + 1
    });

    // Because we're not cryptographically valid, let's
    // register the deal with the newly created CID
    this.dealsByCid[proposalCid.value] = deal;

    this.deals.push(deal);
    this.inProcessDeals.push(deal);

    // If we're automining, mine a new block. Note that this will
    // automatically advance the deal to the active state.
    if (this.options.miner.blockTime === 0) {
      while (deal.state !== StorageDealStatus.Active) {
        await this.mineTipset();
      }
    }

    // Subtract the cost from our current balance
    let totalPrice = BigInt(deal.pricePerEpoch) * BigInt(deal.duration);
    await this.accountManager!.transferFunds(
      proposal.wallet.value,
      proposal.miner,
      totalPrice
    );

    return deal.proposalCid;
  }

  async createQueryOffer(rootCid: RootCID): Promise<QueryOffer> {
    await this.waitForReady();

    let size = await this.getIPFSObjectSize(rootCid.root.value);

    return new QueryOffer({
      root: rootCid,
      size: size,
      miner: this.miner,
      minPrice: BigInt(size * 2) // This seems to be what powergate does
    });
  }

  async retrieve(retrievalOrder: RetrievalOrder, ref: FileRef): Promise<void> {
    await this.waitForReady();

    let hasLocal: boolean = await this.hasLocal(retrievalOrder.root.root.value);

    const account = await this.accountManager!.getAccount(
      retrievalOrder.client
    );
    if (!account.address.privateKey) {
      throw new Error(
        `Invalid RetrievalOrder.Client provided. Ganache doesn't have the private key for account with address ${retrievalOrder.client}`
      );
    }

    if (!hasLocal) {
      throw new Error(`Object not found: ${retrievalOrder.root.root.value}`);
    }

    await this.downloadFile(retrievalOrder.root.root.value, ref);

    await this.accountManager!.transferFunds(
      retrievalOrder.client,
      retrievalOrder.miner,
      retrievalOrder.total
    );
  }

  private logLatestTipset() {
    let date = new Date().toISOString();
    let tipset = this.latestTipset();

    this.options.logging.logger.log(
      `${date} INFO New heaviest tipset! [${tipset.cids[0].root.value}] (height=${tipset.height})`
    );
  }
}