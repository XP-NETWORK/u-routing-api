import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { Currency, CurrencyAmount, Token } from '@uniswap/sdk-core';
export declare const getBalance: (alice: SignerWithAddress, currency: Currency) => Promise<CurrencyAmount<Currency>>;
export declare const getBalanceOfAddress: (alice: SignerWithAddress, address: string, currency: Token) => Promise<CurrencyAmount<Token>>;
export declare const getBalanceAndApprove: (alice: SignerWithAddress, approveTarget: string, currency: Currency) => Promise<CurrencyAmount<Currency>>;
