import { Pair } from '@uniswap/v2-sdk';
import { MarshalledCurrencyAmount } from './currency-amount-marshaller';
import { Protocol } from '@uniswap/router-sdk';
export interface MarshalledPair {
    protocol: Protocol;
    currencyAmountA: MarshalledCurrencyAmount;
    tokenAmountB: MarshalledCurrencyAmount;
}
export declare class PairMarshaller {
    static marshal(pair: Pair): MarshalledPair;
    static unmarshal(marshalledPair: MarshalledPair): Pair;
}
