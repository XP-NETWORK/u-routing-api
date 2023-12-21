import { Currency, CurrencyAmount, Percent } from '@uniswap/sdk-core';
export declare const minimumAmountOut: (slippageTolerance: Percent, amountOut: CurrencyAmount<Currency>) => CurrencyAmount<Currency>;
