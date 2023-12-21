import { ChainId, TradeType } from '@uniswap/sdk-core';
import { CachedRoutes } from '@uniswap/smart-order-router';
interface PairTradeTypeChainIdArgs {
    tokenIn: string;
    tokenOut: string;
    tradeType: TradeType;
    chainId: ChainId;
}
/**
 * Class used to model the partition key of the CachedRoutes cache database and configuration.
 */
export declare class PairTradeTypeChainId {
    readonly tokenIn: string;
    readonly tokenOut: string;
    readonly tradeType: TradeType;
    readonly chainId: ChainId;
    constructor({ tokenIn, tokenOut, tradeType, chainId }: PairTradeTypeChainIdArgs);
    toString(): string;
    static fromCachedRoutes(cachedRoutes: CachedRoutes): PairTradeTypeChainId;
}
export {};
