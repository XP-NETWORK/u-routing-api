import { ICache } from '@uniswap/smart-order-router/build/main/providers/cache';
import { Pair } from '@uniswap/v2-sdk';
export declare class V2DynamoCache implements ICache<{
    pair: Pair;
    block?: number;
}> {
    private readonly tableName;
    private readonly ddbClient;
    private readonly DEFAULT_TTL;
    constructor(tableName: string);
    batchGet(keys: Set<string>): Promise<Record<string, {
        pair: Pair;
        block?: number | undefined;
    } | undefined>>;
    get(key: string): Promise<{
        pair: Pair;
        block?: number;
    } | undefined>;
    has(key: string): Promise<boolean>;
    set(key: string, value: {
        pair: Pair;
        block?: number;
    }): Promise<boolean>;
}
