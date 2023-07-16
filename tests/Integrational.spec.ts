import { Blockchain,BlockchainSnapshot, BlockchainTransaction, createShardAccount,internal,SandboxContract,SendMessageResult,SmartContractTransaction,TreasuryContract } from "@ton-community/sandbox";
import { Address, Cell, beginCell, toNano, Sender, Dictionary } from 'ton-core';
import { compile } from '@ton-community/blueprint';
import '@ton-community/test-utils';
import { keyPairFromSeed, getSecureRandomBytes, getSecureRandomWords, KeyPair } from 'ton-crypto';
import { JettonMinter as DAOJettonMinter, jettonContentToCell } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { JettonWallet as DAOWallet } from '../wrappers/JettonWallet';
import { Pool, PoolConfig } from '../wrappers/Pool';
import { Controller } from '../wrappers/Controller';
import { Elector } from "../wrappers/Elector";
import { Config  } from "../wrappers/Config";
import { setConsigliere } from "../wrappers/PayoutMinter.compile";
import { Conf, ControllerState, Errors, Op } from "../PoolConstants";
import { PayoutCollection, Conf as NFTConf, Op as NFTOp } from "../wrappers/PayoutNFTCollection";
import { PayoutItem } from "../wrappers/PayoutNFTItem";
import { testJettonTransfer, buff2bigint, computedGeneric, getRandomTon, testControllerMeta, getExternals, testLog, testLogRepayment, testMintMsg, assertLog, muldivExtra, testJettonNotification, filterTransaction, findTransaction, testJettonBurnNotification } from "../utils";
import { ElectorTest } from "../wrappers/ElectorTest";
import { getElectionsConf, getStakeConf, getValidatorsConf, getVset, loadConfig, packStakeConf, packValidatorsConf } from "../wrappers/ValidatorUtils";
import { ConfigTest } from "../wrappers/ConfigTest";
import { computeMessageForwardFees, getMsgPrices } from "../fees";
import { getRandomInt, randomAddress } from "../contracts/jetton_dao/tests/utils";
import { PayoutCollectionConfig } from "../wrappers/PayoutNFTCollection";
import { flattenTransaction } from "@ton-community/test-utils";

type Validator = {
  wallet: SandboxContract<TreasuryContract>,
  keys: KeyPair
};
type MintChunk = {
    address: Address,
    item: Address,
    index: number,
    amount: bigint
}
type BillState = Awaited<ReturnType<PayoutCollection['getTotalBill']>>;

type DistriutionResult = {
    burnt: bigint,
    distributed: bigint,
}

describe('Integrational tests', () => {
    let bc: Blockchain;
    let deployer:SandboxContract<TreasuryContract>;
    let snapStates:Map<string,BlockchainSnapshot>
    let controller_code:Cell;
    let config_code:Cell;
    let elector_code:Cell;
    let pool_code:Cell;
    let payout_minter_code:Cell;
    let payout_wallet_code:Cell;
    let dao_minter_code:Cell;
    let dao_wallet_code:Cell;
    let dao_voting_code:Cell;
    let dao_vote_keeper_code:Cell;
    let poolJetton: SandboxContract<DAOJettonMinter>;
    let pool:SandboxContract<Pool>;
    let controller:SandboxContract<Controller>;
    let validator:Validator;
    let validators: Validator[];
    let elector:SandboxContract<ElectorTest>;
    let config:SandboxContract<ConfigTest>;
    let poolConfig:PoolConfig;
    let initialState: BlockchainSnapshot;
    let sConf : ReturnType<typeof getStakeConf>;
    let vConf : ReturnType<typeof getValidatorsConf>;
    let eConf : ReturnType<typeof getElectionsConf>;
    let msgConf:ReturnType<typeof getMsgPrices>;
    let bcConf :ReturnType<typeof getMsgPrices>;
    let depositors: MintChunk[];

    let getContractData:(address: Address) => Promise<Cell>;
    let getContractBalance:(address: Address) => Promise<bigint>;
    let getUserJettonBalance:(address: Address) => Promise<bigint>;
    let loadSnapshot:(snap:string) => Promise<void>;
    let getCurTime:() => number;
    let getCreditable:() => Promise<bigint>;
    let updateConfig:() => Promise<Cell>;
    let announceElections:() => Promise<number>;
    let runElections:(profitable?: boolean) => Promise<void>;
    let waitNextRound:() => Promise<void>;
    let waitUnlock:(since: number) => void;
    let nextRound:(profitable?: boolean, count?: number, post?:() => Promise<void>) => Promise<void>;
    let assertPoolJettonMint:(txs: BlockchainTransaction[],
                              amount: bigint,
                              dest: Address) => Promise<Address>;
    let assertRoundDeposit: (txs: BlockchainTransaction[],
                             depositors: MintChunk[],
                             supply:bigint,
                             balance:bigint,
                             minterAddr:Address) => Promise<DistriutionResult>;
    let assertRoundWithdraw: (txs: BlockchainTransaction[],
                              withdrawals: MintChunk[],
                              supply:bigint,
                              balance:bigint,
                              minterAddr:Address) => Promise<DistriutionResult>
    let assertBurn:(txs: BlockchainTransaction[],
                    items: MintChunk[],
                    minter: Address,
                    post?: (mint: MintChunk) => Promise<void>) => Promise<bigint>
    let assertRound:(txs: BlockchainTransaction[],
                     round:number,
                     depositers: MintChunk[],
                     withdrawals:  MintChunk[],
                     borrowed: bigint,
                     expected: bigint,
                     returned: bigint,
                     supply: bigint,
                     totalBalance: bigint,
                     depositMinter: Address | null,
                     withdrawMinter: Address | null,
                    ) => Promise<bigint>;
    let assertNewPayout:(txs: BlockchainTransaction[],
                         expectNew: boolean,
                         prevPayout: Address | null,
                         deposit: boolean,
                         dst: Address) => Promise<SandboxContract<PayoutCollection>>;
    let assertPayoutMint:(txs: BlockchainTransaction[],
                          payout: SandboxContract<PayoutCollection>,
                          billBefore: BillState,
                          dest: Address,
                          amount: bigint, index: number) => Promise<MintChunk>
    let assertDeposit:(via: Sender,
                       amount: bigint,
                       index:number,
                       new_minter:boolean) => Promise<MintChunk>;
    let assertWithdraw:(via: Sender,
                        amount:bigint,
                        index:number,
                        new_minter: boolean,
                        fill_or_kill?: boolean) => Promise<MintChunk>
    let assertPoolBalanceNotChanged:(balance: bigint) => Promise<void>;
    let getLoanWithExpProfit:(controller: SandboxContract<Controller>, exp_profit: bigint) => Promise<bigint>;


    beforeAll(async () => {
        bc = await Blockchain.create();
        deployer = await bc.treasury('deployer', {workchain: -1, balance: toNano("1000000000")});
        controller_code = await compile('Controller');
        pool_code = await compile('Pool');
        await setConsigliere(deployer.address);
        payout_minter_code = await compile('PayoutNFTCollection');
        payout_wallet_code = await compile('PayoutWallet');
        dao_minter_code = await compile('DAOJettonMinter');
        const dao_wallet_code_raw = await compile('DAOJettonWallet');
        dao_vote_keeper_code = await compile('DAOVoteKeeper');
        dao_voting_code = await compile('DAOVoting');
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${dao_wallet_code_raw.hash().toString('hex')}`), dao_wallet_code_raw);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        bc.libs = libs;
        let lib_prep = beginCell().storeUint(2,8).storeBuffer(dao_wallet_code_raw.hash()).endCell();
        dao_wallet_code = new Cell({ exotic:true, bits: lib_prep.bits, refs:lib_prep.refs});

        elector_code    = await compile('Elector');
        config_code     = await compile('Config');

        const confDict = loadConfig(bc.config);

        sConf = getStakeConf(confDict);
        vConf = getValidatorsConf(confDict);
        eConf = getElectionsConf(confDict);
        msgConf = getMsgPrices(bc.config, -1);
        bcConf  = getMsgPrices(bc.config, 0);


        validators = [];

        const validatorsCount   = 5;
        const validatorsWallets = await bc.createWallets(validatorsCount, {workchain: -1});

        validator = {
            wallet: await bc.treasury('validator', {workchain: -1}),
            keys: keyPairFromSeed(await getSecureRandomBytes(32))
        };

        for (let i = 0; i < validatorsCount; i++) {
            validators.push({
                wallet: validatorsWallets[i],
                keys: await keyPairFromSeed(await getSecureRandomBytes(32))
            });
        }

        // Downgrading elections requirements for performance and simplicity
        vConf.min_validators  = validatorsCount;
        sConf.min_total_stake = BigInt(validatorsCount) * sConf.min_stake;
        confDict.set(17, packStakeConf(sConf));
        confDict.set(16, packValidatorsConf(vConf));

        bc.setConfig(beginCell().storeDictDirect(confDict).endCell());

        const content   = jettonContentToCell({type:1,uri:"https://example.com/1.json"});
        poolJetton      =   bc.openContract(DAOJettonMinter.createFromConfig({
                                                  admin:deployer.address,
                                                  content,
                                                  voting_code:dao_voting_code,
                                                  },
                                                  dao_minter_code));
        poolConfig = {
              pool_jetton : poolJetton.address,
              pool_jetton_supply : 0n,
              optimistic_deposit_withdrawals: 0n,

              sudoer : deployer.address,
              governor : deployer.address,
              interest_manager : deployer.address,
              halter : deployer.address,
              consigliere : deployer.address,
              approver : deployer.address,

              controller_code : controller_code,
              pool_jetton_wallet_code : dao_wallet_code,
              payout_minter_code : payout_minter_code,
              vote_keeper_code : dao_vote_keeper_code,
        };

        const electorAddress = Address.parse('Ef8zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM0vF');
        const configAddress  = Address.parse('Ef9VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVbxn');


        await bc.setShardAccount(electorAddress, createShardAccount({
          address: electorAddress,
          code: elector_code,
          data: ElectorTest.emptyState(buff2bigint(loadConfig(bc.config).get(34)!.hash())),
          balance: toNano('1000')
        }));
        elector = bc.openContract(ElectorTest.createFromAddress(electorAddress));

        await bc.setShardAccount(configAddress, createShardAccount({
          address: configAddress,
          code: config_code,
          data: ConfigTest.configState(bc.config),
          balance: toNano('1000')
        }));
        config = bc.openContract(ConfigTest.createFromAddress(configAddress));

        pool = bc.openContract(Pool.createFromConfig(poolConfig, pool_code));

        await pool.sendDeploy(deployer.getSender(),Conf.minStorage + toNano('1'));

        await poolJetton.sendDeploy(deployer.getSender(), toNano('1.05'));
        await poolJetton.sendChangeAdmin(deployer.getSender(), pool.address);

        loadSnapshot = async (name:string) => {
          const state = snapStates.get(name);
          if(!state)
            throw(Error(`Can't find state ${name}\nCheck tests execution order`));
          await bc.loadFrom(state);
        }

        snapStates = new Map<string, BlockchainSnapshot>();
        snapStates.set('initial', bc.snapshot());
        getContractData = async (address: Address) => {
          const smc = await bc.getContract(address);
          if(!smc.account.account)
            throw("Account not found")
          if(smc.account.account.storage.state.type != "active" )
            throw("Atempting to get data on inactive account");
          if(!smc.account.account.storage.state.state.data)
            throw("Data is not present");
          return smc.account.account.storage.state.state.data
        }
        getContractBalance = async (address: Address) => {
            const smc = await bc.getContract(address);
            return smc.balance;
        };
        getUserJettonBalance = async (address) => {
            const walletSmc = await bc.getContract(address);
            // If not minted
            if(walletSmc.accountState === undefined) {
                return 0n;
            }

            const walletContract = bc.openContract(DAOWallet.createFromAddress(
                    await poolJetton.getWalletAddress(address)
            ));
            return await walletContract.getJettonBalance()
        }
        getCurTime = () => bc.now ?? Math.floor(Date.now() / 1000);
        getCreditable = async () => {
            const poolData = await pool.getFullData();
            const poolBalance = await getContractBalance(pool.address);
            const cred = poolBalance - muldivExtra(poolData.requestedForWithdrawal,
                                                   poolData.totalBalance,
                                                   poolData.supply) - Conf.minStorage;
            // console.log(`Pool balance:${poolBalance}`);
            // console.log(`Cred:${cred}`);
            const balanced = BigInt(256 + Conf.disbalanceTolerance) * poolData.totalBalance / 512n;
            // console.log(`Balanced:${balanced}`);
            return  cred < balanced ? cred : balanced;
        };
        updateConfig = async () => {
          // Loading data from config contract and setting as sandbox config
          const confData = await getContractData(configAddress);
          const confCell = confData.beginParse().preloadRef();
          bc.setConfig(confCell);
          return confCell;
        }

        waitNextRound = async () => {
          const nextVset = getVset(bc.config, 36);
          // Setting vset
          bc.now = getCurTime();
          if(bc.now < nextVset.utime_since)
            bc.now = nextVset.utime_since;

          await config.sendTickTock("tock");
          const newConf = await updateConfig();
          // Should change to the current vset
          const newVset = getVset(newConf, 34);
          expect(newVset).toEqual(nextVset);
          // Should trigger unfreeze if possible
          await elector.sendTickTock("tick");
        }
        waitUnlock = async (since:number) => {
            const unlockTime = since + eConf.stake_held_for + 61;
            if(getCurTime() < unlockTime)
                bc.now = unlockTime;
        }

        announceElections = async () => {
          const curVset = getVset(bc.config, 34);
          const curTime = getCurTime();
          const electBegin = curVset.utime_unitl - eConf.begin_before + 1;

          const prevElections = await elector.getActiveElectionId();

          if(curTime < electBegin) {
              bc.now = electBegin;
          }
          else if(curTime < prevElections - eConf.end_before) {
              return prevElections;
          }

          let curElections = prevElections;

          do {
              await elector.sendTickTock("tick");
              curElections = await elector.getActiveElectionId();
          } while(curElections == 0 || prevElections == curElections);

          return curElections;
        }

        runElections = async (profitable: boolean = true) => {

          await announceElections();

          if(profitable) {
            // Elector profits
            await bc.sendMessage(internal({
              from: new Address(-1, Buffer.alloc(32, 0)),
              to: elector.address,
              body: beginCell().endCell(),
              value: toNano('100000'),
            }));
          }

          let electState  = await elector.getParticipantListExtended();
          const partCount = electState.list.length;
          let curStake    = electState.total_stake;
          let stakeSize   = sConf.min_stake + toNano('1');
          let i           = 0;

          while(i < validators.length
                && (curStake < sConf.min_total_stake || i + partCount < vConf.min_validators)) {
            const validator = validators[i++];
            const hasStake  = await elector.getReturnedStake(validator.wallet.address);
            if(hasStake > 0n) {
                // Get stake back
                const rec = await elector.sendRecoverStake(validator.wallet.getSender());
                expect(rec.transactions).toHaveTransaction({
                    from: elector.address,
                    to: validator.wallet.address,
                    op: Op.elector.recover_stake_ok
                });
            }
            const res = await elector.sendNewStake(validator.wallet.getSender(),
                                                   stakeSize,
                                                   validator.wallet.address,
                                                   validator.keys.publicKey,
                                                   validator.keys.secretKey,
                                                   electState.elect_at);
            expect(res.transactions).toHaveTransaction({
              from: elector.address,
              to: validator.wallet.address,
              op: Op.elector.new_stake_ok
            });
            curStake += stakeSize;
          }

          // Skipping time till elections
          bc.now    = electState.elect_at;
          // Run elections
          const res = await elector.sendTickTock("tock");

          /*
           * TODO fix test-utils for non generic transactions
          expect(res.transactions).toHaveTransaction({
            from: elector.address,
            to: config.address
            ...
          });
          */
          electState = await elector.getParticipantListExtended();
          expect(electState.finished).toBe(true);
          // Updating active vset
          await elector.sendTickTock("tock");
        }

        nextRound = async (profitable: boolean = true, count:number = 1, post?:() => void) => {
            while(count--) {
                await runElections(profitable);
                await updateConfig();
                await waitNextRound();
                if(post) {
                    await post()
                }
            }
        };
        assertPoolJettonMint = async(txs: BlockchainTransaction[],
                                     amount:bigint,
                                     dest:Address) => {

            const depositWallet = await poolJetton.getWalletAddress(dest);
            const mintTx = findTransaction(txs, {
                from: pool.address,
                to: poolJetton.address,
                op: Op.payout.mint,
                outMessagesCount: 1,
                body: (x) => testMintMsg(x!, {
                    dest,
                    amount,
                    notification: Conf.notificationAmount,
                    forward: 0n
                }),
                success: true
            });
            if(mintTx === undefined) {
            // No action phase failures
                console.log(`Pool:${pool.address}`);
                console.log(`Minter:${poolJetton.address}`);
                console.log(txs.map(x => flattenTransaction(x)));
                expect(txs).not.toHaveTransaction({
                    actionResultCode: (x) => x! !== undefined && x! !== 0
                });
            }
            expect(mintTx).not.toBeUndefined();
            const inMsg = mintTx!.inMessage!;
            // Meh
            if(inMsg.info.type !== "internal" )
                throw(Error("Internal expected"));

            const fwdFee = computeMessageForwardFees(msgConf, inMsg);
            const expValue = Conf.notificationAmount + Conf.distributionAmount;
            expect(inMsg.info.value.coins).toBeGreaterThanOrEqual(expValue
                                                                  - fwdFee.fees
                                                                  - fwdFee.remaining);

            // Transfer pool jettons to dest jetton wallet
            expect(txs).toHaveTransaction({
                from: poolJetton.address,
                to: depositWallet,
                op: Op.jetton.internal_transfer,
                body: (x) => testJettonTransfer(x!, {
                    amount
                }),
                success: true,
            });
            // Destination wallet receives transfer notification triggers distribution
            expect(txs).toHaveTransaction({
                from: depositWallet,
                to: dest,
                op: Op.jetton.transfer_notification,
                body: (x) => testJettonNotification(x!, {
                    from: null,// poolJetton.address,
                    amount,
                }),
                success: true
            });
            return depositWallet;
        }

        assertBurn = async (txs: BlockchainTransaction[],
                            mints: MintChunk[], minter: Address,
                            post?: (mint: MintChunk) => Promise<void>) => {
            // Filter burn related transactions
            const burnTxs = filterTransaction(txs, {
                op: (x) => x! == NFTOp.burn || x! == NFTOp.burn_notification,
            });
            expect(burnTxs.length).toBeGreaterThanOrEqual(2); // At least one burn and notification
            // Burning deposit jettons
            // console.log("Mints:", mints);
            let burnTotal = 0n;
            for (let i = 0; i < mints.length; i++) {
                const burnSource = i == 0 ? minter : mints[mints.length - i].item
                expect(burnTxs).toHaveTransaction({
                    from: burnSource,
                    to: mints[mints.length - i - 1].item,
                    op: NFTOp.burn,
                    value: Conf.burnRequestValue,
                    success: true,
                    actionResultCode: 0
                });
                // Every mint chunk should burn
                expect(burnTxs).toHaveTransaction({
                    from: mints[i].item,
                    to: minter,
                    op: NFTOp.burn_notification,
                    body: (x) => testJettonBurnNotification(x!, {
                        amount: mints[i].amount,
                    }),
                    success: true,
                    actionResultCode: 0
                });
                burnTotal += mints[i].amount;
                // Expect item to be destroyed
                const itemSmc = await bc.getContract(mints[i].item);
                expect(itemSmc.balance).toBe(0n);
                expect(itemSmc.accountState).toBeUndefined();

                if(post)
                    await post(mints[i]);
            }

            return burnTotal;
        }
        assertRoundDeposit = async (txs: BlockchainTransaction[],
                                    depositors: MintChunk[],
                                    supply: bigint,
                                    balance: bigint,
                                    minterAddr: Address) => {

            const deposit = depositors.reduce((total, cur) => total + cur.amount, 0n);
            const amount  = muldivExtra(deposit, supply, balance);
            const depositWallet =  await assertPoolJettonMint(txs, amount, minterAddr);

            let distributed = 0n;
            const burnt = await assertBurn(txs, depositors, minterAddr,async (mint: MintChunk) => {
                const depoJetton = await poolJetton.getWalletAddress(mint.address);
                const jetton = bc.openContract(DAOWallet.createFromAddress(depoJetton));
                const share  = muldivExtra(mint.amount, supply, balance)
                // Transfering pool jettons to depositor wallet
                expect(txs).toHaveTransaction({
                    from: depositWallet,
                    to: depoJetton,
                    op: Op.jetton.internal_transfer,
                    body: (x) => testJettonTransfer(x!, {
                        amount: share
                    }),
                    success: true,
                });
                // Pool jetton transfer notification
                expect(txs).toHaveTransaction({
                    from:depoJetton,
                    to: mint.address,
                    op: Op.jetton.transfer_notification,
                    body: (x) => testJettonNotification(x!, {
                        amount: share
                    })
                });
                distributed += share;
            });
            // No action phase failures
            expect(txs).not.toHaveTransaction({
                actionResultCode: (x) => x! !== undefined && x! !== 0
            });

            // Verifying deposit affected data
            const dataAfter = await pool.getFullData();
            expect(dataAfter.requestedForDeposit).toEqual(0n);
            expect(dataAfter.supply).toEqual(supply + distributed);
            // Verifying pool supply matches what pool's expectations
            expect(await poolJetton.getTotalSupply()).toEqual(supply + distributed);
            return {
                burnt,
                distributed
            };
        }
        assertRoundWithdraw = async (txs: BlockchainTransaction[],
                                     withdrawals: MintChunk[],
                                     supply: bigint,
                                     balance: bigint,
                                     minterAddr: Address) => {
            const withdraw = withdrawals.reduce((total, cur) => total + cur.amount, 0n);
            const amount   = muldivExtra(withdraw, balance, supply);
            // console.log(`Requested:${withdraw}`);
            // console.log(`Supply:${supply}`);
            // console.log(`Balance:${balance}`);
            // console.log(`Withdraw amount:${amount}`);
            // Check tons sent for distribution
            const distrTx = findTransaction(txs, {
                from: pool.address,
                to: minterAddr,
                op: NFTOp.start_distribution,
            });

            expect(distrTx).not.toBeUndefined();

            const inMsg = distrTx!.inMessage!;
            if(inMsg.info.type !== "internal")
                throw(Error("Should be internal"));

            const fwdFee = computeMessageForwardFees(bcConf, inMsg);
            const rawVal = inMsg.info.value.coins;
            const msgVal = rawVal + fwdFee.fees + fwdFee.remaining;
            // console.log(`Msg val:${msgVal}`);
            // console.log(`Raw value:${inMsg.info.value.coins}`);
            // console.log(`Amount and fee:${amount + Conf.notificationAmount}`);
            expect(msgVal).toEqual(amount + Conf.notificationAmount);

            const burnt = await assertBurn(txs, withdrawals, minterAddr, async (mint: MintChunk) => {
                const share = muldivExtra(mint.amount, balance, supply);
                expect(txs).toHaveTransaction({
                    from: minterAddr,
                    to: mint.address,
                    op: NFTOp.distributed_asset,
                    value: (x) => x! >= share
                });
            });

            // Withdraw data effects
            const dataAfter = await pool.getFullData();
            expect(dataAfter.requestedForWithdrawal).toEqual(0n);
            expect(dataAfter.supply).toEqual(supply - burnt);
            expect(dataAfter.totalBalance).toEqual(balance - amount);
            expect(dataAfter.withdrawalPayout).toBe(null);
            // Verifying pool supply matches what pool's expectations
            expect(await poolJetton.getTotalSupply()).toEqual(supply - burnt);
            return {
                burnt,
                distributed: amount,
            };
        }
        assertRound   = async (txs: BlockchainTransaction[],
                               round: number,
                               depositors: MintChunk[],
                               withdrawals:  MintChunk[],
                               borrowed: bigint,
                               expected: bigint,
                               returned: bigint,
                               supply: bigint,
                               totalBalance: bigint,
                               depositMinter: Address | null,
                               withdrawMinter: Address | null) => {
            let fee        = 0n;
            let sentDuring = Conf.serviceNotificationAmount;
            const profit   = returned - borrowed - Conf.finalizeRoundFee;
            const curBalance = totalBalance + profit;
            if(profit > 0) {
                fee = Conf.governanceFee * profit / Conf.shareBase;
                // console.log(`Governance fee:${fee}`);
            }
            expect(txs).toHaveTransaction({
                from: pool.address,
                to: deployer.address, // Interest manager
                op: Op.interestManager.stats,
                body: (x) => {
                    const bs = x!.beginParse().skip(32 + 64);
                    const borrowedSent = bs.loadCoins();
                    const expectedSent = bs.loadCoins();
                    const returnedSent = bs.loadCoins();
                    // console.log(`BorrowedSent:${borrowedSent}`);
                    // console.log(`expectedSent:${expectedSent}`);
                    // console.log(`returnedSent:${returnedSent}`);
                    return borrowedSent == borrowed
                           && expectedSent == expected
                           && returnedSent == returned;
                }
            });
            if(depositors.length > 0) {
                expect(depositMinter).not.toBe(null);
                const depoRes = await assertRoundDeposit(txs, depositors, supply, curBalance, depositMinter!);
                supply += depoRes.distributed;
                sentDuring += Conf.notificationAmount + Conf.distributionAmount;
            }
            if(withdrawals.length > 0n) {
                expect(withdrawMinter).not.toBe(null);
                const withdraw = await assertRoundWithdraw(txs, withdrawals, supply, curBalance, withdrawMinter!);
                supply -= withdraw.burnt;

                sentDuring += withdraw.distributed + Conf.notificationAmount;
            }
            if(fee > Conf.serviceNotificationAmount) {
                expect(txs).toHaveTransaction({
                    from: pool.address,
                    to: deployer.address, // Interest manager
                    value: fee - msgConf.lumpPrice // Bit lazy
                });
                sentDuring += fee;
            }
            const dataAfter = await pool.getFullData();
            // expect(dataAfter.currentRound.roundId).toEqual(round + 1);
            // Verify that we eactually sent out as much as expected
            const totalOut = filterTransaction(txs, {from: pool.address}).map(
                x => x.inMessage!
            ).reduce((totalFee, curMsg) => {
                let sumVal = totalFee;
                if(curMsg.info.type === "internal") {
                    // console.log(curMsg.info);
                    const op = curMsg.body.beginParse().preloadUint(32);
                    const chainConf = curMsg.info.dest.workChain == 0 ? bcConf : msgConf;
                    const msgFee = computeMessageForwardFees(chainConf, curMsg);
                    const origVal = curMsg.info.value.coins + msgFee.fees + msgFee.remaining;
                    //console.log(`Bits:${curMsg.body.bits.length}`);
                    // console.log(`Orig value exp:${origVal}`);
                    // console.log(`Value sent:${curMsg.info.value.coins}`);
                    //console.log(`Fees:${msgFee.fees}\n${msgFee.remaining}\n${curMsg.info.forwardFee}`);
                    sumVal += origVal;
                }
                return sumVal;
            }, 0n);
            // Actual sent amount should match expected
            // console.log(`Total out:${totalOut}`);
            // console.log(`Expected:${sentDuring}`);
            expect(totalOut).toEqual(sentDuring);

            return sentDuring;
        }
        assertNewPayout  = async(txs: BlockchainTransaction[],
                                 expectNew: boolean,
                                 prevPayout: Address | null,
                                 deposit: boolean,
                                 dst: Address) => {
            let payout = deposit ? await pool.getDepositMinter()
                                 : await pool.getWithdrawalMinter();
            if(expectNew) {
                expect(txs).toHaveTransaction({
                    from: pool.address,
                    to: payout.address,
                    deploy: true,
                    success: true
                });
            }
            else {
                expect(txs).not.toHaveTransaction({
                    from: pool.address,
                    to: payout.address,
                    deploy: true
                });
            }
            if(prevPayout !== null) {
                expect(prevPayout.equals(payout.address)).toBe(!expectNew);
            }

            return bc.openContract(payout);
        }
        assertPayoutMint = async(txs: BlockchainTransaction[],
                                 payout: SandboxContract<PayoutCollection>,
                                 billBefore: BillState,
                                 dest: Address,
                                 amount: bigint, index: number) => {
            // Testing mint of new payout jettons
            const item   = bc.openContract(
                PayoutItem.createFromAddress(await payout.getNFTAddress(BigInt(index))
            ));
            expect(txs).toHaveTransaction({
                from: pool.address,
                to: payout.address,
                op: Op.payout.mint,
                body: (x) => testMintMsg(x!, {
                    dest,
                    amount: amount,
                    notification: NFTConf.transfer_notification_amount
                }),
                success: true
            });
            expect(txs).toHaveTransaction({
                from: payout.address,
                to: item.address,
                deploy: true,
                success: true
            });

            const itemData = await item.getNFTData();
            expect(itemData.collection).toEqualAddress(payout.address);
            expect(itemData.index).toEqual(index);
            expect(itemData.inited).toBe(true);
            expect(itemData.owner).toEqualAddress(dest);
            expect(await item.getBillAmount()).toEqual(amount);

            const billAfter = await payout.getTotalBill();
            expect(billAfter.billsCount).toEqual(billBefore.billsCount + 1n);
            expect(billAfter.totalBill).toEqual(billBefore.totalBill + amount);

            return {
                address: dest,
                item: item.address,
                index,
                amount
            }
        }
        assertDeposit = async (via: Sender, amount: bigint, index: number, new_round: boolean) => {
            // Assert deposit/withdraw jettons mint and effects
            const dataBefore = await pool.getFullData();
            const prevMinter = dataBefore.depositPayout;
            let   billBefore: BillState;
            if(new_round) {
                billBefore = {
                    totalBill: 0n,
                    billsCount: 0n
                };
            }
            else {
                const tmpMinter = bc.openContract(await pool.getDepositMinter());
                billBefore = await tmpMinter.getTotalBill();
            }

            const res    = await pool.sendDeposit(via, amount);
            const minter = await assertNewPayout(res.transactions,
                                                 new_round,
                                                 prevMinter,
                                                 true, via.address!);
            const expDepo  = amount - Conf.poolDepositFee;
            const nm       = await assertPayoutMint(res.transactions,
                                                    minter,
                                                    billBefore,
                                                    via.address!,
                                                    expDepo,
                                                    index);

            const dataAfter = await pool.getFullData();
            expect(dataAfter.requestedForDeposit).toEqual(dataBefore.requestedForDeposit + expDepo);
            expect(dataAfter.totalBalance).toEqual(dataBefore.totalBalance);
            expect(dataAfter.depositPayout).toEqualAddress(minter.address);

            return nm;
        }
        assertWithdraw = async (via:Sender,amount:bigint, index: number, new_round: boolean, fill_or_kill:boolean = false) => {
            const withdrawAddr = via.address!;
            // Withdraw is burning pool jettons pTONs
            const withdrawJetton = bc.openContract(DAOWallet.createFromAddress(
                await poolJetton.getWalletAddress(withdrawAddr)
            ));
            const dataBefore = await pool.getFullData();
            const prevMinter = dataBefore.withdrawalPayout;

            let   billBefore: BillState;
            if(new_round) {
                billBefore = {
                    totalBill: 0n,
                    billsCount: 0n
                };
            }
            else {
                const tmpMinter = bc.openContract(await pool.getWithdrawalMinter());
                billBefore = await tmpMinter.getTotalBill();
            }

            const res = await withdrawJetton.sendBurnWithParams(via, toNano('1.05'),
                                                                amount,
                                                                withdrawAddr, false, false);
            const minter = await assertNewPayout(res.transactions,
                                                 new_round,
                                                 prevMinter,
                                                 false, via.address!);
            const nm     = await assertPayoutMint(res.transactions,
                                                  minter,
                                                  billBefore,
                                                  via.address!,
                                                  amount,
                                                  index);
            const dataAfter = await pool.getFullData();
            expect(dataAfter.requestedForWithdrawal).toEqual(dataBefore.requestedForWithdrawal + amount);
            expect(dataAfter.totalBalance).toEqual(dataBefore.totalBalance);
            expect(dataAfter.withdrawalPayout).toEqualAddress(minter.address);

            return nm;
        }
        assertPoolBalanceNotChanged = async (balance) => {
            const poolData = await pool.getFullDataRaw();
            const poolBalance = await getContractBalance(pool.address);
            const poolFunds   = poolBalance - poolData.totalBalance;
            expect(poolFunds).toEqual(balance);
        }
        getLoanWithExpProfit = async (lender, exp_profit) => {
            const poolData   = await pool.getFullData();
            const controllerData = await lender.getControllerData();
            const validator = bc.sender(controllerData.validator);
            if(controllerData.state != ControllerState.REST)
                throw(Error("Controller is not in REST state"));
            const loanAmount = exp_profit * Conf.shareBase / BigInt(poolData.interestRate);
            const creditable = await getCreditable();
            if(creditable < loanAmount)
                throw(Error("Pool doesn't have enough ton to spare"));

            // Just in case
            await controller.sendUpdateHash(validator);
            const curVset = getVset(bc.config, 34);
            if(getCurTime() < curVset.utime_unitl - eConf.begin_before) {
                bc.now = curVset.utime_unitl - eConf.begin_before + 1;
            }

            const reqBalance = await lender.getBalanceForLoan(loanAmount, poolData.interestRate);
            const controllerBalance = await getContractBalance(lender.address);
            if(controllerBalance < reqBalance) {
                await lender.sendTopUp(validator, reqBalance - controllerBalance + toNano('1'));
            }
            const res =await lender.sendRequestLoan(validator, loanAmount, loanAmount, poolData.interestRate);
            expect(res.transactions).toHaveTransaction({
                from: pool.address,
                to: controller.address,
                op: Op.controller.credit
            });
            return loanAmount;
        }
    });
    describe('Simple', () => {
    it('Deploy controller', async () => {
        const res = await pool.sendRequestControllerDeploy(validator.wallet.getSender(), Conf.minStorage + toNano('1'), 0);
        expect(res.transactions).toHaveTransaction({
            from: validator.wallet.address,
            to: pool.address,
            outMessagesCount: 1
        });
        const deployMsg = res.transactions[1].outMessages.get(0)!;

        if(deployMsg.info.type !== "internal")
            throw(Error("Should be internal"));

        expect(res.transactions).toHaveTransaction({
            from: pool.address,
            to: deployMsg.info.dest,
            deploy: true,
            success: true,
        });

        controller = bc.openContract(Controller.createFromAddress(deployMsg.info.dest));

        const controllerData = await controller.getControllerData();

        expect(controllerData.state).toEqual(ControllerState.REST);
        expect(controllerData.validator).toEqualAddress(validator.wallet.address);
        expect(controllerData.pool).toEqualAddress(pool.address);
        expect(controllerData.approved).toBe(false);
        const controllerAddr = await pool.getControllerAddress(0, validator.wallet.address);
        expect(controllerAddr).toEqualAddress(controller.address);
        // Check that the approver is set right
        await controller.sendApprove(deployer.getSender(), true);
        expect((await controller.getControllerData()).approved).toBe(true);
        snapStates.set('deployed', bc.snapshot());
    });
    it('Simple deposit', async () => {
        let deposited = 0n;
        depositors = [];
        let expBalances: bigint[] = [];
        const dataBefore = await pool.getFullData();
        expect(dataBefore.totalBalance).toEqual(0n);
        await pool.sendDonate(deployer.getSender(), Conf.finalizeRoundFee);
        expect((await pool.getFullData()).totalBalance).toEqual(Conf.finalizeRoundFee);
        let i = 0;
        while(deposited < sConf.min_stake * 3n) {
            const depo   = getRandomTon(150000, 200000);
            const depositor = await bc.treasury(`Depo:${i}`);
            const depoRes   = await assertDeposit(depositor.getSender(), depo, i, i == 0);
            depositors.push(depoRes);
            expBalances.push(depoRes.amount);
            deposited += depo;
            i++;
        }
        // Now some repetitive deposits to check if it will add up
        let repeats: MintChunk[] = [];
        for(let k = 0; k < depositors.length; k++) {
            const depo = getRandomTon(15000, 20000);
            let j = getRandomInt(1, 3, 2);
            const depoSender = bc.sender(depositors[k].address);
            for (let l = 0; l < j; l++) {
                const depoRes   = await assertDeposit(depoSender, depo, i + l, false);
                repeats.push(depoRes);
                expBalances[k] += depoRes.amount;
                deposited += depo;
            }
            i += j;
        }
        const poolData  = await pool.getFullData();
        await nextRound();
        const res = await pool.sendTouch(deployer.getSender());
        const dataAfter = await pool.getFullData();
        expect(dataAfter.currentRound.roundId).toEqual(dataBefore.currentRound.roundId + 1);
        await assertRound(res.transactions,
                          0,
                          [...depositors,...repeats],
                          [],
                          0n,
                          0n,
                          0n,
                          poolData.supply,
                          poolData.totalBalance,
                          poolData.depositPayout,
                          poolData.withdrawalPayout);
        for(let i = 0; i <expBalances.length; i++) {
            const jettonAddr = await poolJetton.getWalletAddress(depositors[i].address);
            const jWallet = bc.openContract(DAOWallet.createFromAddress(jettonAddr));
            expect(await jWallet.getJettonBalance()).toEqual(expBalances[i]);
        }
        snapStates.set('deposited', bc.snapshot());
    });

    it('Request loan from controller', async () => {
        // Loan should be requested during elections
        const curVset = getVset(bc.config, 34);
        if(getCurTime() < curVset.utime_unitl - eConf.begin_before) {
            bc.now = curVset.utime_unitl - eConf.begin_before + 1;
        }
        let   maxLoan = sConf.min_stake;
        let   minLoan = maxLoan - toNano('100000');
        const poolData = await pool.getFullData();
        const maxInterest = poolData.interestRate;
        let   reqBalance  = await controller.getBalanceForLoan(maxLoan, maxInterest);
        const controllerBalance = await getContractBalance(controller.address);
        if(controllerBalance < reqBalance) {
            const delta = reqBalance - controllerBalance;
            await controller.sendTopUp(validator.wallet.getSender(), delta + toNano('1'));
        }

        let   creditable = await getCreditable();
        if(creditable > maxLoan)
            creditable = maxLoan;

        const expInterest = creditable * BigInt(poolData.interestRate) / Conf.shareBase;
        const res = await controller.sendRequestLoan(validator.wallet.getSender(),
                                                     minLoan,
                                                     maxLoan,
                                                     maxInterest);
        // Loan request
        expect(res.transactions).toHaveTransaction({
            from: controller.address,
            to: pool.address,
            op: Op.pool.request_loan,
            body: (x) => {x!;
                const rs = x.beginParse().skip(64 + 32);
                // That's probably too much
                const minLoanSent = rs.loadCoins();
                const maxLoanSent = rs.loadCoins();
                const maxInterestSent = rs.loadUint(24);
                const requestMatch =
                    minLoanSent == minLoan &&
                    maxLoanSent == maxLoan &&
                    maxInterestSent == maxInterest;
                // Meta we might want to check
                const metaMatch = testControllerMeta(rs.preloadRef(), {
                    id: 0,
                    governor: deployer.address,
                    pool: pool.address,
                    approver: deployer.address,
                    halter: deployer.address
                });

                return requestMatch && metaMatch;
            },
            success: true
        });
        // Loan response
        const poolCreditTrans = findTransaction(res.transactions, {
            from: pool.address,
            to: controller.address,
            op: Op.controller.credit,
            success: true
        })!;

        expect(poolCreditTrans).not.toBeUndefined();
        expect(poolCreditTrans.parent).not.toBeUndefined();
        const creditMsg = poolCreditTrans.inMessage!;
        if(creditMsg.info.type !== "internal")
            throw(Error("Can't be"));

        const fwdFee = computeMessageForwardFees(msgConf, creditMsg);

        expect(creditMsg.info.value.coins).toEqual(creditable - fwdFee.fees - fwdFee.remaining);
        const bs = creditMsg.body.beginParse().skip(64 + 32);
        expect(bs.loadCoins()).toEqual(creditable + expInterest);
        const controllerData = await controller.getControllerData();
        expect(controllerData.borrowedAmount).toEqual(creditable + expInterest);
        expect(controllerData.borrowingTime).toEqual(poolCreditTrans.parent!.now);
        const loanData = await pool.getLoan(0, validator.wallet.address, false);
        expect(loanData.borrowed).toEqual(creditable);
        expect(loanData.interestAmount).toEqual(expInterest);
        assertLog(res.transactions, pool.address, 1, {
            lender: controller.address,
            amount: creditable
        });
    });
    it('Controller deposit to elector', async () => {
        const controllerData = await controller.getControllerData();
        let   prevElect      = 0;

        const curElect = await announceElections();
        expect(prevElect).not.toEqual(curElect);
        prevElect      = curElect;
        const depo     = sConf.min_stake + toNano('1');
        const res      = await controller.sendNewStake(validator.wallet.getSender(),
                                                       depo,
                                                       validator.keys.publicKey,
                                                       validator.keys.secretKey,
                                                       curElect);
        expect(res.transactions).toHaveTransaction({
            from: elector.address,
            to: controller.address,
            op: Op.elector.new_stake_ok
        });
        const controllerAfter = await controller.getControllerData();
        expect(controllerAfter.validatorSetChangeCount).toEqual(0);
        expect(controllerAfter.validatorSetChangeTime).toEqual(getVset(bc.config, 34).utime_since);
        const stake = await elector.getStake(validator.keys.publicKey);
        expect(stake).toEqual(depo - toNano('1'));
        // Run elections and update hashes
        await nextRound();
        await controller.sendUpdateHash(validator.wallet.getSender());
        //console.log(updRes.transactions[1].description);
        expect((await controller.getControllerData()).validatorSetChangeCount).toEqual(1);
        await pool.sendTouch(deployer.getSender());
    });
    it('Next elections round and profit return', async () => {
        const controllerData = await controller.getControllerData();
        const dataBefore     = await pool.getFullData();
        expect(controllerData.validatorSetChangeCount).toEqual(1); // Only round we participated in
        const curLoan        = await pool.getLoan(0, validator.wallet.address, true);

        expect(curLoan.borrowed).toBeGreaterThan(0n);
        expect(curLoan.interestAmount).toBeGreaterThan(0n);

        // Skip one
        await nextRound();
        let res = await controller.sendUpdateHash(validator.wallet.getSender());
        waitUnlock(res.transactions[1].now);
        await elector.sendTickTock("tock"); // Announce elecitons
        await elector.sendTickTock("tock"); // Update credits

        res = await controller.sendRecoverStake(validator.wallet.getSender());
        // Should get more than borrowed
        expect(res.transactions).toHaveTransaction({
            from: elector.address,
            to: controller.address,
            op: Op.elector.recover_stake_ok,
            value: (x) => x! > controllerData.borrowedAmount,
            success:true
        });
        // Should trigger loan repayment
        expect(res.transactions).toHaveTransaction({
            from: controller.address,
            to: pool.address,
            op: Op.pool.loan_repayment,
            value: controllerData.borrowedAmount,
            success: true
        });
        assertLog(res.transactions, pool.address, 2, {
            lender: controller.address,
            amount: curLoan.borrowed,
            profit: curLoan.interestAmount
        });
        await assertRound(res.transactions,
                    1,
                    [],
                    [],
                    curLoan.borrowed,
                    controllerData.borrowedAmount,
                    controllerData.borrowedAmount,
                    dataBefore.supply,
                    dataBefore.totalBalance,
                    null,
                    null)


        expect(await pool.getLoan(0, validator.wallet.address, true)).toEqual({
            borrowed: 0n,
            interestAmount: 0n
        });
    });
    it('Simple withdraw', async() => {
        const poolBefore  = await pool.getFullData();
        let withdrawals: MintChunk[] = [];
        let totalCount = 0;
        for( let i = 0; i < depositors.length; i++) {
            const sender = bc.sender(depositors[i].address);
            const jettonWallet = bc.openContract(DAOWallet.createFromAddress(
                await poolJetton.getWalletAddress(depositors[i].address)
            ));

            const withdrawCount = getRandomInt(1, 3);
            for(let k = 0; k < withdrawCount; k++) {
                const amount = getRandomTon(10000, 50000);
                const idx    = totalCount + k;
                withdrawals.push(await assertWithdraw(sender, amount, idx, idx == 0));
            }
            totalCount += withdrawCount;
        }
        const poolData    = await pool.getFullData();
        await nextRound();
        const res = await pool.sendTouch(deployer.getSender());
        await assertRound(res.transactions,
                          1,
                          [],
                          withdrawals,
                          0n,
                          0n,
                          0n,
                          poolBefore.supply,
                          poolBefore.totalBalance,
                          poolData.depositPayout,
                          poolData.withdrawalPayout);
    });
    });
    describe('Optimistic', () => {
        let depoAddresses: Address[];
        let assertOptimisticDeposit:(via:Sender, amount:bigint, expected_profit:bigint) => Promise<bigint>;
        let assertOptimisticWithdraw:(via: Sender, amount: bigint, immediate:boolean, fill_or_kill: boolean) => Promise<bigint>;
        beforeAll(async () => {
            await loadSnapshot('deployed');
            assertOptimisticDeposit = async (via, amount, expected_profit) => {
                const poolBefore = await pool.getFullData();
                const res = await pool.sendDeposit(via, amount)
                const balanceAfter = poolBefore.totalBalance + expected_profit;
                const expectedBalance = balanceAfter > 0n ? balanceAfter : 0n;
                const mintAmount      = muldivExtra(amount - Conf.poolDepositFee, poolBefore.supply, expectedBalance);
                const walletSmc = await bc.getContract(
                    await poolJetton.getWalletAddress(via.address!)
                );
                // Should not deploy anything
                expect(res.transactions).not.toHaveTransaction({
                    from: pool.address,
                    deploy: true
                });
                await assertPoolJettonMint(res.transactions, mintAmount, via.address!);

                const poolAfter = await pool.getFullData();
                // Minters if any, should not change
                expect(poolAfter.depositPayout).toEqual(poolBefore.depositPayout);
                expect(poolAfter.withdrawalPayout).toEqual(poolAfter.withdrawalPayout);

                return mintAmount;
            }
            // Start fresh round
            await nextRound();
            pool.sendTouch(deployer.getSender());
            controller.sendUpdateHash(validator.wallet.getSender());
        });
        it('Should set optimistic', async () => {
            const poolBefore = await pool.getFullData();
            expect(poolBefore.optimisticDepositWithdrawals).toBe(false);
            const res = await pool.sendDepositSettings(deployer.getSender(), true, true);
            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: pool.address,
                success: true
            });
            expect((await pool.getFullData()).optimisticDepositWithdrawals).toBe(true);
            snapStates.set('optimistic', bc.snapshot());
        });
        it('Optimistic deposit', async () => {
            depoAddresses = [];
            let   expBalances: bigint[] = [];
            await pool.sendDonate(deployer.getSender(), Conf.finalizeRoundFee);
            let deposited = 0n;
            let i = 0;
            while(deposited < Conf.minStake * 3n) {
                const depoCount  = getRandomInt(1, 3);
                const depositor  = await bc.treasury(`Depo:${i}`);
                for(let k = 0; k < depoCount; k++) {
                    const depo       = k == 0 ? getRandomTon(150000, 200000) : getRandomTon(10000, 20000);
                    depoAddresses.push(depositor.address);
                    const mintAmount = await assertOptimisticDeposit(depositor.getSender(),
                                                                     depo,
                                                                     - Conf.finalizeRoundFee);
                    deposited += depo;
                    if(k == 0) {
                        expBalances.push(mintAmount);
                    }
                    else {
                        expBalances[i] += mintAmount;
                    }
                }
                i++;
            }
            for(i = 0; i < expBalances.length; i++) {
                expect(expBalances[i]).toEqual(await getUserJettonBalance(depoAddresses[i]));
            }
        });
    });
    describe.skip('Attacks', () => {
    it('Should not faiil on total balance = 0 and supply > 0', async() => {
        await loadSnapshot('initial');
        const depositor = await bc.treasury('Depo');
        await pool.sendDonate(deployer.getSender(), Conf.finalizeRoundFee);
        const depoRes   = await assertDeposit(depositor.getSender(), Conf.poolDepositFee + 1n, 0, true);
        let poolData  = await pool.getFullData();
        expect(poolData.totalBalance).toEqual(Conf.finalizeRoundFee);
        expect(poolData.requestedForDeposit).toEqual(1n);
        await nextRound();
        await pool.sendTouch(deployer.getSender());
        // Now creditated
        poolData = await pool.getFullData();
        expect(poolData.totalBalance).toEqual(1n);
        expect(poolData.supply).toEqual(1n);
        // Next rotation we would have supply = 1 and balance 0
        // That might trigger division by zero error
        // To trigger pTON distribution we need to deposit some more

        await assertDeposit(depositor.getSender(), Conf.poolDepositFee + 1n, 0, true);
        await nextRound();
        const res = await pool.sendTouch(deployer.getSender());
        expect(res.transactions).not.toHaveTransaction({
            exitCode: 4,
            success: false
        });
    });
    it('Donate DoS', async () => {
        await loadSnapshot('initial');
        const user1  = await bc.treasury('user1');
        const sneaky = await bc.treasury('sneaky');
        // const depo1 = await assertDeposit(user1.getSender(), toNano('100000'), 0, true);
        const amount = toNano('1000');
        const depo1 = await assertDeposit(user1.getSender(), amount, 0, true);
        await pool.sendDonate(deployer.getSender(), Conf.finalizeRoundFee);
        const userJetton = bc.openContract(DAOWallet.createFromAddress(await poolJetton.getWalletAddress(user1.address)));
        // Sneaky doesn't want user to get money so sends some more money after the legit donation
        await pool.sendDonate(sneaky.getSender(), toNano('0.01'));
        const poolData = await pool.getFullData();
        await nextRound();
        // Updating round
        const res = await pool.sendTouch(deployer.getSender());
        const ptonBalance = await userJetton.getJettonBalance();
        // Should never mint 0 pool jettons
        expect(res.transactions).not.toHaveTransaction({
            to: poolJetton.address,
            op: Op.payout.mint,
            body: (x) => testMintMsg(x!, {
                amount: 0n
            })
        });
        // User should get his pTONs
        expect(ptonBalance).toBeGreaterThan(0n);
    });
    });
});
