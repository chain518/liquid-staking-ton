import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano, TupleBuilder, Dictionary, DictionaryValue } from 'ton-core';

import { JettonMinter as AwaitedJettonMinter} from '../contracts/awaited_minter/wrappers/JettonMinter';

import { Conf, Op } from "../PoolConstants";

export type PoolConfig = {
  pool_jetton: Address;
  pool_jetton_supply: bigint;
  optimistic_deposit_withdrawals: bigint;
  
  sudoer: Address;
  governor: Address;
  interest_manager: Address;
  halter: Address;
  consigliere: Address;
  approver: Address;
  
  controller_code: Cell;
  payout_wallet_code?: Cell;
  pool_jetton_wallet_code: Cell;
  payout_minter_code: Cell;
  vote_keeper_code: Cell;
};

export function poolConfigToCell(config: PoolConfig): Cell {
    let emptyRoundData = beginCell()
                             .storeUint(0, 1) // empty dict
                             .storeUint(0, 32) // round_id
                             .storeUint(0, 32) // active borrowers
                             .storeCoins(0) // borrowed
                             .storeCoins(0) // expected
                             .storeCoins(0) // returned
                             .storeUint(0, 1) // profit sign
                             .storeCoins(0) // profit
                         .endCell();

    let mintersData = beginCell()
                          .storeAddress(config.pool_jetton)
                          .storeCoins(config.pool_jetton_supply)
                          .storeUint(0, 1) // no deposit_minter
                          .storeUint(0, 1) // no withdrawal_minter
                      .endCell();
    let roles = beginCell()
                   .storeAddress(config.sudoer)
                   .storeUint(0, 48) // sudoer set at
                   .storeAddress(config.governor)
                   .storeUint(0xffffffffffff, 48) // givernor update after
                   .storeAddress(config.interest_manager)
                   .storeRef(
                       beginCell()
                         .storeAddress(config.halter)
                         .storeAddress(config.approver)
                       .endCell()
                   )
                .endCell();
    let codes = beginCell()
                    .storeRef(config.controller_code)
                    .storeRef(config.pool_jetton_wallet_code)
                    .storeRef(config.payout_minter_code)
                .endCell();
    return beginCell()
              .storeUint(0, 8) // state NORMAL
              .storeInt(0n, 1) // halted?
              .storeCoins(0) // total_balance
              .storeUint(100, 16) // minimal interest_rate
              .storeInt(config.optimistic_deposit_withdrawals, 1) // optimistic_deposit_withdrawals
              .storeInt(-1n, 1) // deposits_open?
              .storeUint(0, 256) // saved_validator_set_hash
              .storeRef(
                beginCell()
                  .storeRef(emptyRoundData)
                  .storeRef(emptyRoundData)
                .endCell()
              )
              .storeCoins(100 * 1000000000) // min_loan_per_validator
              .storeCoins(1000000 * 1000000000) // max_loan_per_validator
              .storeUint(655, 16) // governance fee
              .storeRef(mintersData)
              .storeRef(roles)
              .storeRef(codes)
           .endCell();
}

export type BorrowerDiscription = {
    borrowed: bigint,
    accounted_interest: bigint
}

export const BorrowerDiscriptionValue: DictionaryValue<BorrowerDiscription> = {
	serialize: (src, builder) => {
        builder.storeCoins(src.borrowed);
        builder.storeCoins(src.accounted_interest);
	},
	parse: (src) => {
        return {
            borrowed: src.loadCoins(),
            accounted_interest: src.loadCoins()
        }
	}
}

export class Pool implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Pool(address);
    }

    static createFromConfig(config: PoolConfig, code: Cell, workchain = 0) {
        const data = poolConfigToCell(config);
        const init = { code, data };
        return new Pool(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
            //TODO make proper init message
                     .storeUint(Op.pool.touch, 32) // op = touch
                     .storeUint(0, 64) // query id
                  .endCell(),
        });
    }

    async sendRequestControllerDeploy(provider: ContractProvider, via: Sender, value: bigint, controllerId: number) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                     .storeUint(Op.pool.deploy_controller, 32) // op = pool::deploy_controller
                     .storeUint(0, 64) // query id
                     .storeUint(controllerId, 32) // controller_id
                  .endCell(),
        });
    }

    async sendDeposit(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                     .storeUint(Op.pool.deposit, 32) // op = pool::deposit
                     .storeUint(1, 64) // query id
                  .endCell(),
        });
   }
    async sendSetDepositSettings(provider: ContractProvider, via: Sender, value: bigint, optimistic: Boolean, depositOpen: Boolean) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                     .storeUint(Op.governor.set_deposit_settings, 32) // op = setDepositSettings
                     .storeUint(1, 64) // query id
                     .storeUint(Number(optimistic), 1)
                     .storeUint(Number(depositOpen), 1)
                  .endCell(),
        });
    }

    async sendTouch(provider: ContractProvider, via: Sender) {
        await provider.internal(via, {
            value: toNano('0.1'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                     .storeUint(Op.pool.touch, 32) // op = touch
                     .storeUint(1, 64) // query id
                  .endCell(),
        });
    }


    // Get methods
    /*
    async getDepositPayout(provider: ContractProvider) {
        let res = await provider.get('get_current_round_deposit_payout', []);
        let minter = res.stack.readAddress();
        return AwaitedJettonMinter.createFromAddress(minter);
    }
    async getWithdrawalPayout(provider: ContractProvider) {
        let res = await provider.get('get_current_round_withdrawal_payout', []);
        let minter = res.stack.readAddress();
        return AwaitedJettonMinter.createFromAddress(minter);
    }
    */
    async getDepositMinter(provider: ContractProvider) {
        let res = await this.getFullData(provider);
        return AwaitedJettonMinter.createFromAddress(res.depositPayout!);
    }

    async getWithdrawalMinter(provider: ContractProvider) {
        let res = await this.getFullData(provider);
        return AwaitedJettonMinter.createFromAddress(res.withdrawalPayout!);
    }
    async getFinanceData(provider: ContractProvider) {
        return await this.getFullData(provider);
    }

    async getLoan(provider: ContractProvider, controllerId: number, validator: Address, previous=false) {
        const args = new TupleBuilder();
        args.writeNumber(controllerId);
        args.writeAddress(validator);
        args.writeBoolean(previous);
        let { stack } = await provider.get('get_loan', args.build());
        return {
            borrowed: stack.readBigNumber(),
            interestAmount: stack.readBigNumber(),
        }
    }
    async getRoundId(provider: ContractProvider) {
        let res = await this.getFullData(provider);
        return res.currentRound.roundId;
    }
    async getBorrowersDict(provider: ContractProvider, previous=false) {
       let res = await this.getFullData(provider);
       let borrowers = res.currentRound.borrowers;
        if(previous) {
           borrowers = res.previousRound.borrowers;
        }
        if (borrowers == null) {
            return Dictionary.empty();
        }
        const dict = Dictionary.loadDirect(Dictionary.Keys.BigInt(256), BorrowerDiscriptionValue, borrowers.asSlice());
        return dict;
    }

    async getMinMaxLoanPerValidator(provider: ContractProvider) {
        let res = await this.getFullData(provider);
        return {min: res.minLoan, max: res.maxLoan};
    }


    async getFullData(provider: ContractProvider) {
        let { stack } = await provider.get('get_pool_full_data', []);
        let state = Number(stack.readBigNumber());
        let halted = Number(stack.readBigNumber());
        let totalBalance = stack.readBigNumber();
        let interestRate = Number(stack.readBigNumber());
        let optimisticDepositWithdrawals = Number(stack.readBigNumber());
        let depositsOpen = Number(stack.readBigNumber());
        let savedValidatorSetHash = stack.readBigNumber();

        let prv = stack.readTuple();
        let prvBorrowers = prv.readCellOpt();
        let prvRoundId = Number(prv.readBigNumber());
        let prvActiveBorrowers = prv.readBigNumber();
        let prvBorrowed = prv.readBigNumber();
        let prvExpected = prv.readBigNumber();
        let prvReturned = prv.readBigNumber();
        let prvProfit = prv.readBigNumber();
        let previousRound = {
          borrowers: prvBorrowers,
          roundId: prvRoundId,
          activeBorrowers: prvActiveBorrowers,
          borrowed: prvBorrowed,
          expected: prvExpected,
          returned: prvReturned,
          profit: prvProfit
        };

        let cur = stack.readTuple();
        let curBorrowers = cur.readCellOpt();
        let curRoundId = Number(cur.readBigNumber());
        let curActiveBorrowers = cur.readBigNumber();
        let curBorrowed = cur.readBigNumber();
        let curExpected = cur.readBigNumber();
        let curReturned = cur.readBigNumber();
        let curProfit = cur.readBigNumber();
        let currentRound = {
          borrowers: curBorrowers,
          roundId: curRoundId,
          activeBorrowers: curActiveBorrowers,
          borrowed: curBorrowed,
          expected: curExpected,
          returned: curReturned,
          profit: curProfit
        };

        let minLoan = stack.readBigNumber();
        let maxLoan = stack.readBigNumber();
        let governanceFee = Number(stack.readBigNumber());


        let poolJettonMinter = stack.readAddress();
        let poolJettonSupply = stack.readBigNumber();

        let depositPayout = stack.readAddressOpt();
        let requestedForDeposit = stack.readBigNumber();

        let withdrawalPayout = stack.readAddressOpt();
        let requestedForWithdrawal = stack.readBigNumber();

        let sudoer = stack.readAddress();
        let sudoerSetAt = Number(stack.readBigNumber());

        let governor = stack.readAddress();
        let interestManager = stack.readAddress();
        let halter = stack.readAddress();
        let approver = stack.readAddress();

        let controllerCode = stack.readCell();
        let jettonWalletCode = stack.readCell();
        let payoutMinterCode = stack.readCell();

        let projectedPoolSupply = stack.readBigNumber();
        let projectedTotalBalance = stack.readBigNumber();

        return {
            state, halted,
            totalBalance, interestRate,
            optimisticDepositWithdrawals, depositsOpen,
            savedValidatorSetHash,

            previousRound, currentRound,

            minLoan, maxLoan,
            governanceFee,

            poolJettonMinter, poolJettonSupply, supply:poolJettonSupply,
            depositPayout, requestedForDeposit,
            withdrawalPayout, requestedForWithdrawal,

            sudoer, sudoerSetAt,
            governor,
            interestManager,
            halter,
            approver,

            controllerCode,
            jettonWalletCode,
            payoutMinterCode,
            projectedPoolSupply,
            projectedTotalBalance
        };
    }

}
