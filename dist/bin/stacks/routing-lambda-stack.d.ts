import * as cdk from 'aws-cdk-lib';
import * as aws_dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
export interface RoutingLambdaStackProps extends cdk.NestedStackProps {
    poolCacheBucket: aws_s3.Bucket;
    poolCacheBucket2: aws_s3.Bucket;
    poolCacheKey: string;
    jsonRpcProviders: {
        [chainName: string]: string;
    };
    tokenListCacheBucket: aws_s3.Bucket;
    provisionedConcurrency: number;
    ethGasStationInfoUrl: string;
    tenderlyUser: string;
    tenderlyProject: string;
    tenderlyAccessKey: string;
    chatbotSNSArn?: string;
    routesDynamoDb: aws_dynamodb.Table;
    routesDbCachingRequestFlagDynamoDb: aws_dynamodb.Table;
    cachedRoutesDynamoDb: aws_dynamodb.Table;
    cachingRequestFlagDynamoDb: aws_dynamodb.Table;
    cachedV3PoolsDynamoDb: aws_dynamodb.Table;
    cachedV2PairsDynamoDb: aws_dynamodb.Table;
    tokenPropertiesCachingDynamoDb: aws_dynamodb.Table;
    unicornSecret: string;
}
export declare class RoutingLambdaStack extends cdk.NestedStack {
    readonly routingLambda: aws_lambda_nodejs.NodejsFunction;
    readonly routingLambdaAlias: aws_lambda.Alias;
    constructor(scope: Construct, name: string, props: RoutingLambdaStackProps);
}
