import { CachingTokenListProvider, ITokenListProvider, ITokenProvider } from '@uniswap/smart-order-router';
import { ChainId } from '@uniswap/sdk-core';
export declare class AWSTokenListProvider extends CachingTokenListProvider {
    static fromTokenListS3Bucket(chainId: ChainId, bucket: string, tokenListURI: string): Promise<ITokenListProvider & ITokenProvider>;
}
