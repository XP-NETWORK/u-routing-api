import { Pool } from '@uniswap/v3-sdk';
import { FeeAmount } from '@uniswap/v3-sdk/dist/constants';
import { MarshalledToken } from './token-marshaller';
import { Protocol } from '@uniswap/router-sdk';
export interface MarshalledPool {
    protocol: Protocol;
    token0: MarshalledToken;
    token1: MarshalledToken;
    fee: FeeAmount;
    sqrtRatioX96: string;
    liquidity: string;
    tickCurrent: number;
}
export declare class PoolMarshaller {
    static marshal(pool: Pool): MarshalledPool;
    static unmarshal(marshalledPool: MarshalledPool): Pool;
}
