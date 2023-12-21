import { ChainId, Currency, CurrencyAmount, TradeType } from '@uniswap/sdk-core';
import { CachedRoutesBucket } from './cached-routes-bucket';
interface CachedRoutesStrategyArgs {
    pair: string;
    tradeType: TradeType;
    chainId: ChainId;
    buckets: CachedRoutesBucket[];
}
/**
 * Models out the strategy for categorizing cached routes into buckets by amount traded
 */
export declare class CachedRoutesStrategy {
    readonly pair: string;
    readonly _tradeType: TradeType;
    readonly chainId: ChainId;
    readonly willTapcompare: boolean;
    private buckets;
    private bucketsMap;
    /**
     * @param pair
     * @param tradeType
     * @param chainId
     * @param buckets
     */
    constructor({ pair, tradeType, chainId, buckets }: CachedRoutesStrategyArgs);
    get tradeType(): string;
    readablePairTradeTypeChainId(): string;
    bucketPairs(): [number, number][];
    /**
     * Given an amount, we will search the bucket that has a cached route for that amount based on the CachedRoutesBucket array
     * @param amount
     */
    getCachingBucket(amount: CurrencyAmount<Currency>): CachedRoutesBucket | undefined;
}
export {};
