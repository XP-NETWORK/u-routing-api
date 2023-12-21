import { CachedRoutes, CacheMode, IRouteCachingProvider } from '@uniswap/smart-order-router';
import { ChainId, Currency, CurrencyAmount, Token, TradeType } from '@uniswap/sdk-core';
import { Protocol } from '@uniswap/router-sdk';
interface ConstructorParams {
    /**
     * The TableName for the DynamoDB Table that stores routes
     */
    routesTableName: string;
    /**
     * The TableName for the DynamoDB Table that stores whether a request has been sent for caching related to routesDb
     */
    routesCachingRequestFlagTableName: string;
    /**
     * The Lambda Function Name for the Lambda that will be invoked to fill the cache
     */
    cachingQuoteLambdaName: string;
}
export declare class DynamoRouteCachingProvider extends IRouteCachingProvider {
    private readonly ddbClient;
    private readonly lambdaClient;
    private readonly routesTableName;
    private readonly routesCachingRequestFlagTableName;
    private readonly cachingQuoteLambdaName;
    private readonly DEFAULT_CACHEMODE_ROUTES_DB;
    private readonly ROUTES_DB_TTL;
    private readonly ROUTES_DB_FLAG_TTL;
    private readonly DEFAULT_BLOCKS_TO_LIVE_ROUTES_DB;
    private readonly ROUTES_DB_BUCKET_RATIO;
    private readonly ROUTES_TO_TAKE_FROM_ROUTES_DB;
    private readonly BLOCKS_DIFF_BETWEEN_CACHING_QUOTES;
    private readonly DEFAULT_BLOCKS_DIFF_CACHING;
    constructor({ routesTableName, routesCachingRequestFlagTableName, cachingQuoteLambdaName }: ConstructorParams);
    /**
     * Implementation of the abstract method defined in `IRouteCachingProvider`
     * Given a CachedRoutesStrategy (from CACHED_ROUTES_CONFIGURATION),
     * we will find the BlocksToLive associated to the bucket.
     *
     * @param cachedRoutes
     * @param _
     * @protected
     */
    protected _getBlocksToLive(cachedRoutes: CachedRoutes, _: CurrencyAmount<Currency>): Promise<number>;
    /**
     * Implementation of the abstract method defined in `IRouteCachingProvider`
     * Fetch the most recent entry from the DynamoDB table for that pair, tradeType, chainId, protocols and bucket
     *
     * @param chainId
     * @param amount
     * @param quoteToken
     * @param tradeType
     * @param _protocols
     * @protected
     */
    protected _getCachedRoute(chainId: ChainId, amount: CurrencyAmount<Currency>, quoteToken: Token, tradeType: TradeType, protocols: Protocol[], currentBlockNumber: number, optimistic: boolean): Promise<CachedRoutes | undefined>;
    private parseCachedRoutes;
    private maybeSendCachingQuoteForRoutesDb;
    private sendAsyncCachingRequest;
    private setRoutesDbCachingIntentFlag;
    /**
     * Implementation of the abstract method defined in `IRouteCachingProvider`
     * Attempts to insert the `CachedRoutes` object into cache, if the CachingStrategy returns the CachingParameters
     *
     * @param cachedRoutes
     * @protected
     */
    protected _setCachedRoute(cachedRoutes: CachedRoutes): Promise<boolean>;
    /**
     * Implementation of the abstract method defined in `IRouteCachingProvider`
     * Obtains the CacheMode from the CachingStrategy, if not found, then return Darkmode.
     *
     * @param _chainId
     * @param _amount
     * @param _quoteToken
     * @param _tradeType
     * @param _protocols
     */
    getCacheMode(_chainId: ChainId, _amount: CurrencyAmount<Currency>, _quoteToken: Token, _tradeType: TradeType, _protocols: Protocol[]): Promise<CacheMode>;
    /**
     * RoutesDB self-correcting mechanism allows us to look at routes that would have been considered expired
     * We override this method to increase our cache coverage.
     *
     * @param cachedRoutes
     * @param _blockNumber
     * @param _optimistic
     * @protected
     */
    protected filterExpiredCachedRoutes(cachedRoutes: CachedRoutes | undefined, _blockNumber: number, _optimistic: boolean): CachedRoutes | undefined;
    /**
     * Helper function to determine the tokenIn and tokenOut given the tradeType, quoteToken and amount.currency
     *
     * @param amount
     * @param quoteToken
     * @param tradeType
     * @private
     */
    private determineTokenInOut;
}
export {};
