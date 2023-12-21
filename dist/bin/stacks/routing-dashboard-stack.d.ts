import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
export declare const NAMESPACE = "Uniswap";
export type LambdaWidget = {
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    properties: {
        view: string;
        stacked: boolean;
        metrics: string[][];
        region: string;
        title: string;
        stat: string;
    };
};
export interface RoutingDashboardProps extends cdk.NestedStackProps {
    apiName: string;
    routingLambdaName: string;
    poolCacheLambdaNameArray: string[];
    ipfsPoolCacheLambdaName?: string;
}
export declare class RoutingDashboardStack extends cdk.NestedStack {
    constructor(scope: Construct, name: string, props: RoutingDashboardProps);
}
