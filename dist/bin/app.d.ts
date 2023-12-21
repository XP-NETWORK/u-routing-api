import { CfnOutput, Stack, StackProps, Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import 'source-map-support/register';
export declare class RoutingAPIStage extends Stage {
    readonly url: CfnOutput;
    constructor(scope: Construct, id: string, props: StageProps & {
        jsonRpcProviders: {
            [chainName: string]: string;
        };
        provisionedConcurrency: number;
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
export declare class RoutingAPIPipeline extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps);
    private addIntegTests;
}
