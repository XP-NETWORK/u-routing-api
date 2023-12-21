import { Protocol } from '@uniswap/router-sdk';
import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { MathExpression } from 'aws-cdk-lib/aws-cloudwatch';
import * as aws_cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as aws_events from 'aws-cdk-lib/aws-events';
import * as aws_events_targets from 'aws-cdk-lib/aws-events-targets';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import * as aws_sns from 'aws-cdk-lib/aws-sns';
import * as path from 'path';
import { chainProtocols } from '../../lib/cron/cache-config';
import { STAGE } from '../../lib/util/stage';
export class RoutingCachingStack extends cdk.NestedStack {
    constructor(scope, name, props) {
        super(scope, name, props);
        this.poolCacheLambdaNameArray = [];
        const { chatbotSNSArn } = props;
        const chatBotTopic = chatbotSNSArn ? aws_sns.Topic.fromTopicArn(this, 'ChatbotTopic', chatbotSNSArn) : undefined;
        // TODO: Remove and swap to the new bucket below. Kept around for the rollout, but all requests will go to bucket 2.
        this.poolCacheBucket = new aws_s3.Bucket(this, 'PoolCacheBucket');
        this.poolCacheBucket2 = new aws_s3.Bucket(this, 'PoolCacheBucket2');
        this.poolCacheBucket2.addLifecycleRule({
            enabled: true,
            // This isn't the right fix in the long run, but it will prevent the outage that we experienced when the V2 pool
            // data expired (See https://www.notion.so/uniswaplabs/Routing-API-Mainnet-outage-V2-Subgraph-11527aab3bd540888f92b33017bf26b4 for more detail).
            // The better short-term solution is to bake resilience into the V2SubgraphProvider (https://linear.app/uniswap/issue/ROUTE-31/use-v2-v3-fallback-provider-in-routing-api),
            // instrument the pool cache lambda, and take measures to improve its success rate.
            // Note that there is a trade-off here: we may serve stale V2 pools which can result in a suboptimal routing path if the file hasn't been recently updated.
            // This stale data is preferred to no-data until we can implement the above measures.
            // For now, choose an arbitrarily large TTL (in this case, 10 years) to prevent the key from being deleted.
            expiration: cdk.Duration.days(365 * 10),
        });
        this.poolCacheKey = 'poolCache.json';
        const { stage, route53Arn, pinata_key, pinata_secret, hosted_zone } = props;
        const lambdaRole = new aws_iam.Role(this, 'RoutingLambdaRole', {
            assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                aws_iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchFullAccess'),
            ],
        });
        if (stage == STAGE.BETA || stage == STAGE.PROD) {
            lambdaRole.addToPolicy(new PolicyStatement({
                resources: [route53Arn],
                actions: ['sts:AssumeRole'],
                sid: '1',
            }));
        }
        const region = cdk.Stack.of(this).region;
        const lambdaLayerVersion = aws_lambda.LayerVersion.fromLayerVersionArn(this, 'InsightsLayerPools', `arn:aws:lambda:${region}:580247275435:layer:LambdaInsightsExtension:14`);
        // Spin up a new pool cache lambda for each config in chain X protocol
        for (let i = 0; i < chainProtocols.length; i++) {
            const { protocol, chainId, timeout } = chainProtocols[i];
            const lambda = new aws_lambda_nodejs.NodejsFunction(this, `PoolCacheLambda-ChainId${chainId}-Protocol${protocol}`, {
                role: lambdaRole,
                runtime: aws_lambda.Runtime.NODEJS_14_X,
                entry: path.join(__dirname, '../../lib/cron/cache-pools.ts'),
                handler: 'handler',
                timeout: Duration.seconds(900),
                memorySize: 1024,
                bundling: {
                    minify: true,
                    sourceMap: true,
                },
                description: `Pool Cache Lambda for Chain with ChainId ${chainId} and Protocol ${protocol}`,
                layers: [lambdaLayerVersion],
                tracing: aws_lambda.Tracing.ACTIVE,
                environment: {
                    POOL_CACHE_BUCKET: this.poolCacheBucket.bucketName,
                    POOL_CACHE_BUCKET_2: this.poolCacheBucket2.bucketName,
                    POOL_CACHE_KEY: this.poolCacheKey,
                    chainId: chainId.toString(),
                    protocol,
                    timeout: timeout.toString(),
                },
            });
            new aws_events.Rule(this, `SchedulePoolCache-ChainId${chainId}-Protocol${protocol}`, {
                schedule: aws_events.Schedule.rate(Duration.minutes(15)),
                targets: [new aws_events_targets.LambdaFunction(lambda)],
            });
            this.poolCacheBucket2.grantReadWrite(lambda);
            const lambdaAlarmErrorRate = new aws_cloudwatch.Alarm(this, `RoutingAPI-SEV4-PoolCacheToS3LambdaErrorRate-ChainId${chainId}-Protocol${protocol}`, {
                metric: new MathExpression({
                    expression: '(invocations - errors) < 1',
                    usingMetrics: {
                        invocations: lambda.metricInvocations({
                            period: Duration.minutes(60),
                            statistic: 'sum',
                        }),
                        errors: lambda.metricErrors({
                            period: Duration.minutes(60),
                            statistic: 'sum',
                        }),
                    },
                }),
                threshold: protocol === Protocol.V3 ? 50 : 85,
                evaluationPeriods: protocol === Protocol.V3 ? 12 : 144,
            });
            const lambdaThrottlesErrorRate = new aws_cloudwatch.Alarm(this, `RoutingAPI-PoolCacheToS3LambdaThrottles-ChainId${chainId}-Protocol${protocol}`, {
                metric: lambda.metricThrottles({
                    period: Duration.minutes(5),
                    statistic: 'sum',
                }),
                threshold: 5,
                evaluationPeriods: 1,
            });
            if (chatBotTopic) {
                lambdaAlarmErrorRate.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
                lambdaThrottlesErrorRate.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            }
            this.poolCacheLambdaNameArray.push(lambda.functionName);
        }
        if (stage == STAGE.BETA || stage == STAGE.PROD) {
            this.ipfsPoolCachingLambda = new aws_lambda_nodejs.NodejsFunction(this, 'IpfsPoolCacheLambda', {
                role: lambdaRole,
                runtime: aws_lambda.Runtime.NODEJS_14_X,
                entry: path.join(__dirname, '../../lib/cron/cache-pools-ipfs.ts'),
                handler: 'handler',
                timeout: Duration.seconds(900),
                memorySize: 1024,
                bundling: {
                    minify: true,
                    sourceMap: true,
                },
                description: 'IPFS Pool Cache Lambda',
                layers: [
                    aws_lambda.LayerVersion.fromLayerVersionArn(this, 'InsightsLayerPoolsIPFS', `arn:aws:lambda:${region}:580247275435:layer:LambdaInsightsExtension:14`),
                ],
                tracing: aws_lambda.Tracing.ACTIVE,
                environment: {
                    PINATA_API_KEY: pinata_key,
                    PINATA_API_SECRET: pinata_secret,
                    ROLE_ARN: route53Arn,
                    HOSTED_ZONE: hosted_zone,
                    STAGE: stage,
                    REDEPLOY: '1',
                },
            });
            new aws_events.Rule(this, 'ScheduleIpfsPoolCache', {
                schedule: aws_events.Schedule.rate(Duration.minutes(15)),
                targets: [new aws_events_targets.LambdaFunction(this.ipfsPoolCachingLambda)],
            });
            this.ipfsCleanPoolCachingLambda = new aws_lambda_nodejs.NodejsFunction(this, 'CleanIpfsPoolCacheLambda', {
                role: lambdaRole,
                runtime: aws_lambda.Runtime.NODEJS_14_X,
                entry: path.join(__dirname, '../../lib/cron/clean-pools-ipfs.ts'),
                handler: 'handler',
                timeout: Duration.seconds(900),
                memorySize: 512,
                bundling: {
                    minify: true,
                    sourceMap: true,
                },
                description: 'Clean IPFS Pool Cache Lambda',
                layers: [
                    aws_lambda.LayerVersion.fromLayerVersionArn(this, 'InsightsLayerPoolsCleanIPFS', `arn:aws:lambda:${region}:580247275435:layer:LambdaInsightsExtension:14`),
                ],
                tracing: aws_lambda.Tracing.ACTIVE,
                environment: {
                    PINATA_API_KEY: pinata_key,
                    PINATA_API_SECRET: pinata_secret,
                    STAGE: stage,
                    REDEPLOY: '1',
                },
            });
            new aws_events.Rule(this, 'ScheduleCleanIpfsPoolCache', {
                schedule: aws_events.Schedule.rate(Duration.minutes(30)),
                targets: [new aws_events_targets.LambdaFunction(this.ipfsCleanPoolCachingLambda)],
            });
        }
        if (chatBotTopic) {
            if (stage == 'beta' || stage == 'prod') {
                const lambdaIpfsAlarmErrorRate = new aws_cloudwatch.Alarm(this, 'RoutingAPI-PoolCacheToIPFSLambdaError', {
                    metric: this.ipfsPoolCachingLambda.metricErrors({
                        period: Duration.minutes(60),
                        statistic: 'sum',
                    }),
                    threshold: 13,
                    evaluationPeriods: 1,
                });
                lambdaIpfsAlarmErrorRate.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            }
        }
        this.tokenListCacheBucket = new aws_s3.Bucket(this, 'TokenListCacheBucket');
        const tokenListCachingLambda = new aws_lambda_nodejs.NodejsFunction(this, 'TokenListCacheLambda', {
            role: lambdaRole,
            runtime: aws_lambda.Runtime.NODEJS_14_X,
            entry: path.join(__dirname, '../../lib/cron/cache-token-lists.ts'),
            handler: 'handler',
            timeout: Duration.seconds(180),
            memorySize: 256,
            bundling: {
                minify: true,
                sourceMap: true,
            },
            layers: [
                aws_lambda.LayerVersion.fromLayerVersionArn(this, 'InsightsLayerTokenList', `arn:aws:lambda:${region}:580247275435:layer:LambdaInsightsExtension:14`),
            ],
            description: 'Token List Cache Lambda',
            tracing: aws_lambda.Tracing.ACTIVE,
            environment: {
                TOKEN_LIST_CACHE_BUCKET: this.tokenListCacheBucket.bucketName,
            },
        });
        this.tokenListCacheBucket.grantReadWrite(tokenListCachingLambda);
        new aws_events.Rule(this, 'ScheduleTokenListCache', {
            schedule: aws_events.Schedule.rate(Duration.minutes(15)),
            targets: [new aws_events_targets.LambdaFunction(tokenListCachingLambda)],
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGluZy1jYWNoaW5nLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vYmluL3N0YWNrcy9yb3V0aW5nLWNhY2hpbmctc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLHFCQUFxQixDQUFBO0FBQzlDLE9BQU8sS0FBSyxHQUFHLE1BQU0sYUFBYSxDQUFBO0FBQ2xDLE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxhQUFhLENBQUE7QUFDdEMsT0FBTyxLQUFLLGNBQWMsTUFBTSw0QkFBNEIsQ0FBQTtBQUM1RCxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sNEJBQTRCLENBQUE7QUFDM0QsT0FBTyxLQUFLLHNCQUFzQixNQUFNLG9DQUFvQyxDQUFBO0FBQzVFLE9BQU8sS0FBSyxVQUFVLE1BQU0sd0JBQXdCLENBQUE7QUFDcEQsT0FBTyxLQUFLLGtCQUFrQixNQUFNLGdDQUFnQyxDQUFBO0FBQ3BFLE9BQU8sS0FBSyxPQUFPLE1BQU0scUJBQXFCLENBQUE7QUFDOUMsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLHFCQUFxQixDQUFBO0FBQ3JELE9BQU8sS0FBSyxVQUFVLE1BQU0sd0JBQXdCLENBQUE7QUFDcEQsT0FBTyxLQUFLLGlCQUFpQixNQUFNLCtCQUErQixDQUFBO0FBQ2xFLE9BQU8sS0FBSyxNQUFNLE1BQU0sb0JBQW9CLENBQUE7QUFDNUMsT0FBTyxLQUFLLE9BQU8sTUFBTSxxQkFBcUIsQ0FBQTtBQUU5QyxPQUFPLEtBQUssSUFBSSxNQUFNLE1BQU0sQ0FBQTtBQUM1QixPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sNkJBQTZCLENBQUE7QUFDNUQsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLHNCQUFzQixDQUFBO0FBVzVDLE1BQU0sT0FBTyxtQkFBb0IsU0FBUSxHQUFHLENBQUMsV0FBVztJQVN0RCxZQUFZLEtBQWdCLEVBQUUsSUFBWSxFQUFFLEtBQStC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QUUscUNBQXFDLENBQUM7WUFDbEUsT0FBTyxFQUFFLFNBQVM7WUFDbEIsT0FBTyxFQUFFLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO1lBQzlCLFVBQVUsRUFBRSxHQUFHO1lBQ2YsUUFBUSxFQUFFO2dCQUNSLE1BQU0sRUFBRSxJQUFJO2dCQUNaLFNBQVMsRUFBRSxJQUFJO2FBQ2hCO1lBQ0QsTUFBTSxFQUFFO2dCQUNOLFVBQVUsQ0FBQyxZQUFZLENBQUMsbUJBQW1CLENBQ3pDLElBQUksRUFDSix3QkFBd0IsRUFDeEIsa0JBQWtCLE1BQU0sZ0RBQWdELENBQ3pFO2FBQ0Y7WUFDRCxXQUFXLEVBQUUseUJBQXlCO1lBQ3RDLE9BQU8sRUFBRSxVQUFVLENBQUMsT0FBTyxDQUFDLE1BQU07WUFDbEMsV0FBVyxFQUFFO2dCQUNYLHVCQUF1QixFQUFFLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxVQUFVO2FBQzlEO1NBQ0YsQ0FBQyxDQUFBO1FBRUYsSUFBSSxDQUFDLG9CQUFvQixDQUFDLGNBQWMsQ0FBQyxzQkFBc0IsQ0FBQyxDQUFBO1FBRWhFLElBQUksVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsd0JBQXdCLEVBQUU7WUFDbEQsUUFBUSxFQUFFLFVBQVUsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDeEQsT0FBTyxFQUFFLENBQUMsSUFBSSxrQkFBa0IsQ0FBQyxjQUFjLENBQUMsc0JBQXNCLENBQUMsQ0FBQztTQUN6RSxDQUFDLENBQUE7SUFDSixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBQcm90b2NvbCB9IGZyb20gJ0B1bmlzd2FwL3JvdXRlci1zZGsnXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInXG5pbXBvcnQgeyBEdXJhdGlvbiB9IGZyb20gJ2F3cy1jZGstbGliJ1xuaW1wb3J0ICogYXMgYXdzX2Nsb3Vkd2F0Y2ggZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3Vkd2F0Y2gnXG5pbXBvcnQgeyBNYXRoRXhwcmVzc2lvbiB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoJ1xuaW1wb3J0ICogYXMgYXdzX2Nsb3Vkd2F0Y2hfYWN0aW9ucyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWR3YXRjaC1hY3Rpb25zJ1xuaW1wb3J0ICogYXMgYXdzX2V2ZW50cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZXZlbnRzJ1xuaW1wb3J0ICogYXMgYXdzX2V2ZW50c190YXJnZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMtdGFyZ2V0cydcbmltcG9ydCAqIGFzIGF3c19pYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSdcbmltcG9ydCB7IFBvbGljeVN0YXRlbWVudCB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nXG5pbXBvcnQgKiBhcyBhd3NfbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnXG5pbXBvcnQgKiBhcyBhd3NfbGFtYmRhX25vZGVqcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLW5vZGVqcydcbmltcG9ydCAqIGFzIGF3c19zMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnXG5pbXBvcnQgKiBhcyBhd3Nfc25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMnXG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJ1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJ1xuaW1wb3J0IHsgY2hhaW5Qcm90b2NvbHMgfSBmcm9tICcuLi8uLi9saWIvY3Jvbi9jYWNoZS1jb25maWcnXG5pbXBvcnQgeyBTVEFHRSB9IGZyb20gJy4uLy4uL2xpYi91dGlsL3N0YWdlJ1xuXG5leHBvcnQgaW50ZXJmYWNlIFJvdXRpbmdDYWNoaW5nU3RhY2tQcm9wcyBleHRlbmRzIGNkay5OZXN0ZWRTdGFja1Byb3BzIHtcbiAgc3RhZ2U6IHN0cmluZ1xuICByb3V0ZTUzQXJuPzogc3RyaW5nXG4gIHBpbmF0YV9rZXk/OiBzdHJpbmdcbiAgcGluYXRhX3NlY3JldD86IHN0cmluZ1xuICBob3N0ZWRfem9uZT86IHN0cmluZ1xuICBjaGF0Ym90U05TQXJuPzogc3RyaW5nXG59XG5cbmV4cG9ydCBjbGFzcyBSb3V0aW5nQ2FjaGluZ1N0YWNrIGV4dGVuZHMgY2RrLk5lc3RlZFN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IHBvb2xDYWNoZUJ1Y2tldDogYXdzX3MzLkJ1Y2tldFxuICBwdWJsaWMgcmVhZG9ubHkgcG9vbENhY2hlQnVja2V0MjogYXdzX3MzLkJ1Y2tldFxuICBwdWJsaWMgcmVhZG9ubHkgcG9vbENhY2hlS2V5OiBzdHJpbmdcbiAgcHVibGljIHJlYWRvbmx5IHRva2VuTGlzdENhY2hlQnVja2V0OiBhd3NfczMuQnVja2V0XG4gIHB1YmxpYyByZWFkb25seSBpcGZzUG9vbENhY2hpbmdMYW1iZGE6IGF3c19sYW1iZGFfbm9kZWpzLk5vZGVqc0Z1bmN0aW9uXG4gIHB1YmxpYyByZWFkb25seSBpcGZzQ2xlYW5Qb29sQ2FjaGluZ0xhbWJkYTogYXdzX2xhbWJkYV9ub2RlanMuTm9kZWpzRnVuY3Rpb25cbiAgcHVibGljIHJlYWRvbmx5IHBvb2xDYWNoZUxhbWJkYU5hbWVBcnJheTogc3RyaW5nW10gPSBbXVxuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIG5hbWU6IHN0cmluZywgcHJvcHM6IFJvdXRpbmdDYWNoaW5nU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBuYW1lLCBwcm9wcylcblxuICAgIGNvbnN0IHsgY2hhdGJvdFNOU0FybiB9ID0gcHJvcHNcblxuICAgIGNvbnN0IGNoYXRCb3RUb3BpYyA9IGNoYXRib3RTTlNBcm4gPyBhd3Nfc25zLlRvcGljLmZyb21Ub3BpY0Fybih0aGlzLCAnQ2hhdGJvdFRvcGljJywgY2hhdGJvdFNOU0FybikgOiB1bmRlZmluZWRcblxuICAgIC8vIFRPRE86IFJlbW92ZSBhbmQgc3dhcCB0byB0aGUgbmV3IGJ1Y2tldCBiZWxvdy4gS2VwdCBhcm91bmQgZm9yIHRoZSByb2xsb3V0LCBidXQgYWxsIHJlcXVlc3RzIHdpbGwgZ28gdG8gYnVja2V0IDIuXG4gICAgdGhpcy5wb29sQ2FjaGVCdWNrZXQgPSBuZXcgYXdzX3MzLkJ1Y2tldCh0aGlzLCAnUG9vbENhY2hlQnVja2V0JylcbiAgICB0aGlzLnBvb2xDYWNoZUJ1Y2tldDIgPSBuZXcgYXdzX3MzLkJ1Y2tldCh0aGlzLCAnUG9vbENhY2hlQnVja2V0MicpXG5cbiAgICB0aGlzLnBvb2xDYWNoZUJ1Y2tldDIuYWRkTGlmZWN5Y2xlUnVsZSh7XG4gICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgLy8gVGhpcyBpc24ndCB0aGUgcmlnaHQgZml4IGluIHRoZSBsb25nIHJ1biwgYnV0IGl0IHdpbGwgcHJldmVudCB0aGUgb3V0YWdlIHRoYXQgd2UgZXhwZXJpZW5jZWQgd2hlbiB0aGUgVjIgcG9vbFxuICAgICAgLy8gZGF0YSBleHBpcmVkIChTZWUgaHR0cHM6Ly93d3cubm90aW9uLnNvL3VuaXN3YXBsYWJzL1JvdXRpbmctQVBJLU1haW5uZXQtb3V0YWdlLVYyLVN1YmdyYXBoLTExNTI3YWFiM2JkNTQwODg4ZjkyYjMzMDE3YmYyNmI0IGZvciBtb3JlIGRldGFpbCkuXG4gICAgICAvLyBUaGUgYmV0dGVyIHNob3J0LXRlcm0gc29sdXRpb24gaXMgdG8gYmFrZSByZXNpbGllbmNlIGludG8gdGhlIFYyU3ViZ3JhcGhQcm92aWRlciAoaHR0cHM6Ly9saW5lYXIuYXBwL3VuaXN3YXAvaXNzdWUvUk9VVEUtMzEvdXNlLXYyLXYzLWZhbGxiYWNrLXByb3ZpZGVyLWluLXJvdXRpbmctYXBpKSxcbiAgICAgIC8vIGluc3RydW1lbnQgdGhlIHBvb2wgY2FjaGUgbGFtYmRhLCBhbmQgdGFrZSBtZWFzdXJlcyB0byBpbXByb3ZlIGl0cyBzdWNjZXNzIHJhdGUuXG5cbiAgICAgIC8vIE5vdGUgdGhhdCB0aGVyZSBpcyBhIHRyYWRlLW9mZiBoZXJlOiB3ZSBtYXkgc2VydmUgc3RhbGUgVjIgcG9vbHMgd2hpY2ggY2FuIHJlc3VsdCBpbiBhIHN1Ym9wdGltYWwgcm91dGluZyBwYXRoIGlmIHRoZSBmaWxlIGhhc24ndCBiZWVuIHJlY2VudGx5IHVwZGF0ZWQuXG4gICAgICAvLyBUaGlzIHN0YWxlIGRhdGEgaXMgcHJlZmVycmVkIHRvIG5vLWRhdGEgdW50aWwgd2UgY2FuIGltcGxlbWVudCB0aGUgYWJvdmUgbWVhc3VyZXMuXG5cbiAgICAgIC8vIEZvciBub3csIGNob29zZSBhbiBhcmJpdHJhcmlseSBsYXJnZSBUVEwgKGluIHRoaXMgY2FzZSwgMTAgeWVhcnMpIHRvIHByZXZlbnQgdGhlIGtleSBmcm9tIGJlaW5nIGRlbGV0ZWQuXG4gICAgICBleHBpcmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cygzNjUgKiAxMCksXG4gICAgfSlcblxuICAgIHRoaXMucG9vbENhY2hlS2V5ID0gJ3Bvb2xDYWNoZS5qc29uJ1xuXG4gICAgY29uc3QgeyBzdGFnZSwgcm91dGU1M0FybiwgcGluYXRhX2tleSwgcGluYXRhX3NlY3JldCwgaG9zdGVkX3pvbmUgfSA9IHByb3BzXG5cbiAgICBjb25zdCBsYW1iZGFSb2xlID0gbmV3IGF3c19pYW0uUm9sZSh0aGlzLCAnUm91dGluZ0xhbWJkYVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBhd3NfaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2xhbWJkYS5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgYXdzX2lhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZScpLFxuICAgICAgICBhd3NfaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdDbG91ZFdhdGNoRnVsbEFjY2VzcycpLFxuICAgICAgXSxcbiAgICB9KVxuXG4gICAgaWYgKHN0YWdlID09IFNUQUdFLkJFVEEgfHwgc3RhZ2UgPT0gU1RBR0UuUFJPRCkge1xuICAgICAgbGFtYmRhUm9sZS5hZGRUb1BvbGljeShcbiAgICAgICAgbmV3IFBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgcmVzb3VyY2VzOiBbcm91dGU1M0FybiFdLFxuICAgICAgICAgIGFjdGlvbnM6IFsnc3RzOkFzc3VtZVJvbGUnXSxcbiAgICAgICAgICBzaWQ6ICcxJyxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICB9XG5cbiAgICBjb25zdCByZWdpb24gPSBjZGsuU3RhY2sub2YodGhpcykucmVnaW9uXG5cbiAgICBjb25zdCBsYW1iZGFMYXllclZlcnNpb24gPSBhd3NfbGFtYmRhLkxheWVyVmVyc2lvbi5mcm9tTGF5ZXJWZXJzaW9uQXJuKFxuICAgICAgdGhpcyxcbiAgICAgICdJbnNpZ2h0c0xheWVyUG9vbHMnLFxuICAgICAgYGFybjphd3M6bGFtYmRhOiR7cmVnaW9ufTo1ODAyNDcyNzU0MzU6bGF5ZXI6TGFtYmRhSW5zaWdodHNFeHRlbnNpb246MTRgXG4gICAgKVxuXG4gICAgLy8gU3BpbiB1cCBhIG5ldyBwb29sIGNhY2hlIGxhbWJkYSBmb3IgZWFjaCBjb25maWcgaW4gY2hhaW4gWCBwcm90b2NvbFxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgY2hhaW5Qcm90b2NvbHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IHsgcHJvdG9jb2wsIGNoYWluSWQsIHRpbWVvdXQgfSA9IGNoYWluUHJvdG9jb2xzW2ldXG4gICAgICBjb25zdCBsYW1iZGEgPSBuZXcgYXdzX2xhbWJkYV9ub2RlanMuTm9kZWpzRnVuY3Rpb24oXG4gICAgICAgIHRoaXMsXG4gICAgICAgIGBQb29sQ2FjaGVMYW1iZGEtQ2hhaW5JZCR7Y2hhaW5JZH0tUHJvdG9jb2wke3Byb3RvY29sfWAsXG4gICAgICAgIHtcbiAgICAgICAgICByb2xlOiBsYW1iZGFSb2xlLFxuICAgICAgICAgIHJ1bnRpbWU6IGF3c19sYW1iZGEuUnVudGltZS5OT0RFSlNfMTRfWCxcbiAgICAgICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL2xpYi9jcm9uL2NhY2hlLXBvb2xzLnRzJyksXG4gICAgICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoOTAwKSxcbiAgICAgICAgICBtZW1vcnlTaXplOiAxMDI0LFxuICAgICAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgICAgICBtaW5pZnk6IHRydWUsXG4gICAgICAgICAgICBzb3VyY2VNYXA6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogYFBvb2wgQ2FjaGUgTGFtYmRhIGZvciBDaGFpbiB3aXRoIENoYWluSWQgJHtjaGFpbklkfSBhbmQgUHJvdG9jb2wgJHtwcm90b2NvbH1gLFxuICAgICAgICAgIGxheWVyczogW2xhbWJkYUxheWVyVmVyc2lvbl0sXG4gICAgICAgICAgdHJhY2luZzogYXdzX2xhbWJkYS5UcmFjaW5nLkFDVElWRSxcbiAgICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgICAgUE9PTF9DQUNIRV9CVUNLRVQ6IHRoaXMucG9vbENhY2hlQnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICAgICAgICBQT09MX0NBQ0hFX0JVQ0tFVF8yOiB0aGlzLnBvb2xDYWNoZUJ1Y2tldDIuYnVja2V0TmFtZSxcbiAgICAgICAgICAgIFBPT0xfQ0FDSEVfS0VZOiB0aGlzLnBvb2xDYWNoZUtleSxcbiAgICAgICAgICAgIGNoYWluSWQ6IGNoYWluSWQudG9TdHJpbmcoKSxcbiAgICAgICAgICAgIHByb3RvY29sLFxuICAgICAgICAgICAgdGltZW91dDogdGltZW91dC50b1N0cmluZygpLFxuICAgICAgICAgIH0sXG4gICAgICAgIH1cbiAgICAgIClcbiAgICAgIG5ldyBhd3NfZXZlbnRzLlJ1bGUodGhpcywgYFNjaGVkdWxlUG9vbENhY2hlLUNoYWluSWQke2NoYWluSWR9LVByb3RvY29sJHtwcm90b2NvbH1gLCB7XG4gICAgICAgIHNjaGVkdWxlOiBhd3NfZXZlbnRzLlNjaGVkdWxlLnJhdGUoRHVyYXRpb24ubWludXRlcygxNSkpLFxuICAgICAgICB0YXJnZXRzOiBbbmV3IGF3c19ldmVudHNfdGFyZ2V0cy5MYW1iZGFGdW5jdGlvbihsYW1iZGEpXSxcbiAgICAgIH0pXG4gICAgICB0aGlzLnBvb2xDYWNoZUJ1Y2tldDIuZ3JhbnRSZWFkV3JpdGUobGFtYmRhKVxuICAgICAgY29uc3QgbGFtYmRhQWxhcm1FcnJvclJhdGUgPSBuZXcgYXdzX2Nsb3Vkd2F0Y2guQWxhcm0oXG4gICAgICAgIHRoaXMsXG4gICAgICAgIGBSb3V0aW5nQVBJLVNFVjQtUG9vbENhY2hlVG9TM0xhbWJkYUVycm9yUmF0ZS1DaGFpbklkJHtjaGFpbklkfS1Qcm90b2NvbCR7cHJvdG9jb2x9YCxcbiAgICAgICAge1xuICAgICAgICAgIG1ldHJpYzogbmV3IE1hdGhFeHByZXNzaW9uKHtcbiAgICAgICAgICAgIGV4cHJlc3Npb246ICcoaW52b2NhdGlvbnMgLSBlcnJvcnMpIDwgMScsXG4gICAgICAgICAgICB1c2luZ01ldHJpY3M6IHtcbiAgICAgICAgICAgICAgaW52b2NhdGlvbnM6IGxhbWJkYS5tZXRyaWNJbnZvY2F0aW9ucyh7XG4gICAgICAgICAgICAgICAgcGVyaW9kOiBEdXJhdGlvbi5taW51dGVzKDYwKSxcbiAgICAgICAgICAgICAgICBzdGF0aXN0aWM6ICdzdW0nLFxuICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICAgZXJyb3JzOiBsYW1iZGEubWV0cmljRXJyb3JzKHtcbiAgICAgICAgICAgICAgICBwZXJpb2Q6IER1cmF0aW9uLm1pbnV0ZXMoNjApLFxuICAgICAgICAgICAgICAgIHN0YXRpc3RpYzogJ3N1bScsXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICB0aHJlc2hvbGQ6IHByb3RvY29sID09PSBQcm90b2NvbC5WMyA/IDUwIDogODUsXG4gICAgICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IHByb3RvY29sID09PSBQcm90b2NvbC5WMyA/IDEyIDogMTQ0LFxuICAgICAgICB9XG4gICAgICApXG4gICAgICBjb25zdCBsYW1iZGFUaHJvdHRsZXNFcnJvclJhdGUgPSBuZXcgYXdzX2Nsb3Vkd2F0Y2guQWxhcm0oXG4gICAgICAgIHRoaXMsXG4gICAgICAgIGBSb3V0aW5nQVBJLVBvb2xDYWNoZVRvUzNMYW1iZGFUaHJvdHRsZXMtQ2hhaW5JZCR7Y2hhaW5JZH0tUHJvdG9jb2wke3Byb3RvY29sfWAsXG4gICAgICAgIHtcbiAgICAgICAgICBtZXRyaWM6IGxhbWJkYS5tZXRyaWNUaHJvdHRsZXMoe1xuICAgICAgICAgICAgcGVyaW9kOiBEdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgICAgICAgc3RhdGlzdGljOiAnc3VtJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICB0aHJlc2hvbGQ6IDUsXG4gICAgICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IDEsXG4gICAgICAgIH1cbiAgICAgIClcbiAgICAgIGlmIChjaGF0Qm90VG9waWMpIHtcbiAgICAgICAgbGFtYmRhQWxhcm1FcnJvclJhdGUuYWRkQWxhcm1BY3Rpb24obmV3IGF3c19jbG91ZHdhdGNoX2FjdGlvbnMuU25zQWN0aW9uKGNoYXRCb3RUb3BpYykpXG4gICAgICAgIGxhbWJkYVRocm90dGxlc0Vycm9yUmF0ZS5hZGRBbGFybUFjdGlvbihuZXcgYXdzX2Nsb3Vkd2F0Y2hfYWN0aW9ucy5TbnNBY3Rpb24oY2hhdEJvdFRvcGljKSlcbiAgICAgIH1cbiAgICAgIHRoaXMucG9vbENhY2hlTGFtYmRhTmFtZUFycmF5LnB1c2gobGFtYmRhLmZ1bmN0aW9uTmFtZSlcbiAgICB9XG5cbiAgICBpZiAoc3RhZ2UgPT0gU1RBR0UuQkVUQSB8fCBzdGFnZSA9PSBTVEFHRS5QUk9EKSB7XG4gICAgICB0aGlzLmlwZnNQb29sQ2FjaGluZ0xhbWJkYSA9IG5ldyBhd3NfbGFtYmRhX25vZGVqcy5Ob2RlanNGdW5jdGlvbih0aGlzLCAnSXBmc1Bvb2xDYWNoZUxhbWJkYScsIHtcbiAgICAgICAgcm9sZTogbGFtYmRhUm9sZSxcbiAgICAgICAgcnVudGltZTogYXdzX2xhbWJkYS5SdW50aW1lLk5PREVKU18xNF9YLFxuICAgICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uLy4uL2xpYi9jcm9uL2NhY2hlLXBvb2xzLWlwZnMudHMnKSxcbiAgICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDkwMCksXG4gICAgICAgIG1lbW9yeVNpemU6IDEwMjQsXG4gICAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgICAgbWluaWZ5OiB0cnVlLFxuICAgICAgICAgIHNvdXJjZU1hcDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgZGVzY3JpcHRpb246ICdJUEZTIFBvb2wgQ2FjaGUgTGFtYmRhJyxcbiAgICAgICAgbGF5ZXJzOiBbXG4gICAgICAgICAgYXdzX2xhbWJkYS5MYXllclZlcnNpb24uZnJvbUxheWVyVmVyc2lvbkFybihcbiAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAnSW5zaWdodHNMYXllclBvb2xzSVBGUycsXG4gICAgICAgICAgICBgYXJuOmF3czpsYW1iZGE6JHtyZWdpb259OjU4MDI0NzI3NTQzNTpsYXllcjpMYW1iZGFJbnNpZ2h0c0V4dGVuc2lvbjoxNGBcbiAgICAgICAgICApLFxuICAgICAgICBdLFxuICAgICAgICB0cmFjaW5nOiBhd3NfbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgIFBJTkFUQV9BUElfS0VZOiBwaW5hdGFfa2V5ISxcbiAgICAgICAgICBQSU5BVEFfQVBJX1NFQ1JFVDogcGluYXRhX3NlY3JldCEsXG4gICAgICAgICAgUk9MRV9BUk46IHJvdXRlNTNBcm4hLFxuICAgICAgICAgIEhPU1RFRF9aT05FOiBob3N0ZWRfem9uZSEsXG4gICAgICAgICAgU1RBR0U6IHN0YWdlLFxuICAgICAgICAgIFJFREVQTE9ZOiAnMScsXG4gICAgICAgIH0sXG4gICAgICB9KVxuXG4gICAgICBuZXcgYXdzX2V2ZW50cy5SdWxlKHRoaXMsICdTY2hlZHVsZUlwZnNQb29sQ2FjaGUnLCB7XG4gICAgICAgIHNjaGVkdWxlOiBhd3NfZXZlbnRzLlNjaGVkdWxlLnJhdGUoRHVyYXRpb24ubWludXRlcygxNSkpLFxuICAgICAgICB0YXJnZXRzOiBbbmV3IGF3c19ldmVudHNfdGFyZ2V0cy5MYW1iZGFGdW5jdGlvbih0aGlzLmlwZnNQb29sQ2FjaGluZ0xhbWJkYSldLFxuICAgICAgfSlcblxuICAgICAgdGhpcy5pcGZzQ2xlYW5Qb29sQ2FjaGluZ0xhbWJkYSA9IG5ldyBhd3NfbGFtYmRhX25vZGVqcy5Ob2RlanNGdW5jdGlvbih0aGlzLCAnQ2xlYW5JcGZzUG9vbENhY2hlTGFtYmRhJywge1xuICAgICAgICByb2xlOiBsYW1iZGFSb2xlLFxuICAgICAgICBydW50aW1lOiBhd3NfbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzE0X1gsXG4gICAgICAgIGVudHJ5OiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vLi4vbGliL2Nyb24vY2xlYW4tcG9vbHMtaXBmcy50cycpLFxuICAgICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoOTAwKSxcbiAgICAgICAgbWVtb3J5U2l6ZTogNTEyLFxuICAgICAgICBidW5kbGluZzoge1xuICAgICAgICAgIG1pbmlmeTogdHJ1ZSxcbiAgICAgICAgICBzb3VyY2VNYXA6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQ2xlYW4gSVBGUyBQb29sIENhY2hlIExhbWJkYScsXG4gICAgICAgIGxheWVyczogW1xuICAgICAgICAgIGF3c19sYW1iZGEuTGF5ZXJWZXJzaW9uLmZyb21MYXllclZlcnNpb25Bcm4oXG4gICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgJ0luc2lnaHRzTGF5ZXJQb29sc0NsZWFuSVBGUycsXG4gICAgICAgICAgICBgYXJuOmF3czpsYW1iZGE6JHtyZWdpb259OjU4MDI0NzI3NTQzNTpsYXllcjpMYW1iZGFJbnNpZ2h0c0V4dGVuc2lvbjoxNGBcbiAgICAgICAgICApLFxuICAgICAgICBdLFxuICAgICAgICB0cmFjaW5nOiBhd3NfbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAgIFBJTkFUQV9BUElfS0VZOiBwaW5hdGFfa2V5ISxcbiAgICAgICAgICBQSU5BVEFfQVBJX1NFQ1JFVDogcGluYXRhX3NlY3JldCEsXG4gICAgICAgICAgU1RBR0U6IHN0YWdlLFxuICAgICAgICAgIFJFREVQTE9ZOiAnMScsXG4gICAgICAgIH0sXG4gICAgICB9KVxuXG4gICAgICBuZXcgYXdzX2V2ZW50cy5SdWxlKHRoaXMsICdTY2hlZHVsZUNsZWFuSXBmc1Bvb2xDYWNoZScsIHtcbiAgICAgICAgc2NoZWR1bGU6IGF3c19ldmVudHMuU2NoZWR1bGUucmF0ZShEdXJhdGlvbi5taW51dGVzKDMwKSksXG4gICAgICAgIHRhcmdldHM6IFtuZXcgYXdzX2V2ZW50c190YXJnZXRzLkxhbWJkYUZ1bmN0aW9uKHRoaXMuaXBmc0NsZWFuUG9vbENhY2hpbmdMYW1iZGEpXSxcbiAgICAgIH0pXG4gICAgfVxuXG4gICAgaWYgKGNoYXRCb3RUb3BpYykge1xuICAgICAgaWYgKHN0YWdlID09ICdiZXRhJyB8fCBzdGFnZSA9PSAncHJvZCcpIHtcbiAgICAgICAgY29uc3QgbGFtYmRhSXBmc0FsYXJtRXJyb3JSYXRlID0gbmV3IGF3c19jbG91ZHdhdGNoLkFsYXJtKHRoaXMsICdSb3V0aW5nQVBJLVBvb2xDYWNoZVRvSVBGU0xhbWJkYUVycm9yJywge1xuICAgICAgICAgIG1ldHJpYzogdGhpcy5pcGZzUG9vbENhY2hpbmdMYW1iZGEubWV0cmljRXJyb3JzKHtcbiAgICAgICAgICAgIHBlcmlvZDogRHVyYXRpb24ubWludXRlcyg2MCksXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdzdW0nLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIHRocmVzaG9sZDogMTMsXG4gICAgICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IDEsXG4gICAgICAgIH0pXG5cbiAgICAgICAgbGFtYmRhSXBmc0FsYXJtRXJyb3JSYXRlLmFkZEFsYXJtQWN0aW9uKG5ldyBhd3NfY2xvdWR3YXRjaF9hY3Rpb25zLlNuc0FjdGlvbihjaGF0Qm90VG9waWMpKVxuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMudG9rZW5MaXN0Q2FjaGVCdWNrZXQgPSBuZXcgYXdzX3MzLkJ1Y2tldCh0aGlzLCAnVG9rZW5MaXN0Q2FjaGVCdWNrZXQnKVxuXG4gICAgY29uc3QgdG9rZW5MaXN0Q2FjaGluZ0xhbWJkYSA9IG5ldyBhd3NfbGFtYmRhX25vZGVqcy5Ob2RlanNGdW5jdGlvbih0aGlzLCAnVG9rZW5MaXN0Q2FjaGVMYW1iZGEnLCB7XG4gICAgICByb2xlOiBsYW1iZGFSb2xlLFxuICAgICAgcnVudGltZTogYXdzX2xhbWJkYS5SdW50aW1lLk5PREVKU18xNF9YLFxuICAgICAgZW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi8uLi9saWIvY3Jvbi9jYWNoZS10b2tlbi1saXN0cy50cycpLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgdGltZW91dDogRHVyYXRpb24uc2Vjb25kcygxODApLFxuICAgICAgbWVtb3J5U2l6ZTogMjU2LFxuICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgbWluaWZ5OiB0cnVlLFxuICAgICAgICBzb3VyY2VNYXA6IHRydWUsXG4gICAgICB9LFxuICAgICAgbGF5ZXJzOiBbXG4gICAgICAgIGF3c19sYW1iZGEuTGF5ZXJWZXJzaW9uLmZyb21MYXllclZlcnNpb25Bcm4oXG4gICAgICAgICAgdGhpcyxcbiAgICAgICAgICAnSW5zaWdodHNMYXllclRva2VuTGlzdCcsXG4gICAgICAgICAgYGFybjphd3M6bGFtYmRhOiR7cmVnaW9ufTo1ODAyNDcyNzU0MzU6bGF5ZXI6TGFtYmRhSW5zaWdodHNFeHRlbnNpb246MTRgXG4gICAgICAgICksXG4gICAgICBdLFxuICAgICAgZGVzY3JpcHRpb246ICdUb2tlbiBMaXN0IENhY2hlIExhbWJkYScsXG4gICAgICB0cmFjaW5nOiBhd3NfbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVE9LRU5fTElTVF9DQUNIRV9CVUNLRVQ6IHRoaXMudG9rZW5MaXN0Q2FjaGVCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgIH0sXG4gICAgfSlcblxuICAgIHRoaXMudG9rZW5MaXN0Q2FjaGVCdWNrZXQuZ3JhbnRSZWFkV3JpdGUodG9rZW5MaXN0Q2FjaGluZ0xhbWJkYSlcblxuICAgIG5ldyBhd3NfZXZlbnRzLlJ1bGUodGhpcywgJ1NjaGVkdWxlVG9rZW5MaXN0Q2FjaGUnLCB7XG4gICAgICBzY2hlZHVsZTogYXdzX2V2ZW50cy5TY2hlZHVsZS5yYXRlKER1cmF0aW9uLm1pbnV0ZXMoMTUpKSxcbiAgICAgIHRhcmdldHM6IFtuZXcgYXdzX2V2ZW50c190YXJnZXRzLkxhbWJkYUZ1bmN0aW9uKHRva2VuTGlzdENhY2hpbmdMYW1iZGEpXSxcbiAgICB9KVxuICB9XG59XG4iXX0=