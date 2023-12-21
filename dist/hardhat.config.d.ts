export const defaultNetwork: string;
export namespace networks {
    namespace hardhat {
        const chainId: number;
        namespace forking {
            const enabled: boolean;
            const url: string;
        }
    }
}
