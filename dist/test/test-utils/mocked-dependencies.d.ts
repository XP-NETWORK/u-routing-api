import { V3PoolProvider } from '@uniswap/smart-order-router';
import { Pool } from '@uniswap/v3-sdk';
export declare function getMockedV3PoolProvider(pools?: Pool[]): V3PoolProvider;
export declare const TEST_ROUTE_TABLE: {
    TableName: string;
    KeySchema: {
        AttributeName: string;
        KeyType: string;
    }[];
    AttributeDefinitions: {
        AttributeName: string;
        AttributeType: string;
    }[];
    ProvisionedThroughput: {
        ReadCapacityUnits: number;
        WriteCapacityUnits: number;
    };
};
