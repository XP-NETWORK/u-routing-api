import { CachedRoute } from '@uniswap/smart-order-router';
import { MixedRoute, V2Route, V3Route } from '@uniswap/smart-order-router/build/main/routers';
import { MarshalledRoute } from './route-marshaller';
export interface MarshalledCachedRoute {
    route: MarshalledRoute;
    percent: number;
}
export declare class CachedRouteMarshaller {
    static marshal(cachedRoute: CachedRoute<V3Route | V2Route | MixedRoute>): MarshalledCachedRoute;
    static unmarshal(marshalledCachedRoute: MarshalledCachedRoute): CachedRoute<V3Route | V2Route | MixedRoute>;
}
