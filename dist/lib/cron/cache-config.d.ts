import { Protocol } from '@uniswap/router-sdk';
import { V2SubgraphProvider, V3SubgraphProvider } from '@uniswap/smart-order-router';
import { ChainId } from '@uniswap/sdk-core';
export declare const chainProtocols: ({
    protocol: Protocol;
    chainId: ChainId;
    timeout: number;
    provider: V3SubgraphProvider;
} | {
    protocol: Protocol;
    chainId: ChainId;
    timeout: number;
    provider: V2SubgraphProvider;
})[];
