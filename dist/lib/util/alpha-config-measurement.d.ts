import { ChainId, Currency, CurrencyAmount } from '@uniswap/sdk-core';
import { SwapRoute } from '@uniswap/smart-order-router';
export declare const getDistribution: (distributionPercent: number) => number[];
export declare const measureDistributionPercentChangeImpact: (distributionPercentBefore: number, distributionPercentAfter: number, bestSwapRoute: SwapRoute, currencyIn: Currency, currencyOut: Currency, tradeType: string, chainId: ChainId, amount: CurrencyAmount<Currency>) => void;
