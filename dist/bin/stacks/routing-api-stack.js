import { SUPPORTED_CHAINS } from '@uniswap/smart-order-router';
import * as cdk from 'aws-cdk-lib';
import { ChainId } from '@uniswap/sdk-core';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as aws_apigateway from 'aws-cdk-lib/aws-apigateway';
import { MethodLoggingLevel } from 'aws-cdk-lib/aws-apigateway';
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { ComparisonOperator, MathExpression } from 'aws-cdk-lib/aws-cloudwatch';
import * as aws_cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as aws_sns from 'aws-cdk-lib/aws-sns';
import * as aws_waf from 'aws-cdk-lib/aws-wafv2';
import { STAGE } from '../../lib/util/stage';
import { RoutingCachingStack } from './routing-caching-stack';
import { RoutingDashboardStack } from './routing-dashboard-stack';
import { RoutingLambdaStack } from './routing-lambda-stack';
import { RoutingDatabaseStack } from './routing-database-stack';
export const CHAINS_NOT_MONITORED = [ChainId.GOERLI, ChainId.POLYGON_MUMBAI];
export class RoutingAPIStack extends cdk.Stack {
    constructor(parent, name, props) {
        super(parent, name, props);
        const { jsonRpcProviders, provisionedConcurrency, throttlingOverride, ethGasStationInfoUrl, chatbotSNSArn, stage, internalApiKey, route53Arn, pinata_key, pinata_secret, hosted_zone, tenderlyUser, tenderlyProject, tenderlyAccessKey, unicornSecret, } = props;
        const { poolCacheBucket, poolCacheBucket2, poolCacheKey, poolCacheLambdaNameArray, tokenListCacheBucket, ipfsPoolCachingLambda, } = new RoutingCachingStack(this, 'RoutingCachingStack', {
            chatbotSNSArn,
            stage,
            route53Arn,
            pinata_key,
            pinata_secret,
            hosted_zone,
        });
        const { routesDynamoDb, routesDbCachingRequestFlagDynamoDb, cachedRoutesDynamoDb, cachingRequestFlagDynamoDb, cachedV3PoolsDynamoDb, cachedV2PairsDynamoDb, tokenPropertiesCachingDynamoDb, } = new RoutingDatabaseStack(this, 'RoutingDatabaseStack', {});
        const { routingLambda, routingLambdaAlias } = new RoutingLambdaStack(this, 'RoutingLambdaStack', {
            poolCacheBucket,
            poolCacheBucket2,
            poolCacheKey,
            jsonRpcProviders,
            tokenListCacheBucket,
            provisionedConcurrency,
            ethGasStationInfoUrl,
            chatbotSNSArn,
            tenderlyUser,
            tenderlyProject,
            tenderlyAccessKey,
            routesDynamoDb,
            routesDbCachingRequestFlagDynamoDb,
            cachedRoutesDynamoDb,
            cachingRequestFlagDynamoDb,
            cachedV3PoolsDynamoDb,
            cachedV2PairsDynamoDb,
            tokenPropertiesCachingDynamoDb,
            unicornSecret,
        });
        const accessLogGroup = new aws_logs.LogGroup(this, 'RoutingAPIGAccessLogs');
        const api = new aws_apigateway.RestApi(this, 'routing-api', {
            restApiName: 'Routing API',
            deployOptions: {
                tracingEnabled: true,
                loggingLevel: MethodLoggingLevel.ERROR,
                accessLogDestination: new aws_apigateway.LogGroupLogDestination(accessLogGroup),
                accessLogFormat: aws_apigateway.AccessLogFormat.jsonWithStandardFields({
                    ip: false,
                    caller: false,
                    user: false,
                    requestTime: true,
                    httpMethod: true,
                    resourcePath: true,
                    status: true,
                    protocol: true,
                    responseLength: true,
                }),
            },
            defaultCorsPreflightOptions: {
                allowOrigins: aws_apigateway.Cors.ALL_ORIGINS,
                allowMethods: aws_apigateway.Cors.ALL_METHODS,
            },
        });
        const ipThrottlingACL = new aws_waf.CfnWebACL(this, 'RoutingAPIIPThrottlingACL', {
            defaultAction: { allow: {} },
            scope: 'REGIONAL',
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: 'RoutingAPIIPBasedThrottling',
            },
            customResponseBodies: {
                RoutingAPIThrottledResponseBody: {
                    contentType: 'APPLICATION_JSON',
                    content: '{"errorCode": "TOO_MANY_REQUESTS"}',
                },
            },
            name: 'RoutingAPIIPThrottling',
            rules: [
                {
                    name: 'ip',
                    priority: 0,
                    statement: {
                        rateBasedStatement: {
                            // Limit is per 5 mins, i.e. 120 requests every 5 mins
                            limit: throttlingOverride ? parseInt(throttlingOverride) : 120,
                            // API is of type EDGE so is fronted by Cloudfront as a proxy.
                            // Use the ip set in X-Forwarded-For by Cloudfront, not the regular IP
                            // which would just resolve to Cloudfronts IP.
                            aggregateKeyType: 'FORWARDED_IP',
                            forwardedIpConfig: {
                                headerName: 'X-Forwarded-For',
                                fallbackBehavior: 'MATCH',
                            },
                            scopeDownStatement: {
                                notStatement: {
                                    statement: {
                                        byteMatchStatement: {
                                            fieldToMatch: {
                                                singleHeader: {
                                                    name: 'x-api-key',
                                                },
                                            },
                                            positionalConstraint: 'EXACTLY',
                                            searchString: internalApiKey,
                                            textTransformations: [
                                                {
                                                    type: 'NONE',
                                                    priority: 0,
                                                },
                                            ],
                                        },
                                    },
                                },
                            },
                        },
                    },
                    action: {
                        block: {
                            customResponse: {
                                responseCode: 429,
                                customResponseBodyKey: 'RoutingAPIThrottledResponseBody',
                            },
                        },
                    },
                    visibilityConfig: {
                        sampledRequestsEnabled: true,
                        cloudWatchMetricsEnabled: true,
                        metricName: 'RoutingAPIIPBasedThrottlingRule',
                    },
                },
            ],
        });
        const region = cdk.Stack.of(this).region;
        const apiArn = `arn:aws:apigateway:${region}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`;
        new aws_waf.CfnWebACLAssociation(this, 'RoutingAPIIPThrottlingAssociation', {
            resourceArn: apiArn,
            webAclArn: ipThrottlingACL.getAtt('Arn').toString(),
        });
        new RoutingDashboardStack(this, 'RoutingDashboardStack', {
            apiName: api.restApiName,
            routingLambdaName: routingLambda.functionName,
            poolCacheLambdaNameArray,
            ipfsPoolCacheLambdaName: ipfsPoolCachingLambda ? ipfsPoolCachingLambda.functionName : undefined,
        });
        const lambdaIntegration = new aws_apigateway.LambdaIntegration(routingLambdaAlias);
        const quote = api.root.addResource('quote', {
            defaultCorsPreflightOptions: {
                allowOrigins: aws_apigateway.Cors.ALL_ORIGINS,
                allowMethods: aws_apigateway.Cors.ALL_METHODS,
            },
        });
        quote.addMethod('GET', lambdaIntegration);
        // All alarms default to GreaterThanOrEqualToThreshold for when to be triggered.
        const apiAlarm5xxSev2 = new aws_cloudwatch.Alarm(this, 'RoutingAPI-SEV2-5XXAlarm', {
            alarmName: 'RoutingAPI-SEV2-5XX',
            metric: api.metricServerError({
                period: Duration.minutes(5),
                // For this metric 'avg' represents error rate.
                statistic: 'avg',
            }),
            threshold: 0.02,
            // Beta has much less traffic so is more susceptible to transient errors.
            evaluationPeriods: stage == STAGE.BETA ? 5 : 3,
        });
        const apiAlarm5xxSev3 = new aws_cloudwatch.Alarm(this, 'RoutingAPI-SEV3-5XXAlarm', {
            alarmName: 'RoutingAPI-SEV3-5XX',
            metric: api.metricServerError({
                period: Duration.minutes(5),
                // For this metric 'avg' represents error rate.
                statistic: 'avg',
            }),
            threshold: 0.01,
            // Beta has much less traffic so is more susceptible to transient errors.
            evaluationPeriods: stage == STAGE.BETA ? 5 : 3,
        });
        const apiAlarm4xxSev2 = new aws_cloudwatch.Alarm(this, 'RoutingAPI-SEV2-4XXAlarm', {
            alarmName: 'RoutingAPI-SEV2-4XX',
            metric: api.metricClientError({
                period: Duration.minutes(5),
                statistic: 'avg',
            }),
            threshold: 0.6,
            evaluationPeriods: 3,
        });
        const apiAlarm4xxSev3 = new aws_cloudwatch.Alarm(this, 'RoutingAPI-SEV3-4XXAlarm', {
            alarmName: 'RoutingAPI-SEV3-4XX',
            metric: api.metricClientError({
                period: Duration.minutes(5),
                statistic: 'avg',
            }),
            threshold: 0.4,
            evaluationPeriods: 3,
        });
        const apiAlarmLatencySev2 = new aws_cloudwatch.Alarm(this, 'RoutingAPI-SEV2-Latency', {
            alarmName: 'RoutingAPI-SEV2-Latency',
            metric: api.metricLatency({
                period: Duration.minutes(5),
                statistic: 'p90',
            }),
            threshold: 6500,
            evaluationPeriods: 3,
        });
        const apiAlarmLatencySev3 = new aws_cloudwatch.Alarm(this, 'RoutingAPI-SEV3-Latency', {
            alarmName: 'RoutingAPI-SEV3-Latency',
            metric: api.metricLatency({
                period: Duration.minutes(5),
                statistic: 'p90',
            }),
            threshold: 3500,
            evaluationPeriods: 3,
        });
        // Simulations can fail for valid reasons. For example, if the simulation reverts due
        // to slippage checks (can happen with FOT tokens sometimes since our quoter does not
        // account for the fees taken during transfer when we show the user the quote).
        //
        // For this reason we only alert on SEV3 to avoid unnecessary pages.
        const simulationAlarmSev3 = new aws_cloudwatch.Alarm(this, 'RoutingAPI-SEV3-Simulation', {
            alarmName: 'RoutingAPI-SEV3-Simulation',
            metric: new MathExpression({
                expression: '100*(simulationFailed/simulationRequested)',
                period: Duration.minutes(30),
                usingMetrics: {
                    simulationRequested: new aws_cloudwatch.Metric({
                        namespace: 'Uniswap',
                        metricName: `Simulation Requested`,
                        dimensionsMap: { Service: 'RoutingAPI' },
                        unit: aws_cloudwatch.Unit.COUNT,
                        statistic: 'sum',
                    }),
                    simulationFailed: new aws_cloudwatch.Metric({
                        namespace: 'Uniswap',
                        metricName: `SimulationFailed`,
                        dimensionsMap: { Service: 'RoutingAPI' },
                        unit: aws_cloudwatch.Unit.COUNT,
                        statistic: 'sum',
                    }),
                },
            }),
            threshold: 20,
            evaluationPeriods: 3,
            treatMissingData: aws_cloudwatch.TreatMissingData.NOT_BREACHING, // Missing data points are treated as "good" and within the threshold
        });
        // Alarms for high 400 error rate for each chain
        const percent4XXByChainAlarm = [];
        SUPPORTED_CHAINS.forEach((chainId) => {
            if (CHAINS_NOT_MONITORED.includes(chainId)) {
                return;
            }
            const alarmName = `RoutingAPI-SEV3-4XXAlarm-ChainId: ${chainId.toString()}`;
            const metric = new MathExpression({
                expression: '100*(response400/invocations)',
                usingMetrics: {
                    invocations: api.metric(`GET_QUOTE_REQUESTED_CHAINID: ${chainId.toString()}`, {
                        period: Duration.minutes(5),
                        statistic: 'sum',
                    }),
                    response400: api.metric(`GET_QUOTE_400_CHAINID: ${chainId.toString()}`, {
                        period: Duration.minutes(5),
                        statistic: 'sum',
                    }),
                },
            });
            const alarm = new aws_cloudwatch.Alarm(this, alarmName, {
                alarmName,
                metric,
                threshold: 80,
                evaluationPeriods: 2,
            });
            percent4XXByChainAlarm.push(alarm);
        });
        // Alarms for high 500 error rate for each chain
        const successRateByChainAlarm = [];
        SUPPORTED_CHAINS.forEach((chainId) => {
            if (CHAINS_NOT_MONITORED.includes(chainId)) {
                return;
            }
            const alarmName = `RoutingAPI-SEV2-SuccessRate-Alarm-ChainId: ${chainId.toString()}`;
            const metric = new MathExpression({
                expression: '100*(response200/(invocations-response400))',
                usingMetrics: {
                    invocations: api.metric(`GET_QUOTE_REQUESTED_CHAINID: ${chainId.toString()}`, {
                        period: Duration.minutes(5),
                        statistic: 'sum',
                    }),
                    response400: api.metric(`GET_QUOTE_400_CHAINID: ${chainId.toString()}`, {
                        period: Duration.minutes(5),
                        statistic: 'sum',
                    }),
                    response200: api.metric(`GET_QUOTE_200_CHAINID: ${chainId.toString()}`, {
                        period: Duration.minutes(5),
                        statistic: 'sum',
                    }),
                },
            });
            const alarm = new aws_cloudwatch.Alarm(this, alarmName, {
                alarmName,
                metric,
                comparisonOperator: ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
                threshold: 95,
                evaluationPeriods: 2,
            });
            successRateByChainAlarm.push(alarm);
        });
        if (chatbotSNSArn) {
            const chatBotTopic = aws_sns.Topic.fromTopicArn(this, 'ChatbotTopic', chatbotSNSArn);
            apiAlarm5xxSev2.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            apiAlarm4xxSev2.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            apiAlarmLatencySev2.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            apiAlarm5xxSev3.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            apiAlarm4xxSev3.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            apiAlarmLatencySev3.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            simulationAlarmSev3.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            percent4XXByChainAlarm.forEach((alarm) => {
                alarm.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            });
            successRateByChainAlarm.forEach((alarm) => {
                alarm.addAlarmAction(new aws_cloudwatch_actions.SnsAction(chatBotTopic));
            });
        }
        this.url = new CfnOutput(this, 'Url', {
            value: api.url,
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGluZy1hcGktc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9iaW4vc3RhY2tzL3JvdXRpbmctYXBpLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLDZCQUE2QixDQUFBO0FBQzlELE9BQU8sS0FBSyxHQUFHLE1BQU0sYUFBYSxDQUFBO0FBQ2xDLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQTtBQUMzQyxPQUFPLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxNQUFNLGFBQWEsQ0FBQTtBQUNqRCxPQUFPLEtBQUssY0FBYyxNQUFNLDRCQUE0QixDQUFBO0FBQzVELE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLDRCQUE0QixDQUFBO0FBQy9ELE9BQU8sS0FBSyxjQUFjLE1BQU0sNEJBQTRCLENBQUE7QUFDNUQsT0FBTyxFQUFFLGtCQUFrQixFQUFFLGNBQWMsRUFBRSxNQUFNLDRCQUE0QixDQUFBO0FBQy9FLE9BQU8sS0FBSyxzQkFBc0IsTUFBTSxvQ0FBb0MsQ0FBQTtBQUM1RSxPQUFPLEtBQUssUUFBUSxNQUFNLHNCQUFzQixDQUFBO0FBQ2hELE9BQU8sS0FBSyxPQUFPLE1BQU0scUJBQXFCLENBQUE7QUFDOUMsT0FBTyxLQUFLLE9BQU8sTUFBTSx1QkFBdUIsQ0FBQTtBQUVoRCxPQUFPLEVBQUUsS0FBSyxFQUFFLE1BQU0sc0JBQXNCLENBQUE7QUFDNUMsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0seUJBQXlCLENBQUE7QUFDN0QsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sMkJBQTJCLENBQUE7QUFDakUsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sd0JBQXdCLENBQUE7QUFDM0QsT0FBTyxFQUFFLG9CQUFvQixFQUFFLE1BQU0sMEJBQTBCLENBQUE7QUFFL0QsTUFBTSxDQUFDLE1BQU0sb0JBQW9CLEdBQWMsQ0FB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QyxDQUFBO1lBQ0YsdUJBQXVCLENBQUMsT0FBTyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7Z0JBQ3hDLEtBQUssQ0FBQyxjQUFjLENBQUMsSUFBSSxzQkFBc0IsQ0FBQyxTQUFTLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQTtZQUMxRSxDQUFDLENBQUMsQ0FBQTtTQUNIO1FBRUQsSUFBSSxDQUFDLEdBQUcsR0FBRyxJQUFJLFNBQVMsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQ3BDLEtBQUssRUFBRSxHQUFHLENBQUMsR0FBRztTQUNmLENBQUMsQ0FBQTtJQUNKLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFNVUFBPUlRFRF9DSEFJTlMgfSBmcm9tICdAdW5pc3dhcC9zbWFydC1vcmRlci1yb3V0ZXInXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInXG5pbXBvcnQgeyBDaGFpbklkIH0gZnJvbSAnQHVuaXN3YXAvc2RrLWNvcmUnXG5pbXBvcnQgeyBDZm5PdXRwdXQsIER1cmF0aW9uIH0gZnJvbSAnYXdzLWNkay1saWInXG5pbXBvcnQgKiBhcyBhd3NfYXBpZ2F0ZXdheSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheSdcbmltcG9ydCB7IE1ldGhvZExvZ2dpbmdMZXZlbCB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5J1xuaW1wb3J0ICogYXMgYXdzX2Nsb3Vkd2F0Y2ggZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3Vkd2F0Y2gnXG5pbXBvcnQgeyBDb21wYXJpc29uT3BlcmF0b3IsIE1hdGhFeHByZXNzaW9uIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3Vkd2F0Y2gnXG5pbXBvcnQgKiBhcyBhd3NfY2xvdWR3YXRjaF9hY3Rpb25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoLWFjdGlvbnMnXG5pbXBvcnQgKiBhcyBhd3NfbG9ncyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbG9ncydcbmltcG9ydCAqIGFzIGF3c19zbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucydcbmltcG9ydCAqIGFzIGF3c193YWYgZnJvbSAnYXdzLWNkay1saWIvYXdzLXdhZnYyJ1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cydcbmltcG9ydCB7IFNUQUdFIH0gZnJvbSAnLi4vLi4vbGliL3V0aWwvc3RhZ2UnXG5pbXBvcnQgeyBSb3V0aW5nQ2FjaGluZ1N0YWNrIH0gZnJvbSAnLi9yb3V0aW5nLWNhY2hpbmctc3RhY2snXG5pbXBvcnQgeyBSb3V0aW5nRGFzaGJvYXJkU3RhY2sgfSBmcm9tICcuL3JvdXRpbmctZGFzaGJvYXJkLXN0YWNrJ1xuaW1wb3J0IHsgUm91dGluZ0xhbWJkYVN0YWNrIH0gZnJvbSAnLi9yb3V0aW5nLWxhbWJkYS1zdGFjaydcbmltcG9ydCB7IFJvdXRpbmdEYXRhYmFzZVN0YWNrIH0gZnJvbSAnLi9yb3V0aW5nLWRhdGFiYXNlLXN0YWNrJ1xuXG5leHBvcnQgY29uc3QgQ0hBSU5TX05PVF9NT05JVE9SRUQ6IENoYWluSWRbXSA9IFtDaGFpbklkLkdPRVJMSSwgQ2hhaW5JZC5QT0xZR09OX01VTUJBSV1cblxuZXhwb3J0IGNsYXNzIFJvdXRpbmdBUElTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSB1cmw6IENmbk91dHB1dFxuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHBhcmVudDogQ29uc3RydWN0LFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBwcm9wczogY2RrLlN0YWNrUHJvcHMgJiB7XG4gICAgICBqc29uUnBjUHJvdmlkZXJzOiB7IFtjaGFpbk5hbWU6IHN0cmluZ106IHN0cmluZyB9XG4gICAgICBwcm92aXNpb25lZENvbmN1cnJlbmN5OiBudW1iZXJcbiAgICAgIHRocm90dGxpbmdPdmVycmlkZT86IHN0cmluZ1xuICAgICAgZXRoR2FzU3RhdGlvbkluZm9Vcmw6IHN0cmluZ1xuICAgICAgY2hhdGJvdFNOU0Fybj86IHN0cmluZ1xuICAgICAgc3RhZ2U6IHN0cmluZ1xuICAgICAgaW50ZXJuYWxBcGlLZXk/OiBzdHJpbmdcbiAgICAgIHJvdXRlNTNBcm4/OiBzdHJpbmdcbiAgICAgIHBpbmF0YV9rZXk/OiBzdHJpbmdcbiAgICAgIHBpbmF0YV9zZWNyZXQ/OiBzdHJpbmdcbiAgICAgIGhvc3RlZF96b25lPzogc3RyaW5nXG4gICAgICB0ZW5kZXJseVVzZXI6IHN0cmluZ1xuICAgICAgdGVuZGVybHlQcm9qZWN0OiBzdHJpbmdcbiAgICAgIHRlbmRlcmx5QWNjZXNzS2V5OiBzdHJpbmdcbiAgICAgIHVuaWNvcm5TZWNyZXQ6IHN0cmluZ1xuICAgIH1cbiAgKSB7XG4gICAgc3VwZXIocGFyZW50LCBuYW1lLCBwcm9wcylcblxuICAgIGNvbnN0IHtcbiAgICAgIGpzb25ScGNQcm92aWRlcnMsXG4gICAgICBwcm92aXNpb25lZENvbmN1cnJlbmN5LFxuICAgICAgdGhyb3R0bGluZ092ZXJyaWRlLFxuICAgICAgZXRoR2FzU3RhdGlvbkluZm9VcmwsXG4gICAgICBjaGF0Ym90U05TQXJuLFxuICAgICAgc3RhZ2UsXG4gICAgICBpbnRlcm5hbEFwaUtleSxcbiAgICAgIHJvdXRlNTNBcm4sXG4gICAgICBwaW5hdGFfa2V5LFxuICAgICAgcGluYXRhX3NlY3JldCxcbiAgICAgIGhvc3RlZF96b25lLFxuICAgICAgdGVuZGVybHlVc2VyLFxuICAgICAgdGVuZGVybHlQcm9qZWN0LFxuICAgICAgdGVuZGVybHlBY2Nlc3NLZXksXG4gICAgICB1bmljb3JuU2VjcmV0LFxuICAgIH0gPSBwcm9wc1xuXG4gICAgY29uc3Qge1xuICAgICAgcG9vbENhY2hlQnVja2V0LFxuICAgICAgcG9vbENhY2hlQnVja2V0MixcbiAgICAgIHBvb2xDYWNoZUtleSxcbiAgICAgIHBvb2xDYWNoZUxhbWJkYU5hbWVBcnJheSxcbiAgICAgIHRva2VuTGlzdENhY2hlQnVja2V0LFxuICAgICAgaXBmc1Bvb2xDYWNoaW5nTGFtYmRhLFxuICAgIH0gPSBuZXcgUm91dGluZ0NhY2hpbmdTdGFjayh0aGlzLCAnUm91dGluZ0NhY2hpbmdTdGFjaycsIHtcbiAgICAgIGNoYXRib3RTTlNBcm4sXG4gICAgICBzdGFnZSxcbiAgICAgIHJvdXRlNTNBcm4sXG4gICAgICBwaW5hdGFfa2V5LFxuICAgICAgcGluYXRhX3NlY3JldCxcbiAgICAgIGhvc3RlZF96b25lLFxuICAgIH0pXG5cbiAgICBjb25zdCB7XG4gICAgICByb3V0ZXNEeW5hbW9EYixcbiAgICAgIHJvdXRlc0RiQ2FjaGluZ1JlcXVlc3RGbGFnRHluYW1vRGIsXG4gICAgICBjYWNoZWRSb3V0ZXNEeW5hbW9EYixcbiAgICAgIGNhY2hpbmdSZXF1ZXN0RmxhZ0R5bmFtb0RiLFxuICAgICAgY2FjaGVkVjNQb29sc0R5bmFtb0RiLFxuICAgICAgY2FjaGVkVjJQYWlyc0R5bmFtb0RiLFxuICAgICAgdG9rZW5Qcm9wZXJ0aWVzQ2FjaGluZ0R5bmFtb0RiLFxuICAgIH0gPSBuZXcgUm91dGluZ0RhdGFiYXNlU3RhY2sodGhpcywgJ1JvdXRpbmdEYXRhYmFzZVN0YWNrJywge30pXG5cbiAgICBjb25zdCB7IHJvdXRpbmdMYW1iZGEsIHJvdXRpbmdMYW1iZGFBbGlhcyB9ID0gbmV3IFJvdXRpbmdMYW1iZGFTdGFjayh0aGlzLCAnUm91dGluZ0xhbWJkYVN0YWNrJywge1xuICAgICAgcG9vbENhY2hlQnVja2V0LFxuICAgICAgcG9vbENhY2hlQnVja2V0MixcbiAgICAgIHBvb2xDYWNoZUtleSxcbiAgICAgIGpzb25ScGNQcm92aWRlcnMsXG4gICAgICB0b2tlbkxpc3RDYWNoZUJ1Y2tldCxcbiAgICAgIHByb3Zpc2lvbmVkQ29uY3VycmVuY3ksXG4gICAgICBldGhHYXNTdGF0aW9uSW5mb1VybCxcbiAgICAgIGNoYXRib3RTTlNBcm4sXG4gICAgICB0ZW5kZXJseVVzZXIsXG4gICAgICB0ZW5kZXJseVByb2plY3QsXG4gICAgICB0ZW5kZXJseUFjY2Vzc0tleSxcbiAgICAgIHJvdXRlc0R5bmFtb0RiLFxuICAgICAgcm91dGVzRGJDYWNoaW5nUmVxdWVzdEZsYWdEeW5hbW9EYixcbiAgICAgIGNhY2hlZFJvdXRlc0R5bmFtb0RiLFxuICAgICAgY2FjaGluZ1JlcXVlc3RGbGFnRHluYW1vRGIsXG4gICAgICBjYWNoZWRWM1Bvb2xzRHluYW1vRGIsXG4gICAgICBjYWNoZWRWMlBhaXJzRHluYW1vRGIsXG4gICAgICB0b2tlblByb3BlcnRpZXNDYWNoaW5nRHluYW1vRGIsXG4gICAgICB1bmljb3JuU2VjcmV0LFxuICAgIH0pXG5cbiAgICBjb25zdCBhY2Nlc3NMb2dHcm91cCA9IG5ldyBhd3NfbG9ncy5Mb2dHcm91cCh0aGlzLCAnUm91dGluZ0FQSUdBY2Nlc3NMb2dzJylcblxuICAgIGNvbnN0IGFwaSA9IG5ldyBhd3NfYXBpZ2F0ZXdheS5SZXN0QXBpKHRoaXMsICdyb3V0aW5nLWFwaScsIHtcbiAgICAgIHJlc3RBcGlOYW1lOiAnUm91dGluZyBBUEknLFxuICAgICAgZGVwbG95T3B0aW9uczoge1xuICAgICAgICB0cmFjaW5nRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgbG9nZ2luZ0xldmVsOiBNZXRob2RMb2dnaW5nTGV2ZWwuRVJST1IsXG4gICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uOiBuZXcgYXdzX2FwaWdhdGV3YXkuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihhY2Nlc3NMb2dHcm91cCksXG4gICAgICAgIGFjY2Vzc0xvZ0Zvcm1hdDogYXdzX2FwaWdhdGV3YXkuQWNjZXNzTG9nRm9ybWF0Lmpzb25XaXRoU3RhbmRhcmRGaWVsZHMoe1xuICAgICAgICAgIGlwOiBmYWxzZSxcbiAgICAgICAgICBjYWxsZXI6IGZhbHNlLFxuICAgICAgICAgIHVzZXI6IGZhbHNlLFxuICAgICAgICAgIHJlcXVlc3RUaW1lOiB0cnVlLFxuICAgICAgICAgIGh0dHBNZXRob2Q6IHRydWUsXG4gICAgICAgICAgcmVzb3VyY2VQYXRoOiB0cnVlLFxuICAgICAgICAgIHN0YXR1czogdHJ1ZSxcbiAgICAgICAgICBwcm90b2NvbDogdHJ1ZSxcbiAgICAgICAgICByZXNwb25zZUxlbmd0aDogdHJ1ZSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgICAgZGVmYXVsdENvcnNQcmVmbGlnaHRPcHRpb25zOiB7XG4gICAgICAgIGFsbG93T3JpZ2luczogYXdzX2FwaWdhdGV3YXkuQ29ycy5BTExfT1JJR0lOUyxcbiAgICAgICAgYWxsb3dNZXRob2RzOiBhd3NfYXBpZ2F0ZXdheS5Db3JzLkFMTF9NRVRIT0RTLFxuICAgICAgfSxcbiAgICB9KVxuXG4gICAgY29uc3QgaXBUaHJvdHRsaW5nQUNMID0gbmV3IGF3c193YWYuQ2ZuV2ViQUNMKHRoaXMsICdSb3V0aW5nQVBJSVBUaHJvdHRsaW5nQUNMJywge1xuICAgICAgZGVmYXVsdEFjdGlvbjogeyBhbGxvdzoge30gfSxcbiAgICAgIHNjb3BlOiAnUkVHSU9OQUwnLFxuICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgIG1ldHJpY05hbWU6ICdSb3V0aW5nQVBJSVBCYXNlZFRocm90dGxpbmcnLFxuICAgICAgfSxcbiAgICAgIGN1c3RvbVJlc3BvbnNlQm9kaWVzOiB7XG4gICAgICAgIFJvdXRpbmdBUElUaHJvdHRsZWRSZXNwb25zZUJvZHk6IHtcbiAgICAgICAgICBjb250ZW50VHlwZTogJ0FQUExJQ0FUSU9OX0pTT04nLFxuICAgICAgICAgIGNvbnRlbnQ6ICd7XCJlcnJvckNvZGVcIjogXCJUT09fTUFOWV9SRVFVRVNUU1wifScsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgbmFtZTogJ1JvdXRpbmdBUElJUFRocm90dGxpbmcnLFxuICAgICAgcnVsZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdpcCcsXG4gICAgICAgICAgcHJpb3JpdHk6IDAsXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICByYXRlQmFzZWRTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgLy8gTGltaXQgaXMgcGVyIDUgbWlucywgaS5lLiAxMjAgcmVxdWVzdHMgZXZlcnkgNSBtaW5zXG4gICAgICAgICAgICAgIGxpbWl0OiB0aHJvdHRsaW5nT3ZlcnJpZGUgPyBwYXJzZUludCh0aHJvdHRsaW5nT3ZlcnJpZGUpIDogMTIwLFxuICAgICAgICAgICAgICAvLyBBUEkgaXMgb2YgdHlwZSBFREdFIHNvIGlzIGZyb250ZWQgYnkgQ2xvdWRmcm9udCBhcyBhIHByb3h5LlxuICAgICAgICAgICAgICAvLyBVc2UgdGhlIGlwIHNldCBpbiBYLUZvcndhcmRlZC1Gb3IgYnkgQ2xvdWRmcm9udCwgbm90IHRoZSByZWd1bGFyIElQXG4gICAgICAgICAgICAgIC8vIHdoaWNoIHdvdWxkIGp1c3QgcmVzb2x2ZSB0byBDbG91ZGZyb250cyBJUC5cbiAgICAgICAgICAgICAgYWdncmVnYXRlS2V5VHlwZTogJ0ZPUldBUkRFRF9JUCcsXG4gICAgICAgICAgICAgIGZvcndhcmRlZElwQ29uZmlnOiB7XG4gICAgICAgICAgICAgICAgaGVhZGVyTmFtZTogJ1gtRm9yd2FyZGVkLUZvcicsXG4gICAgICAgICAgICAgICAgZmFsbGJhY2tCZWhhdmlvcjogJ01BVENIJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgc2NvcGVEb3duU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgbm90U3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgYnl0ZU1hdGNoU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgICAgICAgICAgZmllbGRUb01hdGNoOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzaW5nbGVIZWFkZXI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogJ3gtYXBpLWtleScsXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgcG9zaXRpb25hbENvbnN0cmFpbnQ6ICdFWEFDVExZJyxcbiAgICAgICAgICAgICAgICAgICAgICBzZWFyY2hTdHJpbmc6IGludGVybmFsQXBpS2V5LFxuICAgICAgICAgICAgICAgICAgICAgIHRleHRUcmFuc2Zvcm1hdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZTogJ05PTkUnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICBwcmlvcml0eTogMCxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBhY3Rpb246IHtcbiAgICAgICAgICAgIGJsb2NrOiB7XG4gICAgICAgICAgICAgIGN1c3RvbVJlc3BvbnNlOiB7XG4gICAgICAgICAgICAgICAgcmVzcG9uc2VDb2RlOiA0MjksXG4gICAgICAgICAgICAgICAgY3VzdG9tUmVzcG9uc2VCb2R5S2V5OiAnUm91dGluZ0FQSVRocm90dGxlZFJlc3BvbnNlQm9keScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdSb3V0aW5nQVBJSVBCYXNlZFRocm90dGxpbmdSdWxlJyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KVxuXG4gICAgY29uc3QgcmVnaW9uID0gY2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvblxuICAgIGNvbnN0IGFwaUFybiA9IGBhcm46YXdzOmFwaWdhdGV3YXk6JHtyZWdpb259OjovcmVzdGFwaXMvJHthcGkucmVzdEFwaUlkfS9zdGFnZXMvJHthcGkuZGVwbG95bWVudFN0YWdlLnN0YWdlTmFtZX1gXG5cbiAgICBuZXcgYXdzX3dhZi5DZm5XZWJBQ0xBc3NvY2lhdGlvbih0aGlzLCAnUm91dGluZ0FQSUlQVGhyb3R0bGluZ0Fzc29jaWF0aW9uJywge1xuICAgICAgcmVzb3VyY2VBcm46IGFwaUFybixcbiAgICAgIHdlYkFjbEFybjogaXBUaHJvdHRsaW5nQUNMLmdldEF0dCgnQXJuJykudG9TdHJpbmcoKSxcbiAgICB9KVxuXG4gICAgbmV3IFJvdXRpbmdEYXNoYm9hcmRTdGFjayh0aGlzLCAnUm91dGluZ0Rhc2hib2FyZFN0YWNrJywge1xuICAgICAgYXBpTmFtZTogYXBpLnJlc3RBcGlOYW1lLFxuICAgICAgcm91dGluZ0xhbWJkYU5hbWU6IHJvdXRpbmdMYW1iZGEuZnVuY3Rpb25OYW1lLFxuICAgICAgcG9vbENhY2hlTGFtYmRhTmFtZUFycmF5LFxuICAgICAgaXBmc1Bvb2xDYWNoZUxhbWJkYU5hbWU6IGlwZnNQb29sQ2FjaGluZ0xhbWJkYSA/IGlwZnNQb29sQ2FjaGluZ0xhbWJkYS5mdW5jdGlvbk5hbWUgOiB1bmRlZmluZWQsXG4gICAgfSlcblxuICAgIGNvbnN0IGxhbWJkYUludGVncmF0aW9uID0gbmV3IGF3c19hcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uKHJvdXRpbmdMYW1iZGFBbGlhcylcblxuICAgIGNvbnN0IHF1b3RlID0gYXBpLnJvb3QuYWRkUmVzb3VyY2UoJ3F1b3RlJywge1xuICAgICAgZGVmYXVsdENvcnNQcmVmbGlnaHRPcHRpb25zOiB7XG4gICAgICAgIGFsbG93T3JpZ2luczogYXdzX2FwaWdhdGV3YXkuQ29ycy5BTExfT1JJR0lOUyxcbiAgICAgICAgYWxsb3dNZXRob2RzOiBhd3NfYXBpZ2F0ZXdheS5Db3JzLkFMTF9NRVRIT0RTLFxuICAgICAgfSxcbiAgICB9KVxuICAgIHF1b3RlLmFkZE1ldGhvZCgnR0VUJywgbGFtYmRhSW50ZWdyYXRpb24pXG5cbiAgICAvLyBBbGwgYWxhcm1zIGRlZmF1bHQgdG8gR3JlYXRlclRoYW5PckVxdWFsVG9UaHJlc2hvbGQgZm9yIHdoZW4gdG8gYmUgdHJpZ2dlcmVkLlxuICAgIGNvbnN0IGFwaUFsYXJtNXh4U2V2MiA9IG5ldyBhd3NfY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnUm91dGluZ0FQSS1TRVYyLTVYWEFsYXJtJywge1xuICAgICAgYWxhcm1OYW1lOiAnUm91dGluZ0FQSS1TRVYyLTVYWCcsXG4gICAgICBtZXRyaWM6IGFwaS5tZXRyaWNTZXJ2ZXJFcnJvcih7XG4gICAgICAgIHBlcmlvZDogRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgICAgLy8gRm9yIHRoaXMgbWV0cmljICdhdmcnIHJlcHJlc2VudHMgZXJyb3IgcmF0ZS5cbiAgICAgICAgc3RhdGlzdGljOiAnYXZnJyxcbiAgICAgIH0pLFxuICAgICAgdGhyZXNob2xkOiAwLjAyLFxuICAgICAgLy8gQmV0YSBoYXMgbXVjaCBsZXNzIHRyYWZmaWMgc28gaXMgbW9yZSBzdXNjZXB0aWJsZSB0byB0cmFuc2llbnQgZXJyb3JzLlxuICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IHN0YWdlID09IFNUQUdFLkJFVEEgPyA1IDogMyxcbiAgICB9KVxuXG4gICAgY29uc3QgYXBpQWxhcm01eHhTZXYzID0gbmV3IGF3c19jbG91ZHdhdGNoLkFsYXJtKHRoaXMsICdSb3V0aW5nQVBJLVNFVjMtNVhYQWxhcm0nLCB7XG4gICAgICBhbGFybU5hbWU6ICdSb3V0aW5nQVBJLVNFVjMtNVhYJyxcbiAgICAgIG1ldHJpYzogYXBpLm1ldHJpY1NlcnZlckVycm9yKHtcbiAgICAgICAgcGVyaW9kOiBEdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgICAvLyBGb3IgdGhpcyBtZXRyaWMgJ2F2ZycgcmVwcmVzZW50cyBlcnJvciByYXRlLlxuICAgICAgICBzdGF0aXN0aWM6ICdhdmcnLFxuICAgICAgfSksXG4gICAgICB0aHJlc2hvbGQ6IDAuMDEsXG4gICAgICAvLyBCZXRhIGhhcyBtdWNoIGxlc3MgdHJhZmZpYyBzbyBpcyBtb3JlIHN1c2NlcHRpYmxlIHRvIHRyYW5zaWVudCBlcnJvcnMuXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogc3RhZ2UgPT0gU1RBR0UuQkVUQSA/IDUgOiAzLFxuICAgIH0pXG5cbiAgICBjb25zdCBhcGlBbGFybTR4eFNldjIgPSBuZXcgYXdzX2Nsb3Vkd2F0Y2guQWxhcm0odGhpcywgJ1JvdXRpbmdBUEktU0VWMi00WFhBbGFybScsIHtcbiAgICAgIGFsYXJtTmFtZTogJ1JvdXRpbmdBUEktU0VWMi00WFgnLFxuICAgICAgbWV0cmljOiBhcGkubWV0cmljQ2xpZW50RXJyb3Ioe1xuICAgICAgICBwZXJpb2Q6IER1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICAgIHN0YXRpc3RpYzogJ2F2ZycsXG4gICAgICB9KSxcbiAgICAgIHRocmVzaG9sZDogMC42LFxuICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IDMsXG4gICAgfSlcblxuICAgIGNvbnN0IGFwaUFsYXJtNHh4U2V2MyA9IG5ldyBhd3NfY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnUm91dGluZ0FQSS1TRVYzLTRYWEFsYXJtJywge1xuICAgICAgYWxhcm1OYW1lOiAnUm91dGluZ0FQSS1TRVYzLTRYWCcsXG4gICAgICBtZXRyaWM6IGFwaS5tZXRyaWNDbGllbnRFcnJvcih7XG4gICAgICAgIHBlcmlvZDogRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgICAgc3RhdGlzdGljOiAnYXZnJyxcbiAgICAgIH0pLFxuICAgICAgdGhyZXNob2xkOiAwLjQsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMyxcbiAgICB9KVxuXG4gICAgY29uc3QgYXBpQWxhcm1MYXRlbmN5U2V2MiA9IG5ldyBhd3NfY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnUm91dGluZ0FQSS1TRVYyLUxhdGVuY3knLCB7XG4gICAgICBhbGFybU5hbWU6ICdSb3V0aW5nQVBJLVNFVjItTGF0ZW5jeScsXG4gICAgICBtZXRyaWM6IGFwaS5tZXRyaWNMYXRlbmN5KHtcbiAgICAgICAgcGVyaW9kOiBEdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgICBzdGF0aXN0aWM6ICdwOTAnLFxuICAgICAgfSksXG4gICAgICB0aHJlc2hvbGQ6IDY1MDAsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMyxcbiAgICB9KVxuXG4gICAgY29uc3QgYXBpQWxhcm1MYXRlbmN5U2V2MyA9IG5ldyBhd3NfY2xvdWR3YXRjaC5BbGFybSh0aGlzLCAnUm91dGluZ0FQSS1TRVYzLUxhdGVuY3knLCB7XG4gICAgICBhbGFybU5hbWU6ICdSb3V0aW5nQVBJLVNFVjMtTGF0ZW5jeScsXG4gICAgICBtZXRyaWM6IGFwaS5tZXRyaWNMYXRlbmN5KHtcbiAgICAgICAgcGVyaW9kOiBEdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgICBzdGF0aXN0aWM6ICdwOTAnLFxuICAgICAgfSksXG4gICAgICB0aHJlc2hvbGQ6IDM1MDAsXG4gICAgICBldmFsdWF0aW9uUGVyaW9kczogMyxcbiAgICB9KVxuXG4gICAgLy8gU2ltdWxhdGlvbnMgY2FuIGZhaWwgZm9yIHZhbGlkIHJlYXNvbnMuIEZvciBleGFtcGxlLCBpZiB0aGUgc2ltdWxhdGlvbiByZXZlcnRzIGR1ZVxuICAgIC8vIHRvIHNsaXBwYWdlIGNoZWNrcyAoY2FuIGhhcHBlbiB3aXRoIEZPVCB0b2tlbnMgc29tZXRpbWVzIHNpbmNlIG91ciBxdW90ZXIgZG9lcyBub3RcbiAgICAvLyBhY2NvdW50IGZvciB0aGUgZmVlcyB0YWtlbiBkdXJpbmcgdHJhbnNmZXIgd2hlbiB3ZSBzaG93IHRoZSB1c2VyIHRoZSBxdW90ZSkuXG4gICAgLy9cbiAgICAvLyBGb3IgdGhpcyByZWFzb24gd2Ugb25seSBhbGVydCBvbiBTRVYzIHRvIGF2b2lkIHVubmVjZXNzYXJ5IHBhZ2VzLlxuICAgIGNvbnN0IHNpbXVsYXRpb25BbGFybVNldjMgPSBuZXcgYXdzX2Nsb3Vkd2F0Y2guQWxhcm0odGhpcywgJ1JvdXRpbmdBUEktU0VWMy1TaW11bGF0aW9uJywge1xuICAgICAgYWxhcm1OYW1lOiAnUm91dGluZ0FQSS1TRVYzLVNpbXVsYXRpb24nLFxuICAgICAgbWV0cmljOiBuZXcgTWF0aEV4cHJlc3Npb24oe1xuICAgICAgICBleHByZXNzaW9uOiAnMTAwKihzaW11bGF0aW9uRmFpbGVkL3NpbXVsYXRpb25SZXF1ZXN0ZWQpJyxcbiAgICAgICAgcGVyaW9kOiBEdXJhdGlvbi5taW51dGVzKDMwKSxcbiAgICAgICAgdXNpbmdNZXRyaWNzOiB7XG4gICAgICAgICAgc2ltdWxhdGlvblJlcXVlc3RlZDogbmV3IGF3c19jbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgICBuYW1lc3BhY2U6ICdVbmlzd2FwJyxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6IGBTaW11bGF0aW9uIFJlcXVlc3RlZGAsXG4gICAgICAgICAgICBkaW1lbnNpb25zTWFwOiB7IFNlcnZpY2U6ICdSb3V0aW5nQVBJJyB9LFxuICAgICAgICAgICAgdW5pdDogYXdzX2Nsb3Vkd2F0Y2guVW5pdC5DT1VOVCxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ3N1bScsXG4gICAgICAgICAgfSksXG4gICAgICAgICAgc2ltdWxhdGlvbkZhaWxlZDogbmV3IGF3c19jbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgICBuYW1lc3BhY2U6ICdVbmlzd2FwJyxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6IGBTaW11bGF0aW9uRmFpbGVkYCxcbiAgICAgICAgICAgIGRpbWVuc2lvbnNNYXA6IHsgU2VydmljZTogJ1JvdXRpbmdBUEknIH0sXG4gICAgICAgICAgICB1bml0OiBhd3NfY2xvdWR3YXRjaC5Vbml0LkNPVU5ULFxuICAgICAgICAgICAgc3RhdGlzdGljOiAnc3VtJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgdGhyZXNob2xkOiAyMCxcbiAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiAzLFxuICAgICAgdHJlYXRNaXNzaW5nRGF0YTogYXdzX2Nsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5OT1RfQlJFQUNISU5HLCAvLyBNaXNzaW5nIGRhdGEgcG9pbnRzIGFyZSB0cmVhdGVkIGFzIFwiZ29vZFwiIGFuZCB3aXRoaW4gdGhlIHRocmVzaG9sZFxuICAgIH0pXG5cbiAgICAvLyBBbGFybXMgZm9yIGhpZ2ggNDAwIGVycm9yIHJhdGUgZm9yIGVhY2ggY2hhaW5cbiAgICBjb25zdCBwZXJjZW50NFhYQnlDaGFpbkFsYXJtOiBjZGsuYXdzX2Nsb3Vkd2F0Y2guQWxhcm1bXSA9IFtdXG4gICAgU1VQUE9SVEVEX0NIQUlOUy5mb3JFYWNoKChjaGFpbklkKSA9PiB7XG4gICAgICBpZiAoQ0hBSU5TX05PVF9NT05JVE9SRUQuaW5jbHVkZXMoY2hhaW5JZCkpIHtcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG4gICAgICBjb25zdCBhbGFybU5hbWUgPSBgUm91dGluZ0FQSS1TRVYzLTRYWEFsYXJtLUNoYWluSWQ6ICR7Y2hhaW5JZC50b1N0cmluZygpfWBcbiAgICAgIGNvbnN0IG1ldHJpYyA9IG5ldyBNYXRoRXhwcmVzc2lvbih7XG4gICAgICAgIGV4cHJlc3Npb246ICcxMDAqKHJlc3BvbnNlNDAwL2ludm9jYXRpb25zKScsXG4gICAgICAgIHVzaW5nTWV0cmljczoge1xuICAgICAgICAgIGludm9jYXRpb25zOiBhcGkubWV0cmljKGBHRVRfUVVPVEVfUkVRVUVTVEVEX0NIQUlOSUQ6ICR7Y2hhaW5JZC50b1N0cmluZygpfWAsIHtcbiAgICAgICAgICAgIHBlcmlvZDogRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ3N1bScsXG4gICAgICAgICAgfSksXG4gICAgICAgICAgcmVzcG9uc2U0MDA6IGFwaS5tZXRyaWMoYEdFVF9RVU9URV80MDBfQ0hBSU5JRDogJHtjaGFpbklkLnRvU3RyaW5nKCl9YCwge1xuICAgICAgICAgICAgcGVyaW9kOiBEdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgICAgICAgc3RhdGlzdGljOiAnc3VtJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG4gICAgICBjb25zdCBhbGFybSA9IG5ldyBhd3NfY2xvdWR3YXRjaC5BbGFybSh0aGlzLCBhbGFybU5hbWUsIHtcbiAgICAgICAgYWxhcm1OYW1lLFxuICAgICAgICBtZXRyaWMsXG4gICAgICAgIHRocmVzaG9sZDogODAsXG4gICAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiAyLFxuICAgICAgfSlcbiAgICAgIHBlcmNlbnQ0WFhCeUNoYWluQWxhcm0ucHVzaChhbGFybSlcbiAgICB9KVxuXG4gICAgLy8gQWxhcm1zIGZvciBoaWdoIDUwMCBlcnJvciByYXRlIGZvciBlYWNoIGNoYWluXG4gICAgY29uc3Qgc3VjY2Vzc1JhdGVCeUNoYWluQWxhcm06IGNkay5hd3NfY2xvdWR3YXRjaC5BbGFybVtdID0gW11cbiAgICBTVVBQT1JURURfQ0hBSU5TLmZvckVhY2goKGNoYWluSWQpID0+IHtcbiAgICAgIGlmIChDSEFJTlNfTk9UX01PTklUT1JFRC5pbmNsdWRlcyhjaGFpbklkKSkge1xuICAgICAgICByZXR1cm5cbiAgICAgIH1cbiAgICAgIGNvbnN0IGFsYXJtTmFtZSA9IGBSb3V0aW5nQVBJLVNFVjItU3VjY2Vzc1JhdGUtQWxhcm0tQ2hhaW5JZDogJHtjaGFpbklkLnRvU3RyaW5nKCl9YFxuICAgICAgY29uc3QgbWV0cmljID0gbmV3IE1hdGhFeHByZXNzaW9uKHtcbiAgICAgICAgZXhwcmVzc2lvbjogJzEwMCoocmVzcG9uc2UyMDAvKGludm9jYXRpb25zLXJlc3BvbnNlNDAwKSknLFxuICAgICAgICB1c2luZ01ldHJpY3M6IHtcbiAgICAgICAgICBpbnZvY2F0aW9uczogYXBpLm1ldHJpYyhgR0VUX1FVT1RFX1JFUVVFU1RFRF9DSEFJTklEOiAke2NoYWluSWQudG9TdHJpbmcoKX1gLCB7XG4gICAgICAgICAgICBwZXJpb2Q6IER1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICAgICAgICBzdGF0aXN0aWM6ICdzdW0nLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIHJlc3BvbnNlNDAwOiBhcGkubWV0cmljKGBHRVRfUVVPVEVfNDAwX0NIQUlOSUQ6ICR7Y2hhaW5JZC50b1N0cmluZygpfWAsIHtcbiAgICAgICAgICAgIHBlcmlvZDogRHVyYXRpb24ubWludXRlcyg1KSxcbiAgICAgICAgICAgIHN0YXRpc3RpYzogJ3N1bScsXG4gICAgICAgICAgfSksXG4gICAgICAgICAgcmVzcG9uc2UyMDA6IGFwaS5tZXRyaWMoYEdFVF9RVU9URV8yMDBfQ0hBSU5JRDogJHtjaGFpbklkLnRvU3RyaW5nKCl9YCwge1xuICAgICAgICAgICAgcGVyaW9kOiBEdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgICAgICAgc3RhdGlzdGljOiAnc3VtJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIH0pXG4gICAgICBjb25zdCBhbGFybSA9IG5ldyBhd3NfY2xvdWR3YXRjaC5BbGFybSh0aGlzLCBhbGFybU5hbWUsIHtcbiAgICAgICAgYWxhcm1OYW1lLFxuICAgICAgICBtZXRyaWMsXG4gICAgICAgIGNvbXBhcmlzb25PcGVyYXRvcjogQ29tcGFyaXNvbk9wZXJhdG9yLkxFU1NfVEhBTl9PUl9FUVVBTF9UT19USFJFU0hPTEQsXG4gICAgICAgIHRocmVzaG9sZDogOTUsIC8vIFRoaXMgaXMgYWxhcm0gd2lsbCB0cmlnZ2VyIGlmIHRoZSBTUiBpcyBsZXNzIHRoYW4gb3IgZXF1YWwgdG8gOTUlXG4gICAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiAyLFxuICAgICAgfSlcbiAgICAgIHN1Y2Nlc3NSYXRlQnlDaGFpbkFsYXJtLnB1c2goYWxhcm0pXG4gICAgfSlcblxuICAgIGlmIChjaGF0Ym90U05TQXJuKSB7XG4gICAgICBjb25zdCBjaGF0Qm90VG9waWMgPSBhd3Nfc25zLlRvcGljLmZyb21Ub3BpY0Fybih0aGlzLCAnQ2hhdGJvdFRvcGljJywgY2hhdGJvdFNOU0FybilcbiAgICAgIGFwaUFsYXJtNXh4U2V2Mi5hZGRBbGFybUFjdGlvbihuZXcgYXdzX2Nsb3Vkd2F0Y2hfYWN0aW9ucy5TbnNBY3Rpb24oY2hhdEJvdFRvcGljKSlcbiAgICAgIGFwaUFsYXJtNHh4U2V2Mi5hZGRBbGFybUFjdGlvbihuZXcgYXdzX2Nsb3Vkd2F0Y2hfYWN0aW9ucy5TbnNBY3Rpb24oY2hhdEJvdFRvcGljKSlcbiAgICAgIGFwaUFsYXJtTGF0ZW5jeVNldjIuYWRkQWxhcm1BY3Rpb24obmV3IGF3c19jbG91ZHdhdGNoX2FjdGlvbnMuU25zQWN0aW9uKGNoYXRCb3RUb3BpYykpXG4gICAgICBhcGlBbGFybTV4eFNldjMuYWRkQWxhcm1BY3Rpb24obmV3IGF3c19jbG91ZHdhdGNoX2FjdGlvbnMuU25zQWN0aW9uKGNoYXRCb3RUb3BpYykpXG4gICAgICBhcGlBbGFybTR4eFNldjMuYWRkQWxhcm1BY3Rpb24obmV3IGF3c19jbG91ZHdhdGNoX2FjdGlvbnMuU25zQWN0aW9uKGNoYXRCb3RUb3BpYykpXG4gICAgICBhcGlBbGFybUxhdGVuY3lTZXYzLmFkZEFsYXJtQWN0aW9uKG5ldyBhd3NfY2xvdWR3YXRjaF9hY3Rpb25zLlNuc0FjdGlvbihjaGF0Qm90VG9waWMpKVxuICAgICAgc2ltdWxhdGlvbkFsYXJtU2V2My5hZGRBbGFybUFjdGlvbihuZXcgYXdzX2Nsb3Vkd2F0Y2hfYWN0aW9ucy5TbnNBY3Rpb24oY2hhdEJvdFRvcGljKSlcblxuICAgICAgcGVyY2VudDRYWEJ5Q2hhaW5BbGFybS5mb3JFYWNoKChhbGFybSkgPT4ge1xuICAgICAgICBhbGFybS5hZGRBbGFybUFjdGlvbihuZXcgYXdzX2Nsb3Vkd2F0Y2hfYWN0aW9ucy5TbnNBY3Rpb24oY2hhdEJvdFRvcGljKSlcbiAgICAgIH0pXG4gICAgICBzdWNjZXNzUmF0ZUJ5Q2hhaW5BbGFybS5mb3JFYWNoKChhbGFybSkgPT4ge1xuICAgICAgICBhbGFybS5hZGRBbGFybUFjdGlvbihuZXcgYXdzX2Nsb3Vkd2F0Y2hfYWN0aW9ucy5TbnNBY3Rpb24oY2hhdEJvdFRvcGljKSlcbiAgICAgIH0pXG4gICAgfVxuXG4gICAgdGhpcy51cmwgPSBuZXcgQ2ZuT3V0cHV0KHRoaXMsICdVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLnVybCxcbiAgICB9KVxuICB9XG59XG4iXX0=