/*
 * https://github.com/ton-community/ton/blob/v12.3.3/src/block/fees.ts
 * Actualized to the current ton-core types
 * Currently only message related function
*/

import { Cell, Slice, Message, loadMessageRelaxed, Dictionary  } from 'ton-core';

export type MsgPrices = ReturnType<typeof configParseMsgPrices>

//
// Source: https://github.com/ton-foundation/ton/blob/ae5c0720143e231c32c3d2034cfe4e533a16d969/crypto/block/transaction.cpp#L425
//

//
// Source: https://github.com/ton-foundation/ton/blob/ae5c0720143e231c32c3d2034cfe4e533a16d969/crypto/block/transaction.cpp#L1218
//


export const configParseMsgPrices = (sc: Slice) => {

    let magic = sc.loadUint(8);

    if(magic != 0xea) {
        throw Error("Invalid message prices magic number!");
    }
    return {
        lumpPrice:sc.loadUintBig(64),
        bitPrice: sc.loadUintBig(64),
        cellPrice: sc.loadUintBig(64),
        ihrPriceFactor: sc.loadUintBig(32),
        firstFrac: sc.loadUintBig(16),
        nextFrac:  sc.loadUintBig(16)
    };
}

export const getMsgPrices = (configRaw: Cell, workchain: 0 | -1 ) => {

    const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());

    const prices = config.get(25 + workchain);

    if(prices === undefined) {
        throw Error("No prices defined in config");
    }

    return configParseMsgPrices(prices.beginParse());
}

export function computeFwdFees(msgPrices: MsgPrices, cells: bigint, bits: bigint) {
    return msgPrices.lumpPrice + (shr16ceil((msgPrices.bitPrice * bits)
         + (msgPrices.cellPrice * cells))
    );
}

//
// Source: https://github.com/ton-foundation/ton/blob/ae5c0720143e231c32c3d2034cfe4e533a16d969/crypto/block/transaction.cpp#L761
//

//
// Source: https://github.com/ton-foundation/ton/blob/ae5c0720143e231c32c3d2034cfe4e533a16d969/crypto/block/transaction.cpp#L530
//

export function computeExternalMessageFees(msgPrices: MsgPrices, cell: Cell) {

    // Collect stats
    let storageStats = collectCellStats(cell, true);

    return computeFwdFees(msgPrices, BigInt(storageStats.cells), BigInt(storageStats.bits));
}

export function computeMessageForwardFees(msgPrices: MsgPrices, msg: Message) {
    // let msg = loadMessageRelaxed(cell.beginParse());
    let storageStats: { bits: number, cells: number } = { bits: 0, cells: 0 };

    if( msg.info.type !== "internal") {
        throw Error("Helper intended for internal messages");
    }
    const defaultFwd = computeDefaultForwardFee(msgPrices);
    // If message forward fee matches default than msg cell is flat
    let   skipRef    = msg.info.forwardFee == defaultFwd;
    // Init
    if (msg.init) {
        if(msg.init.code) {
            const code = collectCellStats(msg.init.code);
            storageStats.bits += code.bits;
            storageStats.cells += code.cells;
        }
        if(msg.init.data) {
            const data = collectCellStats(msg.init.data);
            storageStats.bits += data.bits;
            storageStats.cells += data.cells;
        }
        // If message remaining fee exceeds fees fraction from  init data, than body is by ref
        const tempFees = computeFwdFees(msgPrices, BigInt(storageStats.cells), BigInt(storageStats.bits));
        const tempFrac = tempFees - ((tempFees * msgPrices.firstFrac) >> BigInt(16));
        skipRef = tempFrac == msg.info.forwardFee
    }

    // Body
    let bc = collectCellStats(msg.body, skipRef);
    storageStats.bits  += bc.bits;
    storageStats.cells += bc.cells;

    // NOTE: Extra currencies are ignored for now
    let fees = computeFwdFees(msgPrices, BigInt(storageStats.cells), BigInt(storageStats.bits));
    let res  = (fees * msgPrices.firstFrac) >> BigInt(16);
    let remaining = fees - res;
    return { fees: res, remaining };
}
export function computeDefaultForwardFee(msgPrices: MsgPrices) {
    return msgPrices.lumpPrice - ((msgPrices.lumpPrice * msgPrices.firstFrac) >> BigInt(16));
}

export function collectCellStats(cell: Cell, skipRoot: boolean = false): { bits: number, cells: number } {
    let bits  = skipRoot ? 0 : cell.bits.length;
    let cells = skipRoot ? 0 : 1;
    for (let ref of cell.refs) {
        let r = collectCellStats(ref);
        cells += r.cells;
        bits += r.bits;
    }
    return { bits, cells };
}

function shr16ceil(src: bigint) {
    let rem = src % BigInt(65536);
    let res = src >> BigInt(16);
    if (rem != BigInt(0)) {
        res += BigInt(1);
    }
    return res;
}
