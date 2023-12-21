import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { Currency, CurrencyAmount } from '@uniswap/sdk-core';
export declare const resetAndFundAtBlock: (alice: SignerWithAddress, blockNumber: number, currencyAmounts: CurrencyAmount<Currency>[]) => Promise<SignerWithAddress>;
