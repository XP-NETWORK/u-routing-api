import { ethers } from 'ethers';
import { Deferrable } from '@ethersproject/properties';
import { TransactionRequest } from '@ethersproject/providers';
import { Block, BlockTag, BlockWithTransactions, Filter, Log, TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider';
import { BigNumber, BigNumberish } from '@ethersproject/bignumber';
import { Network, Networkish } from '@ethersproject/networks';
import { ConnectionInfo } from '@ethersproject/web';
import { ProviderName } from './ProviderName';
export type InstrumentedEVMProviderProps = {
    url?: ConnectionInfo | string;
    network?: Networkish;
    name: ProviderName;
};
export declare class InstrumentedEVMProvider extends ethers.providers.StaticJsonRpcProvider {
    private readonly name;
    private readonly metricPrefix;
    constructor({ url, network, name }: InstrumentedEVMProviderProps);
    call(transaction: Deferrable<TransactionRequest>, blockTag?: BlockTag | Promise<BlockTag>): Promise<string>;
    estimateGas(transaction: Deferrable<TransactionRequest>): Promise<BigNumber>;
    getBalance(addressOrName: string | Promise<string>, blockTag?: BlockTag | Promise<BlockTag>): Promise<BigNumber>;
    getBlock(blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>): Promise<Block>;
    getBlockNumber(): Promise<number>;
    getBlockWithTransactions(blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>): Promise<BlockWithTransactions>;
    getCode(addressOrName: string | Promise<string>, blockTag?: BlockTag | Promise<BlockTag>): Promise<string>;
    getGasPrice(): Promise<BigNumber>;
    getLogs(filter: Filter): Promise<Array<Log>>;
    getNetwork(): Promise<Network>;
    getStorageAt(addressOrName: string | Promise<string>, position: BigNumberish | Promise<BigNumberish>, blockTag?: BlockTag | Promise<BlockTag>): Promise<string>;
    getTransaction(transactionHash: string): Promise<TransactionResponse>;
    getTransactionCount(addressOrName: string | Promise<string>, blockTag?: BlockTag | Promise<BlockTag>): Promise<number>;
    getTransactionReceipt(transactionHash: string): Promise<TransactionReceipt>;
    lookupAddress(address: string | Promise<string>): Promise<string | null>;
    resolveName(name: string | Promise<string>): Promise<string | null>;
    sendTransaction(signedTransaction: string | Promise<string>): Promise<TransactionResponse>;
    waitForTransaction(transactionHash: string, confirmations?: number, timeout?: number): Promise<TransactionReceipt>;
}
