import { ChainId, Currency, CurrencyAmount, Percent } from '@uniswap/sdk-core';
import { AlphaRouterConfig, CacheMode, ProtocolPoolSelection } from '@uniswap/smart-order-router';
import { FeeOptions } from '@uniswap/v3-sdk';
import { FlatFeeOptions } from '@uniswap/universal-router-sdk';
export declare const SECONDS_PER_BLOCK_BY_CHAIN_ID: {
    [chainId in ChainId]?: number;
};
export declare const DEFAULT_ROUTING_CONFIG_BY_CHAIN: (chainId: ChainId) => AlphaRouterConfig;
export type QuoteSpeedConfig = {
    v2PoolSelection?: ProtocolPoolSelection;
    v3PoolSelection?: ProtocolPoolSelection;
    maxSwapsPerPath?: number;
    maxSplits?: number;
    distributionPercent?: number;
    writeToCachedRoutes?: boolean;
};
export declare const QUOTE_SPEED_CONFIG: {
    [key: string]: QuoteSpeedConfig;
};
export type IntentSpecificConfig = {
    useCachedRoutes?: boolean;
    overwriteCacheMode?: CacheMode;
    optimisticCachedRoutes?: boolean;
};
export declare const INTENT_SPECIFIC_CONFIG: {
    [key: string]: IntentSpecificConfig;
};
export type FeeOnTransferSpecificConfig = {
    enableFeeOnTransferFeeFetching?: boolean;
};
export declare const FEE_ON_TRANSFER_SPECIFIC_CONFIG: (enableFeeOnTransferFeeFetching?: boolean) => FeeOnTransferSpecificConfig;
export declare function parseSlippageTolerance(slippageTolerance: string): Percent;
export declare function parseDeadline(deadline: string): number;
export declare function parsePortionPercent(portionBips: number): Percent;
export declare function parseFeeOptions(portionBips?: number, portionRecipient?: string): FeeOptions | undefined;
export declare function parseFlatFeeOptions(portionAmount?: string, portionRecipient?: string): FlatFeeOptions | undefined;
export type AllFeeOptions = {
    fee?: FeeOptions;
    flatFee?: FlatFeeOptions;
};
export declare function populateFeeOptions(type: string, portionBips?: number, portionRecipient?: string, portionAmount?: string): AllFeeOptions | undefined;
export declare function computePortionAmount(currencyOut: CurrencyAmount<Currency>, portionBips?: number): string | undefined;
export declare const DEFAULT_DEADLINE = 600;
export declare const UNISWAP_DOT_ETH_ADDRESS = "0x1a9C8182C09F50C8318d769245beA52c32BE35BC";
