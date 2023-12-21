import * as cdk from 'aws-cdk-lib';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
export interface RoutingCachingStackProps extends cdk.NestedStackProps {
    stage: string;
    route53Arn?: string;
    pinata_key?: string;
    pinata_secret?: string;
    hosted_zone?: string;
    chatbotSNSArn?: string;
}
export declare class RoutingCachingStack extends cdk.NestedStack {
    readonly poolCacheBucket: aws_s3.Bucket;
    readonly poolCacheBucket2: aws_s3.Bucket;
    readonly poolCacheKey: string;
    readonly tokenListCacheBucket: aws_s3.Bucket;
    readonly ipfsPoolCachingLambda: aws_lambda_nodejs.NodejsFunction;
    readonly ipfsCleanPoolCachingLambda: aws_lambda_nodejs.NodejsFunction;
    readonly poolCacheLambdaNameArray: string[];
    constructor(scope: Construct, name: string, props: RoutingCachingStackProps);
}
