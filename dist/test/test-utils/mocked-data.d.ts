import { Pool } from '@uniswap/v3-sdk';
import { V3PoolAccessor } from '@uniswap/smart-order-router/build/main/providers/v3/pool-provider';
import { Currency } from '@uniswap/sdk-core';
export declare const USDC_DAI_LOW: Pool;
export declare const USDC_DAI_MEDIUM: Pool;
export declare const USDC_WETH_LOW: Pool;
export declare const WETH9_USDT_LOW: Pool;
export declare const DAI_USDT_LOW: Pool;
export declare const SUPPORTED_POOLS: Pool[];
export declare const buildMockV3PoolAccessor: (pools: Pool[]) => V3PoolAccessor;
export type Portion = {
    bips: number;
    recipient: string;
    type: string;
};
export declare const PORTION_BIPS = 12;
export declare const PORTION_RECIPIENT = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
export declare const PORTION_TYPE = "flat";
export declare const FLAT_PORTION: Portion;
export declare const GREENLIST_TOKEN_PAIRS: Array<[Currency, Currency]>;
