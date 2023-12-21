export declare enum FeeAmount {
    LOW = 500,
    MEDIUM = 3000,
    HIGH = 10000
}
export declare const TICK_SPACINGS: {
    [amount in FeeAmount]: number;
};
export declare const getMinTick: (tickSpacing: number) => number;
export declare const getMaxTick: (tickSpacing: number) => number;
