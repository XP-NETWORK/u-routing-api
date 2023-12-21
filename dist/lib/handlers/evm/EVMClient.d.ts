import { ethers } from 'ethers';
export interface EVMClient {
    getProvider(): ethers.providers.StaticJsonRpcProvider;
}
export type EVMClientProps = {
    allProviders: Array<ethers.providers.StaticJsonRpcProvider>;
};
export declare class DefaultEVMClient implements EVMClient {
    private readonly allProviders;
    constructor({ allProviders }: EVMClientProps);
    getProvider(): ethers.providers.StaticJsonRpcProvider;
}
