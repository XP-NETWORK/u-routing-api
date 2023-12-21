import * as cdk from 'aws-cdk-lib';
import * as aws_dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
export interface RoutingDatabaseStackProps extends cdk.NestedStackProps {
}
export declare const DynamoDBTableProps: {
    RoutesDbTable: {
        Name: string;
        PartitionKeyName: string;
        SortKeyName: string;
    };
    RoutesDbCachingRequestFlagTable: {
        Name: string;
        PartitionKeyName: string;
        SortKeyName: string;
    };
    CacheRouteDynamoDbTable: {
        Name: string;
        PartitionKeyName: string;
        SortKeyName: string;
    };
    CachingRequestFlagDynamoDbTable: {
        Name: string;
        PartitionKeyName: string;
        SortKeyName: string;
    };
    V3PoolsDynamoDbTable: {
        Name: string;
        PartitionKeyName: string;
        SortKeyName: string;
    };
    V2PairsDynamoCache: {
        Name: string;
        PartitionKeyName: string;
        SortKeyName: string;
    };
    TokenPropertiesCachingDbTable: {
        Name: string;
        PartitionKeyName: string;
    };
    TTLAttributeName: string;
};
export declare class RoutingDatabaseStack extends cdk.NestedStack {
    readonly routesDynamoDb: aws_dynamodb.Table;
    readonly routesDbCachingRequestFlagDynamoDb: aws_dynamodb.Table;
    readonly cachedRoutesDynamoDb: aws_dynamodb.Table;
    readonly cachingRequestFlagDynamoDb: aws_dynamodb.Table;
    readonly cachedV3PoolsDynamoDb: aws_dynamodb.Table;
    readonly cachedV2PairsDynamoDb: aws_dynamodb.Table;
    readonly tokenPropertiesCachingDynamoDb: aws_dynamodb.Table;
    constructor(scope: Construct, name: string, props: RoutingDatabaseStackProps);
}
