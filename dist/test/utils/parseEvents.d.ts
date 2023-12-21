import { Currency, CurrencyAmount, Token } from '@uniswap/sdk-core';
import { providers } from 'ethers';
export declare function parseEvents(txReceipt: providers.TransactionReceipt, addressFilter?: string[]): ({
    eventFragment: import("@ethersproject/abi").EventFragment;
    name: string;
    signature: string;
    topic: string;
    args: import("@ethersproject/abi").Result;
    origin: string;
} | null)[];
export type OnChainPosition = {
    owner: string;
    tokenId: number;
    tickLower: number;
    tickUpper: number;
    liquidity: number;
    amount0: CurrencyAmount<Currency>;
    amount1: CurrencyAmount<Currency>;
    newMint: boolean;
};
export type SwapAndAddEventTestParams = {
    amount0TransferredFromAlice: CurrencyAmount<Currency>;
    amount1TransferredFromAlice: CurrencyAmount<Currency>;
    amount0SwappedInPool: CurrencyAmount<Currency>;
    amount1SwappedInPool: CurrencyAmount<Currency>;
    onChainPosition: OnChainPosition;
};
export declare function getTestParamsFromEvents(events: any[], token0: Token, token1: Token, aliceAddr: string, poolAddr: string): SwapAndAddEventTestParams;
