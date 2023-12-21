export declare enum ProviderName {
    INFURA = "INFURA",
    QUIKNODE = "QUIKNODE",
    FORNO = "FORNO",
    UNKNOWN = "UNKNOWN"
}
export declare function deriveProviderName(url: string): ProviderName;
