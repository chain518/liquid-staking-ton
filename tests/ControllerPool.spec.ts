import { Blockchain, SandboxContract, TreasuryContract, BlockchainSnapshot } from '@ton-community/sandbox';
import { Cell, toNano, fromNano, Dictionary, beginCell, internal, Message } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { Controller } from '../wrappers/Controller';
import { DAOJettonMinter, jettonContentToCell } from '../wrappers/DAOJettonMinter';
import {JettonWallet as PoolJettonWallet } from '../contracts/jetton_dao/wrappers/JettonWallet';
import {JettonWallet as DepositWallet} from '../contracts/awaited_minter/wrappers/JettonWallet';
import {JettonWallet as WithdrawalWallet} from '../contracts/awaited_minter/wrappers/JettonWallet';
import '@ton-community/test-utils';
import { compile } from '@ton-community/blueprint';

const loadConfig = (config:Cell) => {
          return config.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());
        };

const errors = {
    WRONG_SENDER: 0x9283,
    TOO_EARLY_LOAN_REQUEST: 0xfa02,
    TOO_LATE_LOAN_REQUEST: 0xfa03,
    TOO_HIGH_LOAN_REQUEST_AMOUNT: 0xfa04,
};


describe('Controller & Pool', () => {
    let pool_code: Cell;
    let controller_code: Cell;
    let payout_minter_code: Cell;
    let payout_wallet_code: Cell;

    let dao_minter_code: Cell;
    let dao_wallet_code: Cell;
    let dao_vote_keeper_code: Cell;
    let dao_voting_code: Cell;

    let blockchain: Blockchain;
    let pool: SandboxContract<Pool>;
    let controller: SandboxContract<Controller>;
    let poolJetton: SandboxContract<DAOJettonMinter>;
    let deployer: SandboxContract<TreasuryContract>;
    let notDeployer: SandboxContract<TreasuryContract>;

    beforeAll(async () => {
        pool_code = await compile('Pool');
        controller_code = await compile('Controller');
        payout_minter_code = await compile('PayoutMinter');
        payout_wallet_code = await compile('PayoutWallet');

        dao_minter_code = await compile('DAOJettonMinter');
        dao_wallet_code = await compile('DAOJettonWallet');
        dao_vote_keeper_code = await compile('DAOVoteKeeper');
        dao_voting_code = await compile('DAOVoting');

        blockchain = await Blockchain.create();
        blockchain.now = 100

        deployer = await blockchain.treasury('deployer', {balance: toNano("1000000000")});
        notDeployer = await blockchain.treasury('notDeployer', {balance: toNano("1000000000")});

        const content = jettonContentToCell({type:1,uri:"https://example.com/1.json"});
        poolJetton  = blockchain.openContract(DAOJettonMinter.createFromConfig({
                                                  admin:deployer.address,
                                                  content,
                                                  wallet_code:dao_wallet_code,
                                                  voting_code:dao_voting_code,
                                                  vote_keeper_code:dao_vote_keeper_code},
                                                  dao_minter_code));
        let poolConfig = {
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
              payout_wallet_code : payout_wallet_code,
              pool_jetton_wallet_code : dao_wallet_code,
              payout_minter_code : payout_minter_code,
              vote_keeper_code : dao_vote_keeper_code,
        };

        pool = blockchain.openContract(Pool.createFromConfig(poolConfig, pool_code));
        let controllerConfig = {
          controllerId:0,
          validator: deployer.address,
          pool: pool.address,
          governor: deployer.address,
          approver: deployer.address,
          halter: deployer.address,
        };
        controller = blockchain.openContract(Controller.createFromConfig(controllerConfig, controller_code));
    });

    it('should deploy', async () => {
        // await blockchain.setVerbosityForAddress(pool.address, {blockchainLogs:true, vmLogs: 'vm_logs'});
        const poolDeployResult = await pool.sendDeploy(deployer.getSender(), toNano('11'));
        expect(poolDeployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: pool.address,
            deploy: true,
            success: true,
        });
        const poolJettonDeployResult = await poolJetton.sendDeploy(deployer.getSender(), toNano('1.05'));
        expect(poolJettonDeployResult.transactions).toHaveTransaction({
                         from: deployer.address,
                         to: poolJetton.address,
                         deploy: true,
                         success: true,
        });
        // change admin because we need to know jetton address before minting pool:
        const adminTransferResult = await poolJetton.sendChangeAdmin(deployer.getSender(), pool.address);
        expect(adminTransferResult.transactions).toHaveTransaction({
                         on: poolJetton.address,
                         success: true,
        });
    });

    it('should deploy controller', async () => {
        const controllerDeployResult = await pool.sendRequestControllerDeploy(deployer.getSender(), toNano('100000'), 0);
        expect(controllerDeployResult.transactions).toHaveTransaction({
            from: pool.address,
            to: controller.address,
            deploy: true,
            success: true,
        });
    });

    it('should process approve correctly', async () => {
        const foreignApproveResult = await controller.sendApprove(notDeployer.getSender());
        expect(foreignApproveResult.transactions).toHaveTransaction({
            from: notDeployer.address,
            to: controller.address,
            aborted: true,
            exitCode: errors.WRONG_SENDER
        });
        const approveResult = await controller.sendApprove(deployer.getSender());
        expect(approveResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: controller.address,
            success: true,
        });
    });

    let prevDepositWallet: SandboxContract<DepositWallet>;
    it('should deposit', async () => {
        //await blockchain.setVerbosityForAddress(pool.address, {blockchainLogs:true, vmLogs: 'vm_logs'});
        const depositResult = await pool.sendDeposit(deployer.getSender(), toNano('10'));
        let awaitedJettonMinter = blockchain.openContract(await pool.getDepositMinter());
        let myDepositWallet = await awaitedJettonMinter.getWalletAddress(deployer.address);
        expect(depositResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: pool.address,
            success: true,
        });
        expect(depositResult.transactions).toHaveTransaction({
            from: myDepositWallet,
            on: deployer.address,
            op: 0x7362d09c, // transfer notification
            success: true,
        });
        expect(depositResult.transactions).toHaveTransaction({
            on: awaitedJettonMinter.address,
            op: 0xf5aa8943, // init
            deploy: true,
            success: true,
        });

        const deposit2Result = await pool.sendDeposit(deployer.getSender(), toNano('10'));
        expect(deposit2Result.transactions).not.toHaveTransaction({
            on: awaitedJettonMinter.address,
            op: 0xf5aa8943, // init
        });
        expect(deposit2Result.transactions).toHaveTransaction({
            from: myDepositWallet,
            on: deployer.address,
            op: 0x7362d09c, // transfer notification
            success: true,
        });
        prevDepositWallet = blockchain.openContract(DepositWallet.createFromAddress(myDepositWallet));
    });

    it('should rotate round', async () => {
        let prevAwaitedJettonMinter = blockchain.openContract(await pool.getDepositMinter());
        //await blockchain.setVerbosityForAddress(prevAwaitedJettonMinter.address, {blockchainLogs:true, vmLogs: 'vm_logs'});

        const confDict = loadConfig(blockchain.config);
        /*
        validators_ext#12 utime_since:uint32 utime_until:uint32 
          total:(## 16) main:(## 16) { main <= total } { main >= 1 } 
          total_weight:uint64 list:(HashmapE 16 ValidatorDescr) = ValidatorSet;
        */
        confDict.set(34, beginCell().storeUint(0x12, 8).storeUint(0, 32).storeUint(0xffffffff, 32).endCell());
        blockchain.setConfig(beginCell().storeDictDirect(confDict).endCell());

        // action handles round rotation
        const depositResult = await pool.sendDeposit(deployer.getSender(), toNano('3.05'));

        let awaitedJettonMinter = blockchain.openContract(await pool.getDepositMinter());
        let myDepositWallet = await awaitedJettonMinter.getWalletAddress(deployer.address);

        expect(depositResult.transactions).toHaveTransaction({
            on: prevAwaitedJettonMinter.address,
            success: true,
        });
        expect(depositResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: pool.address,
            success: true,
        });
        expect(depositResult.transactions).toHaveTransaction({
            from: myDepositWallet,
            on: deployer.address,
            op: 0x7362d09c, // transfer notification
            success: true,
        });
        expect(depositResult.transactions).toHaveTransaction({
            on: awaitedJettonMinter.address,
            op: 0xf5aa8943, // init
            deploy: true,
            success: true,
        });
        expect(depositResult.transactions).toHaveTransaction({
            on: poolJetton.address,
            success: true,
            op:0x1674b0a0 //mint
        });
        let payoutJettonWalletAddress = await poolJetton.getWalletAddress(prevAwaitedJettonMinter.address);

        expect(depositResult.transactions).toHaveTransaction({
            on: payoutJettonWalletAddress,
            from: poolJetton.address,
            success: true,
        });
    });

    it('should pay out jettons', async () => {
        //await blockchain.setVerbosityForAddress(pool.address, {blockchainLogs:true, vmLogs: 'vm_logs'});
        const awJettonAmount = await prevDepositWallet.getJettonBalance();
        const burnResult = await prevDepositWallet.sendBurn(deployer.getSender(), toNano('1.0'), awJettonAmount, deployer.address, null);
        let myPoolJettonWalletAddress = await poolJetton.getWalletAddress(deployer.address);
        let myPoolJettonWallet = blockchain.openContract(PoolJettonWallet.createFromAddress(myPoolJettonWalletAddress));

        expect(burnResult.transactions).toHaveTransaction({
            from: myPoolJettonWallet.address,
            on: deployer.address,
            op: 0xd53276db, // excesses
            success: true,
        });
    });

    it('should withdraw', async () => {
        //await blockchain.setVerbosityForAddress(pool.address, {blockchainLogs:true, vmLogs: 'vm_logs'});
        let myPoolJettonWalletAddress = await poolJetton.getWalletAddress(deployer.address);
        let myPoolJettonWallet = blockchain.openContract(PoolJettonWallet.createFromAddress(myPoolJettonWalletAddress));
        const jettonAmount = await myPoolJettonWallet.getJettonBalance();

        const burnResult = await myPoolJettonWallet.sendBurn(deployer.getSender(), toNano('1.0'), jettonAmount, deployer.address, null);

        const withdrawalMinter = blockchain.openContract(await pool.getWithdrawalMinter());
        const myWithdrawWalletAddress = await withdrawalMinter.getWalletAddress(deployer.address);

        expect(burnResult.transactions).toHaveTransaction({
            from: myWithdrawWalletAddress,
            on: deployer.address,
            op: 0x7362d09c, // excesses
            success: true,
        });
    });

    it('should pay out tons', async () => {

        let awaitedTonMinter = blockchain.openContract(await pool.getWithdrawalMinter());
        let myWithdrawalWalletAddress = await awaitedTonMinter.getWalletAddress(deployer.address);
        let myWithdrawalWallet = blockchain.openContract(WithdrawalWallet.createFromAddress(myWithdrawalWalletAddress));

        // rotate round another time
        const confDict = loadConfig(blockchain.config);
        confDict.set(34, beginCell().storeUint(0x12, 8).storeUint(0, 32).storeUint(0xffffffef, 32).endCell());
        blockchain.setConfig(beginCell().storeDictDirect(confDict).endCell());
        //touch pool to trigger rotate
        //await blockchain.setVerbosityForAddress(pool.address, {blockchainLogs:true, vmLogs: 'vm_logs'});
        const roundRotateResult = await pool.sendDeposit(deployer.getSender(), toNano('1000000'));

        expect(roundRotateResult.transactions).toHaveTransaction({
            from: pool.address,
            on: awaitedTonMinter.address,
            op: 0x1140a64f, // start_distribution
            success: true,
        });

        const jettonAmount = await myWithdrawalWallet.getJettonBalance();
        const burnResult = await myWithdrawalWallet.sendBurn(deployer.getSender(), toNano('1.0'), jettonAmount, deployer.address, null);


        expect(burnResult.transactions).toHaveTransaction({
            //from: myWithdrawalWallet.address,
            on: deployer.address,
            op: 0xdb3b8abd, // distribution
            success: true,
        });
    });

    let hadDepositState: BlockchainSnapshot;

    it('should rotate and deposit again', async () => {
        // rotate round another time
        const confDict = loadConfig(blockchain.config);
        const timeSince = 100000;
        const timeUntil = 200000;

        confDict.set(34, beginCell().storeUint(0x12, 8).storeUint(timeSince, 32)
                     .storeUint(timeUntil, 32).endCell());
        let ds = confDict.get(15)?.beginParse();

        console.log("elected for", ds?.loadUint(32));
        console.log("start before", ds?.loadUint(32));
        console.log("end before", ds?.loadUint(32));
        console.log("stake held", ds?.loadUint(32));

        blockchain.setConfig(beginCell().storeDictDirect(confDict).endCell());

        await pool.sendDeposit(deployer.getSender(), toNano('1000000')); // megaton
        hadDepositState = blockchain.snapshot();
    });
    function buildMessage (body: Cell): Message {
        return {
                info: {
                type: 'internal',
                bounce: true,
                ihrDisabled: true,
                bounced: false,
                src: deployer.address,
                dest: controller.address,
                value: { coins: toNano('1') },
                ihrFee: 0n,
                forwardFee: 0n,
                createdAt: 0,
                createdLt: 0n
            },
            body: body
        };
    }

    it('controller should not borrow early', async () => {
        blockchain.now = 150000;
        const earlyRequest = await blockchain.sendMessage(
            buildMessage(Controller.loanRequestBody(
                toNano('1000'),
                toNano('10000'),
                1000n
            )));
        expect(earlyRequest.transactions).toHaveTransaction({
            from: deployer.address,
            on: controller.address,
            aborted: true,
            exitCode: errors.TOO_EARLY_LOAN_REQUEST,
        });
    });

    it('controller should not borrow late', async () => {
        blockchain.now = 199999;
        const earlyRequest = await blockchain.sendMessage(
            buildMessage(Controller.loanRequestBody(
                toNano('1000'),
                toNano('10000'),
                1000n
            )));
        expect(earlyRequest.transactions).toHaveTransaction({
            from: deployer.address,
            on: controller.address,
            aborted: true,
            exitCode: errors.TOO_LATE_LOAN_REQUEST,
        });
    });

    it('controller should not be able to borrow much', async () => {
        await blockchain.loadFrom(hadDepositState);
        blockchain.now = 170000;
        const receiveRequestMessageResult = await blockchain.sendMessage(
            buildMessage(Controller.loanRequestBody(
                    toNano('90000000'),
                    toNano('100000000'),
                    1000n
            )));
        expect(receiveRequestMessageResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: controller.address,
            aborted: true,
            exitCode: errors.TOO_HIGH_LOAN_REQUEST_AMOUNT,
        });
    });
    it ('controller should borrow successfully', async () => {
        await blockchain.loadFrom(hadDepositState);
        blockchain.now = 170000;

        const sendLoanRequestResult = await controller.sendLoanRequest(deployer.getSender(),
            toNano('1000'), // minLoan 1 kiloton
            toNano('10000'), // maxLoan 10 kiloton
            1000); // maxinterest 1000 / 65536 = 1.52587890625%

        expect(sendLoanRequestResult.transactions).toHaveTransaction({
             from: deployer.address,
             to: controller.address,
             success: true,
        });
        expect(sendLoanRequestResult.transactions).toHaveTransaction({
             from: controller.address,
             to: pool.address,
             success: true,
        });
        expect(sendLoanRequestResult.transactions).toHaveTransaction({
             from: pool.address,
             to: controller.address,
             success: true,
             op: 0x1690c604, // op = controller::credit
             value: (x) => {console.log(fromNano(x!)); return true},
        });
    });


    it('controller should return money to pool', async () => {

        const confDict = loadConfig(blockchain.config);
        confDict.set(34, beginCell().storeUint(0x12, 8)
                     .storeUint(200000, 32)
                     .storeUint(300000, 32).endCell());
        blockchain.setConfig(beginCell().storeDictDirect(confDict).endCell());

        //await blockchain.setVerbosityForAddress(pool.address, {blockchainLogs:true, vmLogs: 'vm_logs'});

        const controllerDeployResult = await controller.sendReturnUnusedLoan(deployer.getSender());

        expect(controllerDeployResult.transactions).toHaveTransaction({
                         from: deployer.address,
                         to: controller.address,
                         success: true,
        });
        expect(controllerDeployResult.transactions).toHaveTransaction({
                         from: controller.address,
                         to: pool.address,
                         op:0xdfdca27b,
                         success: true,
        });

    });

});
