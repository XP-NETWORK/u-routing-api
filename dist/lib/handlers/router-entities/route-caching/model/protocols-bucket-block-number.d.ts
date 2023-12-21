import { Protocol } from '@uniswap/router-sdk';
interface ProtocolsBucketBlockNumberArgs {
    protocols: Protocol[];
    bucket: number;
    blockNumber?: number;
}
/**
 * Class used to model the sort key of the CachedRoutes cache database.
 */
export declare class ProtocolsBucketBlockNumber {
    readonly protocols: Protocol[];
    readonly bucket: number;
    readonly blockNumber?: number;
    constructor({ protocols, bucket, blockNumber }: ProtocolsBucketBlockNumberArgs);
    fullKey(): string;
    protocolsBucketPartialKey(): string;
}
export {};
