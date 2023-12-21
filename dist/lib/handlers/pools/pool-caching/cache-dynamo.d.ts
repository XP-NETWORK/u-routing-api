import { DynamoDB } from 'aws-sdk';
export interface IDynamoCache<TPKey, TSortKey, TVal> {
    get(partitionKey: TPKey, sortKey?: TSortKey): Promise<TVal | undefined>;
    set(value: TVal, partitionKey: TPKey, sortKey?: TSortKey): Promise<boolean>;
}
export interface DynamoCachingProps {
    tableName: string;
    ttlMinutes?: number;
}
export declare abstract class DynamoCaching<TPKey, TSortKey, TVal> implements IDynamoCache<TPKey, TSortKey, TVal> {
    protected readonly ddbClient: DynamoDB.DocumentClient;
    protected readonly tableName: string;
    protected readonly ttlMinutes: number;
    protected constructor({ tableName, ttlMinutes }: DynamoCachingProps);
    abstract get(partitionKey: TPKey, sortKey?: TSortKey): Promise<TVal | undefined>;
    abstract set(value: TVal, partitionKey: TPKey, sortKey?: TSortKey): Promise<boolean>;
}
