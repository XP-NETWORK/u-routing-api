import { Currency, Token } from '@uniswap/sdk-core';
import { ITokenListProvider, ITokenProvider } from '@uniswap/smart-order-router';
import Logger from 'bunyan';
/**
 * CurrencyLookup searches native tokens, token lists, and on chain to determine
 * the token details (called Currency by the sdk) for an inputted string.
 */
export declare class CurrencyLookup {
    private readonly tokenListProvider;
    private readonly tokenProvider;
    private readonly log;
    constructor(tokenListProvider: ITokenListProvider, tokenProvider: ITokenProvider, log: Logger);
    searchForToken(tokenRaw: string, chainId: number): Promise<Currency | undefined>;
    checkIfNativeToken: (tokenRaw: string, chainId: number) => Currency | undefined;
    checkTokenLists: (tokenRaw: string) => Promise<Token | undefined>;
    checkOnChain: (tokenRaw: string) => Promise<Token | undefined>;
}
