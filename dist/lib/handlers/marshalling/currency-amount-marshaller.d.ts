import { CurrencyAmount, Token } from '@uniswap/sdk-core';
import { MarshalledToken } from './token-marshaller';
export interface MarshalledCurrencyAmount {
    currency: MarshalledToken;
    numerator: string;
    denominator: string;
}
export declare class CurrencyAmountMarshaller {
    static marshal(currencyAmount: CurrencyAmount<Token>): MarshalledCurrencyAmount;
    static unmarshal(marshalledCurrencyAmount: MarshalledCurrencyAmount): CurrencyAmount<Token>;
}
