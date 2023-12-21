import { IV3PoolProvider, V3PoolAccessor } from '@uniswap/smart-order-router';
import { ChainId, Token } from '@uniswap/sdk-core';
import { ProviderConfig } from '@uniswap/smart-order-router/build/main/providers/provider';
import { FeeAmount } from '@uniswap/v3-sdk';
export declare class DynamoDBCachingV3PoolProvider implements IV3PoolProvider {
    protected chainId: ChainId;
    protected poolProvider: IV3PoolProvider;
    private readonly dynamoCache;
    private readonly POOL_CACHE_KEY;
    constructor(chainId: ChainId, poolProvider: IV3PoolProvider, tableName: string);
    getPoolAddress(tokenA: Token, tokenB: Token, feeAmount: FeeAmount): {
        poolAddress: string;
        token0: Token;
        token1: Token;
    };
    getPools(tokenPairs: [Token, Token, FeeAmount][], providerConfig?: ProviderConfig): Promise<V3PoolAccessor>;
}
