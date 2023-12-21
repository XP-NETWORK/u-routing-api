import { DynamoCaching, DynamoCachingProps } from '../cache-dynamo';
import { Pool } from '@uniswap/v3-sdk';
interface DynamoCachingV3PoolProps extends DynamoCachingProps {
}
export declare class DynamoCachingV3Pool extends DynamoCaching<string, number, Pool> {
    constructor({ tableName, ttlMinutes }: DynamoCachingV3PoolProps);
    get(partitionKey: string, sortKey?: number): Promise<Pool | undefined>;
    set(pool: Pool, partitionKey: string, sortKey?: number): Promise<boolean>;
}
export {};
