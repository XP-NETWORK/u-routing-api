import { Protocol } from '@uniswap/router-sdk';
import { IV2SubgraphProvider, IV3SubgraphProvider, V2SubgraphPool, V3SubgraphPool } from '@uniswap/smart-order-router';
import { S3 } from 'aws-sdk';
import { ChainId } from '@uniswap/sdk-core';
export declare class AWSSubgraphProvider<TSubgraphPool extends V2SubgraphPool | V3SubgraphPool> {
    private chain;
    private protocol;
    private bucket;
    private baseKey;
    constructor(chain: ChainId, protocol: Protocol, bucket: string, baseKey: string);
    getPools(): Promise<TSubgraphPool[]>;
}
export declare const cachePoolsFromS3: <TSubgraphPool>(s3: S3, bucket: string, baseKey: string, chainId: ChainId, protocol: Protocol) => Promise<TSubgraphPool[]>;
export declare class V3AWSSubgraphProvider extends AWSSubgraphProvider<V3SubgraphPool> implements IV3SubgraphProvider {
    constructor(chainId: ChainId, bucket: string, baseKey: string);
    static EagerBuild(bucket: string, baseKey: string, chainId: ChainId): Promise<V3AWSSubgraphProvider>;
}
export declare class V2AWSSubgraphProvider extends AWSSubgraphProvider<V2SubgraphPool> implements IV2SubgraphProvider {
    constructor(chainId: ChainId, bucket: string, key: string);
    static EagerBuild(bucket: string, baseKey: string, chainId: ChainId): Promise<V2AWSSubgraphProvider>;
}
