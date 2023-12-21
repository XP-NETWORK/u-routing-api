import { CachedRoutes } from '@uniswap/smart-order-router';
import { ChainId, TradeType } from '@uniswap/sdk-core';
import { Protocol } from '@uniswap/router-sdk';
import { MarshalledToken } from './token-marshaller';
import { MarshalledCachedRoute } from './cached-route-marshaller';
export interface MarshalledCachedRoutes {
    routes: MarshalledCachedRoute[];
    chainId: ChainId;
    tokenIn: MarshalledToken;
    tokenOut: MarshalledToken;
    protocolsCovered: Protocol[];
    blockNumber: number;
    tradeType: TradeType;
    originalAmount: string;
    blocksToLive: number;
}
export declare class CachedRoutesMarshaller {
    static marshal(cachedRoutes: CachedRoutes): MarshalledCachedRoutes;
    static unmarshal(marshalledCachedRoutes: MarshalledCachedRoutes): CachedRoutes;
}
