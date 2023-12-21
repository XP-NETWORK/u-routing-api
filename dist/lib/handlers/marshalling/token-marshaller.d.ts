import { Token } from '@uniswap/sdk-core';
export interface MarshalledToken {
    chainId: number;
    address: string;
    decimals: number;
    symbol?: string;
    name?: string;
    buyFeeBps?: string;
    sellFeeBps?: string;
}
export declare class TokenMarshaller {
    static marshal(token: Token): MarshalledToken;
    static unmarshal(marshalledToken: MarshalledToken): Token;
}
