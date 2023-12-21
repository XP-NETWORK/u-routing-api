import { CacheMode } from '@uniswap/smart-order-router';
interface CachedRoutesBucketsArgs {
    /**
     * The bucket for these parameters, this bucket is defined in total units.
     * e.g. if bucket = 1 and currency (in CachedRoutesStrategy) is WETH, then this is 1 WETH.
     */
    bucket: number;
    /**
     * For the cached route associated to this bucket, how many blocks should the cached route be valid for.
     */
    blocksToLive?: number;
    /**
     * The CacheMode associated to this bucket. Setting it to `Livemode` will enable caching the route for this bucket
     */
    cacheMode: CacheMode;
    /**
     * Defines the max number of splits allowed for a route to be cached. A value of 0 indicates that any splits are allowed
     * A value of 1 indicates that at most there can only be 1 split in the route in order to be cached.
     */
    maxSplits?: number;
    /**
     * When fetching the CachedRoutes, we could opt for using the last N routes, from the last N blocks
     * This way we would query the price for all the recent routes that have been cached as the best routes
     */
    withLastNCachedRoutes?: number;
}
export declare class CachedRoutesBucket {
    readonly bucket: number;
    readonly blocksToLive: number;
    readonly cacheMode: CacheMode;
    readonly maxSplits: number;
    readonly withLastNCachedRoutes: number;
    constructor({ bucket, blocksToLive, cacheMode, maxSplits, withLastNCachedRoutes, }: CachedRoutesBucketsArgs);
}
export {};
