import { MixedRoute, V2Route, V3Route } from '@uniswap/smart-order-router/build/main/routers';
import { Protocol } from '@uniswap/router-sdk';
import { MarshalledToken } from './token-marshaller';
import { MarshalledPair } from './pair-marshaller';
import { MarshalledPool } from './pool-marshaller';
export interface MarshalledV2Route {
    protocol: Protocol;
    input: MarshalledToken;
    output: MarshalledToken;
    pairs: MarshalledPair[];
}
export interface MarshalledV3Route {
    protocol: Protocol;
    input: MarshalledToken;
    output: MarshalledToken;
    pools: MarshalledPool[];
}
export interface MarshalledMixedRoute {
    protocol: Protocol;
    input: MarshalledToken;
    output: MarshalledToken;
    pools: (MarshalledPool | MarshalledPair)[];
}
export type MarshalledRoute = MarshalledV2Route | MarshalledV3Route | MarshalledMixedRoute;
export declare class RouteMarshaller {
    static marshal(route: V3Route | V2Route | MixedRoute): MarshalledRoute;
    static unmarshal(marshalledRoute: MarshalledRoute): V3Route | V2Route | MixedRoute;
}
