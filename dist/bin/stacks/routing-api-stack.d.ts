import * as cdk from 'aws-cdk-lib';
import { ChainId } from '@uniswap/sdk-core';
import { CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
export declare const CHAINS_NOT_MONITORED: ChainId[];
export declare class RoutingAPIStack extends cdk.Stack {
    readonly url: CfnOutput;
    constructor(parent: Construct, name: string, props: cdk.StackProps & {
        jsonRpcProviders: {
            [chainName: string]: string;
        };
        provisionedConcurrency: number;
        throttlingOverride?: string;
        ethGasStationInfoUrl: string;
        chatbotSNSArn?: string;
        stage: string;
        internalApiKey?: string;
        route53Arn?: string;
        pinata_key?: string;
        pinata_secret?: string;
        hosted_zone?: string;
        tenderlyUser: string;
        tenderlyProject: string;
        tenderlyAccessKey: string;
        unicornSecret: string;
    });
}
