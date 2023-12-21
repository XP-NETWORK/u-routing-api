import { ChainId } from '@uniswap/sdk-core';
import * as cdk from 'aws-cdk-lib';
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import _ from 'lodash';
import { QuoteAmountsWidgetsFactory } from '../../lib/dashboards/quote-amounts-widgets-factory';
import { SUPPORTED_CHAINS } from '../../lib/handlers/injector-sor';
import { CachedRoutesWidgetsFactory } from '../../lib/dashboards/cached-routes-widgets-factory';
import { ID_TO_NETWORK_NAME } from '@uniswap/smart-order-router/build/main/util/chains';
import { RpcProvidersWidgetsFactory } from '../../lib/dashboards/rpc-providers-widgets-factory';
export const NAMESPACE = 'Uniswap';
export class RoutingDashboardStack extends cdk.NestedStack {
    constructor(scope, name, props) {
        super(scope, name, props);
        const { apiName, routingLambdaName, poolCacheLambdaNameArray, ipfsPoolCacheLambdaName } = props;
        const region = cdk.Stack.of(this).region;
        const TESTNETS = [
            ChainId.ARBITRUM_GOERLI,
            ChainId.POLYGON_MUMBAI,
            ChainId.BNB_TESTNET,
            ChainId.GOERLI,
            ChainId.SEPOLIA,
            ChainId.CELO_ALFAJORES,
            ChainId.BASE_GOERLI,
        ];
        const MAINNETS = SUPPORTED_CHAINS.filter((chain) => !TESTNETS.includes(chain));
        const REQUEST_SOURCES = ['unknown', 'uniswap-ios', 'uniswap-android', 'uniswap-web', 'external-api'];
        // No CDK resource exists for contributor insights at the moment so use raw CloudFormation.
        const REQUESTED_QUOTES_RULE_NAME = 'RequestedQuotes';
        const REQUESTED_QUOTES_BY_CHAIN_RULE_NAME = 'RequestedQuotesByChain';
        new cdk.CfnResource(this, 'QuoteContributorInsights', {
            type: 'AWS::CloudWatch::InsightRule',
            properties: {
                RuleBody: JSON.stringify({
                    Schema: {
                        Name: 'CloudWatchLogRule',
                        Version: 1,
                    },
                    AggregateOn: 'Count',
                    Contribution: {
                        Filters: [
                            {
                                Match: '$.tokenPairSymbol',
                                IsPresent: true,
                            },
                        ],
                        Keys: ['$.tokenPairSymbol'],
                    },
                    LogFormat: 'JSON',
                    LogGroupNames: [`/aws/lambda/${routingLambdaName}`],
                }),
                RuleName: REQUESTED_QUOTES_RULE_NAME,
                RuleState: 'ENABLED',
            },
        });
        new cdk.CfnResource(this, 'QuoteByChainContributorInsights', {
            type: 'AWS::CloudWatch::InsightRule',
            properties: {
                RuleBody: JSON.stringify({
                    Schema: {
                        Name: 'CloudWatchLogRule',
                        Version: 1,
                    },
                    AggregateOn: 'Count',
                    Contribution: {
                        Filters: [
                            {
                                Match: '$.tokenPairSymbolChain',
                                IsPresent: true,
                            },
                        ],
                        Keys: ['$.tokenPairSymbolChain'],
                    },
                    LogFormat: 'JSON',
                    LogGroupNames: [`/aws/lambda/${routingLambdaName}`],
                }),
                RuleName: REQUESTED_QUOTES_BY_CHAIN_RULE_NAME,
                RuleState: 'ENABLED',
            },
        });
        const poolCacheLambdaMetrics = [];
        poolCacheLambdaNameArray.forEach((poolCacheLambdaName) => {
            poolCacheLambdaMetrics.push(['AWS/Lambda', `${poolCacheLambdaName}Errors`, 'FunctionName', poolCacheLambdaName]);
            poolCacheLambdaMetrics.push(['.', `${poolCacheLambdaName}Invocations`, '.', '.']);
        });
        const perChainWidgetsForRoutingDashboard = _.flatMap([MAINNETS, TESTNETS], (chains) => [
            {
                height: 8,
                width: 24,
                type: 'metric',
                properties: {
                    metrics: chains.map((chainId) => [
                        NAMESPACE,
                        `GET_QUOTE_REQUESTED_CHAINID: ${chainId}`,
                        'Service',
                        'RoutingAPI',
                        { id: `mreqc${chainId}`, label: `Requests on ${ID_TO_NETWORK_NAME(chainId)}` },
                    ]),
                    view: 'timeSeries',
                    stacked: false,
                    region,
                    stat: 'Sum',
                    period: 300,
                    title: 'Requests by Chain',
                    setPeriodToTimeRange: true,
                    yAxis: {
                        left: {
                            showUnits: false,
                            label: 'Requests',
                        },
                    },
                },
            },
            {
                type: 'text',
                width: 24,
                height: 1,
                properties: {
                    markdown: `# Latencies for Intent: Quote`,
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 10,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            NAMESPACE,
                            `GET_QUOTE_LATENCY_CHAIN_${chainId}_INTENT_quote`,
                            'Service',
                            'RoutingAPI',
                            { stat: 'p99.99', label: `${ID_TO_NETWORK_NAME(chainId)} P99.99` },
                        ],
                        ['...', { stat: 'p99.9', label: `${ID_TO_NETWORK_NAME(chainId)} P99.9` }],
                        ['...', { stat: 'p99', label: `${ID_TO_NETWORK_NAME(chainId)} P99` }],
                    ]),
                    region,
                    title: `P99.X Latency by Chain`,
                    period: 300,
                    setPeriodToTimeRange: true,
                    stat: 'SampleCount',
                    yAxis: {
                        left: {
                            min: 0,
                            showUnits: false,
                            label: 'Milliseconds',
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 10,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            NAMESPACE,
                            `GET_QUOTE_LATENCY_CHAIN_${chainId}_INTENT_quote`,
                            'Service',
                            'RoutingAPI',
                            { stat: 'p95', label: `${ID_TO_NETWORK_NAME(chainId)} P95` },
                        ],
                        ['...', { stat: 'p90', label: `${ID_TO_NETWORK_NAME(chainId)} P90` }],
                    ]),
                    region,
                    title: `P95 & P90 Latency by Chain`,
                    period: 300,
                    setPeriodToTimeRange: true,
                    stat: 'SampleCount',
                    yAxis: {
                        left: {
                            min: 0,
                            showUnits: false,
                            label: 'Milliseconds',
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 10,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            NAMESPACE,
                            `GET_QUOTE_LATENCY_CHAIN_${chainId}_INTENT_quote`,
                            'Service',
                            'RoutingAPI',
                            { stat: 'p50', label: `${ID_TO_NETWORK_NAME(chainId)} Median` },
                        ],
                        ['...', { stat: 'Average', label: `${ID_TO_NETWORK_NAME(chainId)} Average` }],
                    ]),
                    region,
                    title: `Average and Median Latency by Chain`,
                    period: 300,
                    setPeriodToTimeRange: true,
                    stat: 'SampleCount',
                    yAxis: {
                        left: {
                            min: 0,
                            showUnits: false,
                            label: 'Milliseconds',
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 10,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            NAMESPACE,
                            `GET_QUOTE_LATENCY_CHAIN_${chainId}_INTENT_quote`,
                            'Service',
                            'RoutingAPI',
                            { stat: 'Minimum', label: `${ID_TO_NETWORK_NAME(chainId)} Minimum` },
                        ],
                    ]),
                    region,
                    title: `Minimum Latency by Chain`,
                    period: 300,
                    setPeriodToTimeRange: true,
                    stat: 'SampleCount',
                    yAxis: {
                        left: {
                            min: 0,
                            showUnits: false,
                            label: 'Milliseconds',
                        },
                    },
                },
            },
            {
                type: 'text',
                width: 24,
                height: 1,
                properties: {
                    markdown: `# Latencies for Intent: Caching`,
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 10,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            NAMESPACE,
                            `GET_QUOTE_LATENCY_CHAIN_${chainId}_INTENT_caching`,
                            'Service',
                            'RoutingAPI',
                            { stat: 'p99.99', label: `${ID_TO_NETWORK_NAME(chainId)} P99.99` },
                        ],
                        ['...', { stat: 'p99.9', label: `${ID_TO_NETWORK_NAME(chainId)} P99.9` }],
                        ['...', { stat: 'p99', label: `${ID_TO_NETWORK_NAME(chainId)} P99` }],
                    ]),
                    region,
                    title: `P99.X Latency by Chain`,
                    period: 300,
                    setPeriodToTimeRange: true,
                    stat: 'SampleCount',
                    yAxis: {
                        left: {
                            min: 0,
                            showUnits: false,
                            label: 'Milliseconds',
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 10,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            NAMESPACE,
                            `GET_QUOTE_LATENCY_CHAIN_${chainId}_INTENT_caching`,
                            'Service',
                            'RoutingAPI',
                            { stat: 'p95', label: `${ID_TO_NETWORK_NAME(chainId)} P95` },
                        ],
                        ['...', { stat: 'p90', label: `${ID_TO_NETWORK_NAME(chainId)} P90` }],
                    ]),
                    region,
                    title: `P95 & P90 Latency by Chain`,
                    period: 300,
                    setPeriodToTimeRange: true,
                    stat: 'SampleCount',
                    yAxis: {
                        left: {
                            min: 0,
                            showUnits: false,
                            label: 'Milliseconds',
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 10,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            NAMESPACE,
                            `GET_QUOTE_LATENCY_CHAIN_${chainId}_INTENT_caching`,
                            'Service',
                            'RoutingAPI',
                            { stat: 'p50', label: `${ID_TO_NETWORK_NAME(chainId)} Median` },
                        ],
                        ['...', { stat: 'Average', label: `${ID_TO_NETWORK_NAME(chainId)} Average` }],
                    ]),
                    region,
                    title: `Average and Median Latency by Chain`,
                    period: 300,
                    setPeriodToTimeRange: true,
                    stat: 'SampleCount',
                    yAxis: {
                        left: {
                            min: 0,
                            showUnits: false,
                            label: 'Milliseconds',
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 10,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            NAMESPACE,
                            `GET_QUOTE_LATENCY_CHAIN_${chainId}_INTENT_caching`,
                            'Service',
                            'RoutingAPI',
                            { stat: 'Minimum', label: `${ID_TO_NETWORK_NAME(chainId)} Minimum` },
                        ],
                    ]),
                    region,
                    title: `Minimum Latency by Chain`,
                    period: 300,
                    setPeriodToTimeRange: true,
                    stat: 'SampleCount',
                    yAxis: {
                        left: {
                            min: 0,
                            showUnits: false,
                            label: 'Milliseconds',
                        },
                    },
                },
            },
            {
                height: 8,
                width: 12,
                type: 'metric',
                properties: {
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            {
                                expression: `(m200c${chainId} / (mreqc${chainId} - m400c${chainId})) * 100`,
                                label: `Success Rate on ${ID_TO_NETWORK_NAME(chainId)}`,
                                id: `e1c${chainId}`,
                            },
                        ],
                        [
                            NAMESPACE,
                            `GET_QUOTE_REQUESTED_CHAINID: ${chainId}`,
                            'Service',
                            'RoutingAPI',
                            { id: `mreqc${chainId}`, label: `Requests on Chain ${chainId}`, visible: false },
                        ],
                        [
                            '.',
                            `GET_QUOTE_200_CHAINID: ${chainId}`,
                            '.',
                            '.',
                            { id: `m200c${chainId}`, label: `2XX Requests on Chain ${chainId}`, visible: false },
                        ],
                        [
                            '.',
                            `GET_QUOTE_400_CHAINID: ${chainId}`,
                            '.',
                            '.',
                            { id: `m400c${chainId}`, label: `4XX Errors on Chain ${chainId}`, visible: false },
                        ],
                    ]),
                    view: 'timeSeries',
                    stacked: false,
                    region,
                    stat: 'Sum',
                    period: 300,
                    title: 'Success Rates by Chain',
                    setPeriodToTimeRange: true,
                    yAxis: {
                        left: {
                            showUnits: false,
                            label: '%',
                        },
                    },
                },
            },
            {
                height: 8,
                width: 12,
                type: 'metric',
                properties: {
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            {
                                expression: `(m200c${chainId} / mreqc${chainId}) * 100`,
                                label: `Success Rate (w. 4XX) on ${ID_TO_NETWORK_NAME(chainId)}`,
                                id: `e1c${chainId}`,
                            },
                        ],
                        [
                            NAMESPACE,
                            `GET_QUOTE_REQUESTED_CHAINID: ${chainId}`,
                            'Service',
                            'RoutingAPI',
                            { id: `mreqc${chainId}`, label: `Requests on Chain ${chainId}`, visible: false },
                        ],
                        [
                            '.',
                            `GET_QUOTE_200_CHAINID: ${chainId}`,
                            '.',
                            '.',
                            { id: `m200c${chainId}`, label: `2XX Requests on Chain ${chainId}`, visible: false },
                        ],
                    ]),
                    view: 'timeSeries',
                    stacked: false,
                    region,
                    stat: 'Sum',
                    period: 300,
                    title: 'Success Rates (w. 4XX) by Chain',
                    setPeriodToTimeRange: true,
                    yAxis: {
                        left: {
                            showUnits: false,
                            label: '%',
                        },
                    },
                },
            },
            {
                height: 8,
                width: 12,
                type: 'metric',
                properties: {
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            {
                                expression: `(m500c${chainId} / mreqc${chainId}) * 100`,
                                label: `5XX Error Rate on ${ID_TO_NETWORK_NAME(chainId)}`,
                                id: `e1c${chainId}`,
                            },
                        ],
                        [
                            NAMESPACE,
                            `GET_QUOTE_REQUESTED_CHAINID: ${chainId}`,
                            'Service',
                            'RoutingAPI',
                            { id: `mreqc${chainId}`, label: `Requests on Chain ${chainId}`, visible: false },
                        ],
                        [
                            '.',
                            `GET_QUOTE_500_CHAINID: ${chainId}`,
                            '.',
                            '.',
                            { id: `m500c${chainId}`, label: `5XX Errors on Chain ${chainId}`, visible: false },
                        ],
                    ]),
                    view: 'timeSeries',
                    stacked: false,
                    region,
                    stat: 'Sum',
                    period: 300,
                    title: '5XX Error Rates by Chain',
                    setPeriodToTimeRange: true,
                    yAxis: {
                        left: {
                            showUnits: false,
                            label: '%',
                        },
                    },
                },
            },
            {
                height: 8,
                width: 12,
                type: 'metric',
                properties: {
                    metrics: _.flatMap(chains, (chainId) => [
                        [
                            {
                                expression: `(m400c${chainId} / mreqc${chainId}) * 100`,
                                label: `4XX Error Rate on ${ID_TO_NETWORK_NAME(chainId)}`,
                                id: `e2c${chainId}`,
                            },
                        ],
                        [
                            NAMESPACE,
                            `GET_QUOTE_REQUESTED_CHAINID: ${chainId}`,
                            'Service',
                            'RoutingAPI',
                            { id: `mreqc${chainId}`, label: `Requests on Chain ${chainId}`, visible: false },
                        ],
                        [
                            '.',
                            `GET_QUOTE_400_CHAINID: ${chainId}`,
                            '.',
                            '.',
                            { id: `m400c${chainId}`, label: `4XX Errors on Chain ${chainId}`, visible: false },
                        ],
                    ]),
                    view: 'timeSeries',
                    stacked: false,
                    region,
                    stat: 'Sum',
                    period: 300,
                    title: '4XX Error Rates by Chain',
                    setPeriodToTimeRange: true,
                    yAxis: {
                        left: {
                            showUnits: false,
                            label: '%',
                        },
                    },
                },
            },
        ]);
        const rpcProvidersWidgetsForRoutingDashboard = new RpcProvidersWidgetsFactory(NAMESPACE, region, MAINNETS.concat(TESTNETS)).generateWidgets();
        new aws_cloudwatch.CfnDashboard(this, 'RoutingAPIDashboard', {
            dashboardName: `RoutingDashboard`,
            dashboardBody: JSON.stringify({
                periodOverride: 'inherit',
                widgets: perChainWidgetsForRoutingDashboard
                    .concat([
                    {
                        height: 6,
                        width: 24,
                        type: 'metric',
                        properties: {
                            metrics: [
                                ['AWS/ApiGateway', 'Count', 'ApiName', apiName, { label: 'Requests' }],
                                ['.', '5XXError', '.', '.', { label: '5XXError Responses', color: '#ff7f0e' }],
                                ['.', '4XXError', '.', '.', { label: '4XXError Responses', color: '#2ca02c' }],
                            ],
                            view: 'timeSeries',
                            stacked: false,
                            region,
                            stat: 'Sum',
                            period: 300,
                            title: 'Total Requests/Responses',
                        },
                    },
                    {
                        height: 6,
                        width: 24,
                        type: 'metric',
                        properties: {
                            metrics: REQUEST_SOURCES.map((source) => [
                                'Uniswap',
                                `GET_QUOTE_REQUEST_SOURCE: ${source}`,
                                'Service',
                                'RoutingAPI',
                                { label: `${source}` },
                            ]),
                            view: 'timeSeries',
                            stacked: false,
                            region,
                            stat: 'Sum',
                            period: 300,
                            title: 'Requests by Source',
                        },
                    },
                    {
                        height: 6,
                        width: 24,
                        type: 'metric',
                        properties: {
                            metrics: [
                                [
                                    {
                                        expression: 'm1 * 100',
                                        label: '5XX Error Rate',
                                        id: 'e1',
                                        color: '#ff7f0e',
                                    },
                                ],
                                [
                                    {
                                        expression: 'm2 * 100',
                                        label: '4XX Error Rate',
                                        id: 'e2',
                                        color: '#2ca02c',
                                    },
                                ],
                                [
                                    'AWS/ApiGateway',
                                    '5XXError',
                                    'ApiName',
                                    'Routing API',
                                    { id: 'm1', label: '5XXError', visible: false },
                                ],
                                ['.', '4XXError', '.', '.', { id: 'm2', visible: false }],
                            ],
                            view: 'timeSeries',
                            stacked: false,
                            region,
                            stat: 'Average',
                            period: 300,
                            title: '5XX/4XX Error Rates',
                            setPeriodToTimeRange: true,
                            yAxis: {
                                left: {
                                    showUnits: false,
                                    label: '%',
                                },
                            },
                        },
                    },
                    {
                        height: 6,
                        width: 24,
                        type: 'metric',
                        properties: {
                            metrics: [['AWS/ApiGateway', 'Latency', 'ApiName', apiName]],
                            view: 'timeSeries',
                            stacked: false,
                            region,
                            period: 300,
                            stat: 'p90',
                            title: 'Latency p90',
                        },
                    },
                    {
                        type: 'metric',
                        width: 24,
                        height: 6,
                        properties: {
                            view: 'timeSeries',
                            stacked: false,
                            metrics: [
                                [NAMESPACE, 'QuotesFetched', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'V3QuotesFetched', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'V2QuotesFetched', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'MixedQuotesFetched', 'Service', 'RoutingAPI'],
                            ],
                            region,
                            title: 'p90 Quotes Fetched Per Swap',
                            period: 300,
                            stat: 'p90',
                        },
                    },
                    {
                        type: 'metric',
                        width: 24,
                        height: 6,
                        properties: {
                            view: 'timeSeries',
                            stacked: false,
                            insightRule: {
                                maxContributorCount: 25,
                                orderBy: 'Sum',
                                ruleName: REQUESTED_QUOTES_RULE_NAME,
                            },
                            legend: {
                                position: 'bottom',
                            },
                            region,
                            title: 'Requested Quotes',
                            period: 300,
                            stat: 'Sum',
                        },
                    },
                    {
                        type: 'metric',
                        width: 24,
                        height: 6,
                        properties: {
                            view: 'timeSeries',
                            stacked: false,
                            insightRule: {
                                maxContributorCount: 25,
                                orderBy: 'Sum',
                                ruleName: REQUESTED_QUOTES_BY_CHAIN_RULE_NAME,
                            },
                            legend: {
                                position: 'bottom',
                            },
                            region,
                            title: 'Requested Quotes By Chain',
                            period: 300,
                            stat: 'Sum',
                        },
                    },
                    {
                        type: 'metric',
                        width: 24,
                        height: 6,
                        properties: {
                            view: 'timeSeries',
                            stacked: false,
                            metrics: [
                                [NAMESPACE, 'MixedAndV3AndV2SplitRoute', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'MixedAndV3SplitRoute', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'MixedAndV2SplitRoute', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'MixedSplitRoute', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'MixedRoute', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'V3AndV2SplitRoute', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'V3SplitRoute', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'V3Route', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'V2SplitRoute', 'Service', 'RoutingAPI'],
                                [NAMESPACE, 'V2Route', 'Service', 'RoutingAPI'],
                            ],
                            region,
                            title: 'Types of routes returned across all chains',
                            period: 300,
                            stat: 'Sum',
                        },
                    },
                    {
                        type: 'metric',
                        width: 24,
                        height: 6,
                        properties: {
                            view: 'timeSeries',
                            stacked: false,
                            metrics: _.flatMap(SUPPORTED_CHAINS, (chainId) => [
                                [NAMESPACE, `MixedAndV3AndV2SplitRouteForChain${chainId}`, 'Service', 'RoutingAPI'],
                                [NAMESPACE, `MixedAndV3SplitRouteForChain${chainId}`, 'Service', 'RoutingAPI'],
                                [NAMESPACE, `MixedAndV2SplitRouteForChain${chainId}`, 'Service', 'RoutingAPI'],
                                [NAMESPACE, `MixedSplitRouteForChain${chainId}`, 'Service', 'RoutingAPI'],
                                [NAMESPACE, `MixedRouteForChain${chainId}`, 'Service', 'RoutingAPI'],
                                [NAMESPACE, `V3AndV2SplitRouteForChain${chainId}`, 'Service', 'RoutingAPI'],
                                [NAMESPACE, `V3SplitRouteForChain${chainId}`, 'Service', 'RoutingAPI'],
                                [NAMESPACE, `V3RouteForChain${chainId}`, 'Service', 'RoutingAPI'],
                                [NAMESPACE, `V2SplitRouteForChain${chainId}`, 'Service', 'RoutingAPI'],
                                [NAMESPACE, `V2RouteForChain${chainId}`, 'Service', 'RoutingAPI'],
                            ]),
                            region,
                            title: 'Types of V3 routes returned by chain',
                            period: 300,
                            stat: 'Sum',
                        },
                    },
                    {
                        type: 'metric',
                        width: 24,
                        height: 6,
                        properties: {
                            metrics: _.flatMap(SUPPORTED_CHAINS, (chainId) => [
                                ['Uniswap', `QuoteFoundForChain${chainId}`, 'Service', 'RoutingAPI'],
                                ['Uniswap', `QuoteRequestedForChain${chainId}`, 'Service', 'RoutingAPI'],
                            ]),
                            view: 'timeSeries',
                            stacked: false,
                            stat: 'Sum',
                            period: 300,
                            region,
                            title: 'Quote Requested/Found by Chain',
                        },
                    },
                    {
                        height: 12,
                        width: 24,
                        type: 'metric',
                        properties: {
                            metrics: [
                                [NAMESPACE, 'TokenListLoad', 'Service', 'RoutingAPI', { color: '#c5b0d5' }],
                                ['.', 'GasPriceLoad', '.', '.', { color: '#17becf' }],
                                ['.', 'V3PoolsLoad', '.', '.', { color: '#e377c2' }],
                                ['.', 'V2PoolsLoad', '.', '.', { color: '#e377c2' }],
                                ['.', 'V3SubgraphPoolsLoad', '.', '.', { color: '#1f77b4' }],
                                ['.', 'V2SubgraphPoolsLoad', '.', '.', { color: '#bf77b4' }],
                                ['.', 'V3QuotesLoad', '.', '.', { color: '#2ca02c' }],
                                ['.', 'MixedQuotesLoad', '.', '.', { color: '#fefa63' }],
                                ['.', 'V2QuotesLoad', '.', '.', { color: '#7f7f7f' }],
                                ['.', 'FindBestSwapRoute', '.', '.', { color: '#d62728' }],
                            ],
                            view: 'timeSeries',
                            stacked: true,
                            region,
                            stat: 'p90',
                            period: 300,
                            title: 'Latency Breakdown',
                        },
                    },
                    {
                        type: 'metric',
                        width: 24,
                        height: 9,
                        properties: {
                            view: 'timeSeries',
                            stacked: false,
                            metrics: [
                                [NAMESPACE, 'V3top2directswappool', 'Service', 'RoutingAPI'],
                                ['.', 'V3top2ethquotetokenpool', '.', '.'],
                                ['.', 'V3topbytvl', '.', '.'],
                                ['.', 'V3topbytvlusingtokenin', '.', '.'],
                                ['.', 'V3topbytvlusingtokeninsecondhops', '.', '.'],
                                ['.', 'V2topbytvlusingtokenout', '.', '.'],
                                ['.', 'V3topbytvlusingtokenoutsecondhops', '.', '.'],
                                ['.', 'V3topbybasewithtokenin', '.', '.'],
                                ['.', 'V3topbybasewithtokenout', '.', '.'],
                            ],
                            region: region,
                            title: 'p95 V3 Top N Pools Used From Sources in Best Route',
                            stat: 'p95',
                        },
                    },
                    {
                        type: 'metric',
                        width: 24,
                        height: 9,
                        properties: {
                            view: 'timeSeries',
                            stacked: false,
                            metrics: [
                                [NAMESPACE, 'V2top2directswappool', 'Service', 'RoutingAPI'],
                                ['.', 'V2top2ethquotetokenpool', '.', '.'],
                                ['.', 'V2topbytvl', '.', '.'],
                                ['.', 'V2topbytvlusingtokenin', '.', '.'],
                                ['.', 'V2topbytvlusingtokeninsecondhops', '.', '.'],
                                ['.', 'V2topbytvlusingtokenout', '.', '.'],
                                ['.', 'V2topbytvlusingtokenoutsecondhops', '.', '.'],
                                ['.', 'V2topbybasewithtokenin', '.', '.'],
                                ['.', 'V2topbybasewithtokenout', '.', '.'],
                            ],
                            region: region,
                            title: 'p95 V2 Top N Pools Used From Sources in Best Route',
                            stat: 'p95',
                        },
                    },
                    {
                        type: 'metric',
                        width: 24,
                        height: 9,
                        properties: {
                            view: 'timeSeries',
                            stacked: false,
                            metrics: [
                                ['AWS/Lambda', 'ProvisionedConcurrentExecutions', 'FunctionName', routingLambdaName],
                                ['.', 'ConcurrentExecutions', '.', '.'],
                                ['.', 'ProvisionedConcurrencySpilloverInvocations', '.', '.', { stat: 'Sum' }],
                            ],
                            region: region,
                            title: 'Routing Lambda Provisioned Concurrency',
                            stat: 'Maximum',
                        },
                    },
                    {
                        type: 'metric',
                        width: 24,
                        height: 9,
                        properties: {
                            view: 'timeSeries',
                            stacked: false,
                            metrics: [
                                ...poolCacheLambdaMetrics,
                                ...(ipfsPoolCacheLambdaName
                                    ? [
                                        ['AWS/Lambda', 'Errors', 'FunctionName', ipfsPoolCacheLambdaName],
                                        ['.', 'Invocations', '.', '.'],
                                    ]
                                    : []),
                            ],
                            region: region,
                            title: 'Pool Cache Lambda Error/Invocations',
                            stat: 'Sum',
                        },
                    },
                    {
                        height: 8,
                        width: 12,
                        type: 'metric',
                        properties: {
                            metrics: [
                                [
                                    {
                                        expression: `(m1 / m2) * 100`,
                                        label: `Tenderly Simulation API Success Rate by HTTP Status Code`,
                                        id: `tenderlySimulationHttpSuccessRate`,
                                    },
                                ],
                                [
                                    NAMESPACE,
                                    'TenderlySimulationUniversalRouterResponseStatus200',
                                    'Service',
                                    'RoutingAPI',
                                    { id: 'm1', visible: false },
                                ],
                                ['.', 'TenderlySimulationUniversalRouterRequests', '.', '.', { id: 'm2', visible: false }],
                            ],
                            view: 'timeSeries',
                            stacked: false,
                            region,
                            stat: 'Sum',
                            period: 300,
                            title: 'Tenderly Simulation API Success Rate by HTTP Status Code',
                            setPeriodToTimeRange: true,
                            yAxis: {
                                left: {
                                    showUnits: false,
                                    label: '%',
                                },
                            },
                        },
                    },
                ])
                    .concat(rpcProvidersWidgetsForRoutingDashboard),
            }),
        });
        const quoteAmountsWidgets = new QuoteAmountsWidgetsFactory(NAMESPACE, region);
        new aws_cloudwatch.CfnDashboard(this, 'RoutingAPITrackedPairsDashboard', {
            dashboardName: 'RoutingAPITrackedPairsDashboard',
            dashboardBody: JSON.stringify({
                periodOverride: 'inherit',
                widgets: quoteAmountsWidgets.generateWidgets(),
            }),
        });
        const cachedRoutesWidgets = new CachedRoutesWidgetsFactory(NAMESPACE, region, routingLambdaName);
        new aws_cloudwatch.CfnDashboard(this, 'CachedRoutesPerformanceDashboard', {
            dashboardName: 'CachedRoutesPerformanceDashboard',
            dashboardBody: JSON.stringify({
                periodOverride: 'inherit',
                widgets: cachedRoutesWidgets.generateWidgets(),
            }),
        });
        new aws_cloudwatch.CfnDashboard(this, 'RoutingAPIQuoteProviderDashboard', {
            dashboardName: `RoutingQuoteProviderDashboard`,
            dashboardBody: JSON.stringify({
                periodOverride: 'inherit',
                widgets: [
                    {
                        height: 6,
                        width: 24,
                        y: 0,
                        x: 0,
                        type: 'metric',
                        properties: {
                            metrics: [[NAMESPACE, 'QuoteApproxGasUsedPerSuccessfulCall', 'Service', 'RoutingAPI']],
                            view: 'timeSeries',
                            stacked: false,
                            region,
                            stat: 'Average',
                            period: 300,
                            title: 'Approx gas used by each call',
                        },
                    },
                    {
                        height: 6,
                        width: 24,
                        y: 6,
                        x: 0,
                        type: 'metric',
                        properties: {
                            metrics: [
                                [NAMESPACE, 'QuoteTotalCallsToProvider', 'Service', 'RoutingAPI'],
                                ['.', 'QuoteExpectedCallsToProvider', '.', '.'],
                                ['.', 'QuoteNumRetriedCalls', '.', '.'],
                                ['.', 'QuoteNumRetryLoops', '.', '.'],
                            ],
                            view: 'timeSeries',
                            stacked: false,
                            region,
                            stat: 'Average',
                            period: 300,
                            title: 'Number of retries to provider needed to get quote',
                        },
                    },
                    {
                        height: 6,
                        width: 24,
                        y: 12,
                        x: 0,
                        type: 'metric',
                        properties: {
                            metrics: [
                                [NAMESPACE, 'QuoteOutOfGasExceptionRetry', 'Service', 'RoutingAPI'],
                                ['.', 'QuoteSuccessRateRetry', '.', '.'],
                                ['.', 'QuoteBlockHeaderNotFoundRetry', '.', '.'],
                                ['.', 'QuoteTimeoutRetry', '.', '.'],
                                ['.', 'QuoteUnknownReasonRetry', '.', '.'],
                                ['.', 'QuoteBlockConflictErrorRetry', '.', '.'],
                            ],
                            view: 'timeSeries',
                            stacked: false,
                            region,
                            period: 300,
                            stat: 'Sum',
                            title: 'Number of requests that retried in the quote provider',
                        },
                    },
                ],
            }),
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicm91dGluZy1kYXNoYm9hcmQtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9iaW4vc3RhY2tzL3JvdXRpbmctZGFzaGJvYXJkLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQTtBQUMzQyxPQUFPLEtBQUssR0FBRyxNQUFNLGFBQWEsQ0FBQTtBQUNsQyxPQUFPLEtBQUssY0FBYyxNQUFNLDRCQUE0QixDQUFBO0FBRTVELE9BQU8sQ0FBQyxNQUFNLFFBQVEsQ0FBQTtBQUN0QixPQUFPLEVBQUUsMEJBQTBCLEVBQUUsTUFBTSxvREFBb0QsQ0FBQTtBQUMvRixPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxpQ0FBaUMsQ0FBQTtBQUNsRSxPQUFPLEVBQUUsMEJBQTBCLEVBQUUsTUFBTSxvREFBb0QsQ0FBQTtBQUMvRixPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxvREFBb0QsQ0FBQTtBQUN2RixPQUFPLEVBQUUsMEJBQTBCLEVBQUUsTUFBTSxvREFBb0QsQ0FBQTtBQUUvRixNQUFNLENBQUMsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFBO0FBa0JsQyxNQUFNLE9BQU8scUJBQXNCLFNBQVEsR0FBRyxDQUFDLFdBQVc7SUFDeEQsWUFBWSxLQUFnQixFQUFFLElBQVksRUFBRSxLQUE0QjtRQUN0RSxLQUFLLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsQ0FBQTtRQUV6QixNQUFNLEVBQUUsT0FBTyxFQUFFLGlCQUFpQixFQUFFLHdCQUF3QixFQUFFLHVCQUF1QixFQUFFLEdBQUcsS0FBSyxDQUFBO1FBQy9GLE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sQ0FBQTtRQUV4QyxNQUFNLFFBQVEsR0FBRztZQUNmLE9BQU8sQ0FBQyxlQUFlO1lBQ3ZCLE9BQU8s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OzRCQUNELElBQUksRUFBRSxZQUFZOzRCQUNsQixPQUFPLEVBQUUsS0FBSzs0QkFDZCxNQUFNOzRCQUNOLE1BQU0sRUFBRSxHQUFHOzRCQUNYLElBQUksRUFBRSxLQUFLOzRCQUNYLEtBQUssRUFBRSx1REFBdUQ7eUJBQy9EO3FCQUNGO2lCQUNGO2FBQ0YsQ0FBQztTQUNILENBQUMsQ0FBQTtJQUNKLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENoYWluSWQgfSBmcm9tICdAdW5pc3dhcC9zZGstY29yZSdcbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYidcbmltcG9ydCAqIGFzIGF3c19jbG91ZHdhdGNoIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoJ1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cydcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCdcbmltcG9ydCB7IFF1b3RlQW1vdW50c1dpZGdldHNGYWN0b3J5IH0gZnJvbSAnLi4vLi4vbGliL2Rhc2hib2FyZHMvcXVvdGUtYW1vdW50cy13aWRnZXRzLWZhY3RvcnknXG5pbXBvcnQgeyBTVVBQT1JURURfQ0hBSU5TIH0gZnJvbSAnLi4vLi4vbGliL2hhbmRsZXJzL2luamVjdG9yLXNvcidcbmltcG9ydCB7IENhY2hlZFJvdXRlc1dpZGdldHNGYWN0b3J5IH0gZnJvbSAnLi4vLi4vbGliL2Rhc2hib2FyZHMvY2FjaGVkLXJvdXRlcy13aWRnZXRzLWZhY3RvcnknXG5pbXBvcnQgeyBJRF9UT19ORVRXT1JLX05BTUUgfSBmcm9tICdAdW5pc3dhcC9zbWFydC1vcmRlci1yb3V0ZXIvYnVpbGQvbWFpbi91dGlsL2NoYWlucydcbmltcG9ydCB7IFJwY1Byb3ZpZGVyc1dpZGdldHNGYWN0b3J5IH0gZnJvbSAnLi4vLi4vbGliL2Rhc2hib2FyZHMvcnBjLXByb3ZpZGVycy13aWRnZXRzLWZhY3RvcnknXG5cbmV4cG9ydCBjb25zdCBOQU1FU1BBQ0UgPSAnVW5pc3dhcCdcblxuZXhwb3J0IHR5cGUgTGFtYmRhV2lkZ2V0ID0ge1xuICB0eXBlOiBzdHJpbmdcbiAgeDogbnVtYmVyXG4gIHk6IG51bWJlclxuICB3aWR0aDogbnVtYmVyXG4gIGhlaWdodDogbnVtYmVyXG4gIHByb3BlcnRpZXM6IHsgdmlldzogc3RyaW5nOyBzdGFja2VkOiBib29sZWFuOyBtZXRyaWNzOiBzdHJpbmdbXVtdOyByZWdpb246IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdDogc3RyaW5nIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBSb3V0aW5nRGFzaGJvYXJkUHJvcHMgZXh0ZW5kcyBjZGsuTmVzdGVkU3RhY2tQcm9wcyB7XG4gIGFwaU5hbWU6IHN0cmluZ1xuICByb3V0aW5nTGFtYmRhTmFtZTogc3RyaW5nXG4gIHBvb2xDYWNoZUxhbWJkYU5hbWVBcnJheTogc3RyaW5nW11cbiAgaXBmc1Bvb2xDYWNoZUxhbWJkYU5hbWU/OiBzdHJpbmdcbn1cblxuZXhwb3J0IGNsYXNzIFJvdXRpbmdEYXNoYm9hcmRTdGFjayBleHRlbmRzIGNkay5OZXN0ZWRTdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIG5hbWU6IHN0cmluZywgcHJvcHM6IFJvdXRpbmdEYXNoYm9hcmRQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBuYW1lLCBwcm9wcylcblxuICAgIGNvbnN0IHsgYXBpTmFtZSwgcm91dGluZ0xhbWJkYU5hbWUsIHBvb2xDYWNoZUxhbWJkYU5hbWVBcnJheSwgaXBmc1Bvb2xDYWNoZUxhbWJkYU5hbWUgfSA9IHByb3BzXG4gICAgY29uc3QgcmVnaW9uID0gY2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvblxuXG4gICAgY29uc3QgVEVTVE5FVFMgPSBbXG4gICAgICBDaGFpbklkLkFSQklUUlVNX0dPRVJMSSxcbiAgICAgIENoYWluSWQuUE9MWUdPTl9NVU1CQUksXG4gICAgICBDaGFpbklkLkJOQl9URVNUTkVULFxuICAgICAgQ2hhaW5JZC5HT0VSTEksXG4gICAgICBDaGFpbklkLlNFUE9MSUEsXG4gICAgICBDaGFpbklkLkNFTE9fQUxGQUpPUkVTLFxuICAgICAgQ2hhaW5JZC5CQVNFX0dPRVJMSSxcbiAgICBdXG5cbiAgICBjb25zdCBNQUlOTkVUUyA9IFNVUFBPUlRFRF9DSEFJTlMuZmlsdGVyKChjaGFpbikgPT4gIVRFU1RORVRTLmluY2x1ZGVzKGNoYWluKSlcblxuICAgIGNvbnN0IFJFUVVFU1RfU09VUkNFUyA9IFsndW5rbm93bicsICd1bmlzd2FwLWlvcycsICd1bmlzd2FwLWFuZHJvaWQnLCAndW5pc3dhcC13ZWInLCAnZXh0ZXJuYWwtYXBpJ11cblxuICAgIC8vIE5vIENESyByZXNvdXJjZSBleGlzdHMgZm9yIGNvbnRyaWJ1dG9yIGluc2lnaHRzIGF0IHRoZSBtb21lbnQgc28gdXNlIHJhdyBDbG91ZEZvcm1hdGlvbi5cbiAgICBjb25zdCBSRVFVRVNURURfUVVPVEVTX1JVTEVfTkFNRSA9ICdSZXF1ZXN0ZWRRdW90ZXMnXG4gICAgY29uc3QgUkVRVUVTVEVEX1FVT1RFU19CWV9DSEFJTl9SVUxFX05BTUUgPSAnUmVxdWVzdGVkUXVvdGVzQnlDaGFpbidcbiAgICBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdRdW90ZUNvbnRyaWJ1dG9ySW5zaWdodHMnLCB7XG4gICAgICB0eXBlOiAnQVdTOjpDbG91ZFdhdGNoOjpJbnNpZ2h0UnVsZScsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIFJ1bGVCb2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgU2NoZW1hOiB7XG4gICAgICAgICAgICBOYW1lOiAnQ2xvdWRXYXRjaExvZ1J1bGUnLFxuICAgICAgICAgICAgVmVyc2lvbjogMSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIEFnZ3JlZ2F0ZU9uOiAnQ291bnQnLFxuICAgICAgICAgIENvbnRyaWJ1dGlvbjoge1xuICAgICAgICAgICAgRmlsdGVyczogW1xuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgTWF0Y2g6ICckLnRva2VuUGFpclN5bWJvbCcsXG4gICAgICAgICAgICAgICAgSXNQcmVzZW50OiB0cnVlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIEtleXM6IFsnJC50b2tlblBhaXJTeW1ib2wnXSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIExvZ0Zvcm1hdDogJ0pTT04nLFxuICAgICAgICAgIExvZ0dyb3VwTmFtZXM6IFtgL2F3cy9sYW1iZGEvJHtyb3V0aW5nTGFtYmRhTmFtZX1gXSxcbiAgICAgICAgfSksXG4gICAgICAgIFJ1bGVOYW1lOiBSRVFVRVNURURfUVVPVEVTX1JVTEVfTkFNRSxcbiAgICAgICAgUnVsZVN0YXRlOiAnRU5BQkxFRCcsXG4gICAgICB9LFxuICAgIH0pXG5cbiAgICBuZXcgY2RrLkNmblJlc291cmNlKHRoaXMsICdRdW90ZUJ5Q2hhaW5Db250cmlidXRvckluc2lnaHRzJywge1xuICAgICAgdHlwZTogJ0FXUzo6Q2xvdWRXYXRjaDo6SW5zaWdodFJ1bGUnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBSdWxlQm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIFNjaGVtYToge1xuICAgICAgICAgICAgTmFtZTogJ0Nsb3VkV2F0Y2hMb2dSdWxlJyxcbiAgICAgICAgICAgIFZlcnNpb246IDEsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBBZ2dyZWdhdGVPbjogJ0NvdW50JyxcbiAgICAgICAgICBDb250cmlidXRpb246IHtcbiAgICAgICAgICAgIEZpbHRlcnM6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIE1hdGNoOiAnJC50b2tlblBhaXJTeW1ib2xDaGFpbicsXG4gICAgICAgICAgICAgICAgSXNQcmVzZW50OiB0cnVlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIEtleXM6IFsnJC50b2tlblBhaXJTeW1ib2xDaGFpbiddLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgTG9nRm9ybWF0OiAnSlNPTicsXG4gICAgICAgICAgTG9nR3JvdXBOYW1lczogW2AvYXdzL2xhbWJkYS8ke3JvdXRpbmdMYW1iZGFOYW1lfWBdLFxuICAgICAgICB9KSxcbiAgICAgICAgUnVsZU5hbWU6IFJFUVVFU1RFRF9RVU9URVNfQllfQ0hBSU5fUlVMRV9OQU1FLFxuICAgICAgICBSdWxlU3RhdGU6ICdFTkFCTEVEJyxcbiAgICAgIH0sXG4gICAgfSlcblxuICAgIGNvbnN0IHBvb2xDYWNoZUxhbWJkYU1ldHJpY3M6IHN0cmluZ1tdW10gPSBbXVxuICAgIHBvb2xDYWNoZUxhbWJkYU5hbWVBcnJheS5mb3JFYWNoKChwb29sQ2FjaGVMYW1iZGFOYW1lKSA9PiB7XG4gICAgICBwb29sQ2FjaGVMYW1iZGFNZXRyaWNzLnB1c2goWydBV1MvTGFtYmRhJywgYCR7cG9vbENhY2hlTGFtYmRhTmFtZX1FcnJvcnNgLCAnRnVuY3Rpb25OYW1lJywgcG9vbENhY2hlTGFtYmRhTmFtZV0pXG4gICAgICBwb29sQ2FjaGVMYW1iZGFNZXRyaWNzLnB1c2goWycuJywgYCR7cG9vbENhY2hlTGFtYmRhTmFtZX1JbnZvY2F0aW9uc2AsICcuJywgJy4nXSlcbiAgICB9KVxuXG4gICAgY29uc3QgcGVyQ2hhaW5XaWRnZXRzRm9yUm91dGluZ0Rhc2hib2FyZDogYW55W10gPSBfLmZsYXRNYXAoW01BSU5ORVRTLCBURVNUTkVUU10sIChjaGFpbnMpID0+IFtcbiAgICAgIHtcbiAgICAgICAgaGVpZ2h0OiA4LFxuICAgICAgICB3aWR0aDogMjQsXG4gICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgbWV0cmljczogY2hhaW5zLm1hcCgoY2hhaW5JZCkgPT4gW1xuICAgICAgICAgICAgTkFNRVNQQUNFLFxuICAgICAgICAgICAgYEdFVF9RVU9URV9SRVFVRVNURURfQ0hBSU5JRDogJHtjaGFpbklkfWAsXG4gICAgICAgICAgICAnU2VydmljZScsXG4gICAgICAgICAgICAnUm91dGluZ0FQSScsXG4gICAgICAgICAgICB7IGlkOiBgbXJlcWMke2NoYWluSWR9YCwgbGFiZWw6IGBSZXF1ZXN0cyBvbiAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX1gIH0sXG4gICAgICAgICAgXSksXG4gICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgIHJlZ2lvbixcbiAgICAgICAgICBzdGF0OiAnU3VtJyxcbiAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICB0aXRsZTogJ1JlcXVlc3RzIGJ5IENoYWluJyxcbiAgICAgICAgICBzZXRQZXJpb2RUb1RpbWVSYW5nZTogdHJ1ZSxcbiAgICAgICAgICB5QXhpczoge1xuICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICBzaG93VW5pdHM6IGZhbHNlLFxuICAgICAgICAgICAgICBsYWJlbDogJ1JlcXVlc3RzJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHR5cGU6ICd0ZXh0JyxcbiAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICBoZWlnaHQ6IDEsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICBtYXJrZG93bjogYCMgTGF0ZW5jaWVzIGZvciBJbnRlbnQ6IFF1b3RlYCxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogMTAsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgbWV0cmljczogXy5mbGF0TWFwKGNoYWlucywgKGNoYWluSWQpID0+IFtcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgTkFNRVNQQUNFLFxuICAgICAgICAgICAgICBgR0VUX1FVT1RFX0xBVEVOQ1lfQ0hBSU5fJHtjaGFpbklkfV9JTlRFTlRfcXVvdGVgLFxuICAgICAgICAgICAgICAnU2VydmljZScsXG4gICAgICAgICAgICAgICdSb3V0aW5nQVBJJyxcbiAgICAgICAgICAgICAgeyBzdGF0OiAncDk5Ljk5JywgbGFiZWw6IGAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX0gUDk5Ljk5YCB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFsnLi4uJywgeyBzdGF0OiAncDk5LjknLCBsYWJlbDogYCR7SURfVE9fTkVUV09SS19OQU1FKGNoYWluSWQpfSBQOTkuOWAgfV0sXG4gICAgICAgICAgICBbJy4uLicsIHsgc3RhdDogJ3A5OScsIGxhYmVsOiBgJHtJRF9UT19ORVRXT1JLX05BTUUoY2hhaW5JZCl9IFA5OWAgfV0sXG4gICAgICAgICAgXSksXG4gICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgIHRpdGxlOiBgUDk5LlggTGF0ZW5jeSBieSBDaGFpbmAsXG4gICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgc2V0UGVyaW9kVG9UaW1lUmFuZ2U6IHRydWUsXG4gICAgICAgICAgc3RhdDogJ1NhbXBsZUNvdW50JyxcbiAgICAgICAgICB5QXhpczoge1xuICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICBtaW46IDAsXG4gICAgICAgICAgICAgIHNob3dVbml0czogZmFsc2UsXG4gICAgICAgICAgICAgIGxhYmVsOiAnTWlsbGlzZWNvbmRzJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogMTAsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgbWV0cmljczogXy5mbGF0TWFwKGNoYWlucywgKGNoYWluSWQpID0+IFtcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgTkFNRVNQQUNFLFxuICAgICAgICAgICAgICBgR0VUX1FVT1RFX0xBVEVOQ1lfQ0hBSU5fJHtjaGFpbklkfV9JTlRFTlRfcXVvdGVgLFxuICAgICAgICAgICAgICAnU2VydmljZScsXG4gICAgICAgICAgICAgICdSb3V0aW5nQVBJJyxcbiAgICAgICAgICAgICAgeyBzdGF0OiAncDk1JywgbGFiZWw6IGAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX0gUDk1YCB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFsnLi4uJywgeyBzdGF0OiAncDkwJywgbGFiZWw6IGAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX0gUDkwYCB9XSxcbiAgICAgICAgICBdKSxcbiAgICAgICAgICByZWdpb24sXG4gICAgICAgICAgdGl0bGU6IGBQOTUgJiBQOTAgTGF0ZW5jeSBieSBDaGFpbmAsXG4gICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgc2V0UGVyaW9kVG9UaW1lUmFuZ2U6IHRydWUsXG4gICAgICAgICAgc3RhdDogJ1NhbXBsZUNvdW50JyxcbiAgICAgICAgICB5QXhpczoge1xuICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICBtaW46IDAsXG4gICAgICAgICAgICAgIHNob3dVbml0czogZmFsc2UsXG4gICAgICAgICAgICAgIGxhYmVsOiAnTWlsbGlzZWNvbmRzJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogMTAsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgbWV0cmljczogXy5mbGF0TWFwKGNoYWlucywgKGNoYWluSWQpID0+IFtcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgTkFNRVNQQUNFLFxuICAgICAgICAgICAgICBgR0VUX1FVT1RFX0xBVEVOQ1lfQ0hBSU5fJHtjaGFpbklkfV9JTlRFTlRfcXVvdGVgLFxuICAgICAgICAgICAgICAnU2VydmljZScsXG4gICAgICAgICAgICAgICdSb3V0aW5nQVBJJyxcbiAgICAgICAgICAgICAgeyBzdGF0OiAncDUwJywgbGFiZWw6IGAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX0gTWVkaWFuYCB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFsnLi4uJywgeyBzdGF0OiAnQXZlcmFnZScsIGxhYmVsOiBgJHtJRF9UT19ORVRXT1JLX05BTUUoY2hhaW5JZCl9IEF2ZXJhZ2VgIH1dLFxuICAgICAgICAgIF0pLFxuICAgICAgICAgIHJlZ2lvbixcbiAgICAgICAgICB0aXRsZTogYEF2ZXJhZ2UgYW5kIE1lZGlhbiBMYXRlbmN5IGJ5IENoYWluYCxcbiAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICBzZXRQZXJpb2RUb1RpbWVSYW5nZTogdHJ1ZSxcbiAgICAgICAgICBzdGF0OiAnU2FtcGxlQ291bnQnLFxuICAgICAgICAgIHlBeGlzOiB7XG4gICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgIG1pbjogMCxcbiAgICAgICAgICAgICAgc2hvd1VuaXRzOiBmYWxzZSxcbiAgICAgICAgICAgICAgbGFiZWw6ICdNaWxsaXNlY29uZHMnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgaGVpZ2h0OiAxMCxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICBtZXRyaWNzOiBfLmZsYXRNYXAoY2hhaW5zLCAoY2hhaW5JZCkgPT4gW1xuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICBOQU1FU1BBQ0UsXG4gICAgICAgICAgICAgIGBHRVRfUVVPVEVfTEFURU5DWV9DSEFJTl8ke2NoYWluSWR9X0lOVEVOVF9xdW90ZWAsXG4gICAgICAgICAgICAgICdTZXJ2aWNlJyxcbiAgICAgICAgICAgICAgJ1JvdXRpbmdBUEknLFxuICAgICAgICAgICAgICB7IHN0YXQ6ICdNaW5pbXVtJywgbGFiZWw6IGAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX0gTWluaW11bWAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgXSksXG4gICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgIHRpdGxlOiBgTWluaW11bSBMYXRlbmN5IGJ5IENoYWluYCxcbiAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICBzZXRQZXJpb2RUb1RpbWVSYW5nZTogdHJ1ZSxcbiAgICAgICAgICBzdGF0OiAnU2FtcGxlQ291bnQnLFxuICAgICAgICAgIHlBeGlzOiB7XG4gICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgIG1pbjogMCxcbiAgICAgICAgICAgICAgc2hvd1VuaXRzOiBmYWxzZSxcbiAgICAgICAgICAgICAgbGFiZWw6ICdNaWxsaXNlY29uZHMnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgdHlwZTogJ3RleHQnLFxuICAgICAgICB3aWR0aDogMjQsXG4gICAgICAgIGhlaWdodDogMSxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgIG1hcmtkb3duOiBgIyBMYXRlbmNpZXMgZm9yIEludGVudDogQ2FjaGluZ2AsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgd2lkdGg6IDEyLFxuICAgICAgICBoZWlnaHQ6IDEwLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgIG1ldHJpY3M6IF8uZmxhdE1hcChjaGFpbnMsIChjaGFpbklkKSA9PiBbXG4gICAgICAgICAgICBbXG4gICAgICAgICAgICAgIE5BTUVTUEFDRSxcbiAgICAgICAgICAgICAgYEdFVF9RVU9URV9MQVRFTkNZX0NIQUlOXyR7Y2hhaW5JZH1fSU5URU5UX2NhY2hpbmdgLFxuICAgICAgICAgICAgICAnU2VydmljZScsXG4gICAgICAgICAgICAgICdSb3V0aW5nQVBJJyxcbiAgICAgICAgICAgICAgeyBzdGF0OiAncDk5Ljk5JywgbGFiZWw6IGAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX0gUDk5Ljk5YCB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFsnLi4uJywgeyBzdGF0OiAncDk5LjknLCBsYWJlbDogYCR7SURfVE9fTkVUV09SS19OQU1FKGNoYWluSWQpfSBQOTkuOWAgfV0sXG4gICAgICAgICAgICBbJy4uLicsIHsgc3RhdDogJ3A5OScsIGxhYmVsOiBgJHtJRF9UT19ORVRXT1JLX05BTUUoY2hhaW5JZCl9IFA5OWAgfV0sXG4gICAgICAgICAgXSksXG4gICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgIHRpdGxlOiBgUDk5LlggTGF0ZW5jeSBieSBDaGFpbmAsXG4gICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgc2V0UGVyaW9kVG9UaW1lUmFuZ2U6IHRydWUsXG4gICAgICAgICAgc3RhdDogJ1NhbXBsZUNvdW50JyxcbiAgICAgICAgICB5QXhpczoge1xuICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICBtaW46IDAsXG4gICAgICAgICAgICAgIHNob3dVbml0czogZmFsc2UsXG4gICAgICAgICAgICAgIGxhYmVsOiAnTWlsbGlzZWNvbmRzJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogMTAsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgbWV0cmljczogXy5mbGF0TWFwKGNoYWlucywgKGNoYWluSWQpID0+IFtcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgTkFNRVNQQUNFLFxuICAgICAgICAgICAgICBgR0VUX1FVT1RFX0xBVEVOQ1lfQ0hBSU5fJHtjaGFpbklkfV9JTlRFTlRfY2FjaGluZ2AsXG4gICAgICAgICAgICAgICdTZXJ2aWNlJyxcbiAgICAgICAgICAgICAgJ1JvdXRpbmdBUEknLFxuICAgICAgICAgICAgICB7IHN0YXQ6ICdwOTUnLCBsYWJlbDogYCR7SURfVE9fTkVUV09SS19OQU1FKGNoYWluSWQpfSBQOTVgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgWycuLi4nLCB7IHN0YXQ6ICdwOTAnLCBsYWJlbDogYCR7SURfVE9fTkVUV09SS19OQU1FKGNoYWluSWQpfSBQOTBgIH1dLFxuICAgICAgICAgIF0pLFxuICAgICAgICAgIHJlZ2lvbixcbiAgICAgICAgICB0aXRsZTogYFA5NSAmIFA5MCBMYXRlbmN5IGJ5IENoYWluYCxcbiAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICBzZXRQZXJpb2RUb1RpbWVSYW5nZTogdHJ1ZSxcbiAgICAgICAgICBzdGF0OiAnU2FtcGxlQ291bnQnLFxuICAgICAgICAgIHlBeGlzOiB7XG4gICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgIG1pbjogMCxcbiAgICAgICAgICAgICAgc2hvd1VuaXRzOiBmYWxzZSxcbiAgICAgICAgICAgICAgbGFiZWw6ICdNaWxsaXNlY29uZHMnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgaGVpZ2h0OiAxMCxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICBtZXRyaWNzOiBfLmZsYXRNYXAoY2hhaW5zLCAoY2hhaW5JZCkgPT4gW1xuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICBOQU1FU1BBQ0UsXG4gICAgICAgICAgICAgIGBHRVRfUVVPVEVfTEFURU5DWV9DSEFJTl8ke2NoYWluSWR9X0lOVEVOVF9jYWNoaW5nYCxcbiAgICAgICAgICAgICAgJ1NlcnZpY2UnLFxuICAgICAgICAgICAgICAnUm91dGluZ0FQSScsXG4gICAgICAgICAgICAgIHsgc3RhdDogJ3A1MCcsIGxhYmVsOiBgJHtJRF9UT19ORVRXT1JLX05BTUUoY2hhaW5JZCl9IE1lZGlhbmAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBbJy4uLicsIHsgc3RhdDogJ0F2ZXJhZ2UnLCBsYWJlbDogYCR7SURfVE9fTkVUV09SS19OQU1FKGNoYWluSWQpfSBBdmVyYWdlYCB9XSxcbiAgICAgICAgICBdKSxcbiAgICAgICAgICByZWdpb24sXG4gICAgICAgICAgdGl0bGU6IGBBdmVyYWdlIGFuZCBNZWRpYW4gTGF0ZW5jeSBieSBDaGFpbmAsXG4gICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgc2V0UGVyaW9kVG9UaW1lUmFuZ2U6IHRydWUsXG4gICAgICAgICAgc3RhdDogJ1NhbXBsZUNvdW50JyxcbiAgICAgICAgICB5QXhpczoge1xuICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICBtaW46IDAsXG4gICAgICAgICAgICAgIHNob3dVbml0czogZmFsc2UsXG4gICAgICAgICAgICAgIGxhYmVsOiAnTWlsbGlzZWNvbmRzJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogMTAsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgbWV0cmljczogXy5mbGF0TWFwKGNoYWlucywgKGNoYWluSWQpID0+IFtcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgTkFNRVNQQUNFLFxuICAgICAgICAgICAgICBgR0VUX1FVT1RFX0xBVEVOQ1lfQ0hBSU5fJHtjaGFpbklkfV9JTlRFTlRfY2FjaGluZ2AsXG4gICAgICAgICAgICAgICdTZXJ2aWNlJyxcbiAgICAgICAgICAgICAgJ1JvdXRpbmdBUEknLFxuICAgICAgICAgICAgICB7IHN0YXQ6ICdNaW5pbXVtJywgbGFiZWw6IGAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX0gTWluaW11bWAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgXSksXG4gICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgIHRpdGxlOiBgTWluaW11bSBMYXRlbmN5IGJ5IENoYWluYCxcbiAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICBzZXRQZXJpb2RUb1RpbWVSYW5nZTogdHJ1ZSxcbiAgICAgICAgICBzdGF0OiAnU2FtcGxlQ291bnQnLFxuICAgICAgICAgIHlBeGlzOiB7XG4gICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgIG1pbjogMCxcbiAgICAgICAgICAgICAgc2hvd1VuaXRzOiBmYWxzZSxcbiAgICAgICAgICAgICAgbGFiZWw6ICdNaWxsaXNlY29uZHMnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaGVpZ2h0OiA4LFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgbWV0cmljczogXy5mbGF0TWFwKGNoYWlucywgKGNoYWluSWQpID0+IFtcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIGV4cHJlc3Npb246IGAobTIwMGMke2NoYWluSWR9IC8gKG1yZXFjJHtjaGFpbklkfSAtIG00MDBjJHtjaGFpbklkfSkpICogMTAwYCxcbiAgICAgICAgICAgICAgICBsYWJlbDogYFN1Y2Nlc3MgUmF0ZSBvbiAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX1gLFxuICAgICAgICAgICAgICAgIGlkOiBgZTFjJHtjaGFpbklkfWAsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICBOQU1FU1BBQ0UsXG4gICAgICAgICAgICAgIGBHRVRfUVVPVEVfUkVRVUVTVEVEX0NIQUlOSUQ6ICR7Y2hhaW5JZH1gLFxuICAgICAgICAgICAgICAnU2VydmljZScsXG4gICAgICAgICAgICAgICdSb3V0aW5nQVBJJyxcbiAgICAgICAgICAgICAgeyBpZDogYG1yZXFjJHtjaGFpbklkfWAsIGxhYmVsOiBgUmVxdWVzdHMgb24gQ2hhaW4gJHtjaGFpbklkfWAsIHZpc2libGU6IGZhbHNlIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAnLicsXG4gICAgICAgICAgICAgIGBHRVRfUVVPVEVfMjAwX0NIQUlOSUQ6ICR7Y2hhaW5JZH1gLFxuICAgICAgICAgICAgICAnLicsXG4gICAgICAgICAgICAgICcuJyxcbiAgICAgICAgICAgICAgeyBpZDogYG0yMDBjJHtjaGFpbklkfWAsIGxhYmVsOiBgMlhYIFJlcXVlc3RzIG9uIENoYWluICR7Y2hhaW5JZH1gLCB2aXNpYmxlOiBmYWxzZSB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgJy4nLFxuICAgICAgICAgICAgICBgR0VUX1FVT1RFXzQwMF9DSEFJTklEOiAke2NoYWluSWR9YCxcbiAgICAgICAgICAgICAgJy4nLFxuICAgICAgICAgICAgICAnLicsXG4gICAgICAgICAgICAgIHsgaWQ6IGBtNDAwYyR7Y2hhaW5JZH1gLCBsYWJlbDogYDRYWCBFcnJvcnMgb24gQ2hhaW4gJHtjaGFpbklkfWAsIHZpc2libGU6IGZhbHNlIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIF0pLFxuICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICByZWdpb24sXG4gICAgICAgICAgc3RhdDogJ1N1bScsXG4gICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgdGl0bGU6ICdTdWNjZXNzIFJhdGVzIGJ5IENoYWluJyxcbiAgICAgICAgICBzZXRQZXJpb2RUb1RpbWVSYW5nZTogdHJ1ZSxcbiAgICAgICAgICB5QXhpczoge1xuICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICBzaG93VW5pdHM6IGZhbHNlLFxuICAgICAgICAgICAgICBsYWJlbDogJyUnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaGVpZ2h0OiA4LFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgbWV0cmljczogXy5mbGF0TWFwKGNoYWlucywgKGNoYWluSWQpID0+IFtcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIGV4cHJlc3Npb246IGAobTIwMGMke2NoYWluSWR9IC8gbXJlcWMke2NoYWluSWR9KSAqIDEwMGAsXG4gICAgICAgICAgICAgICAgbGFiZWw6IGBTdWNjZXNzIFJhdGUgKHcuIDRYWCkgb24gJHtJRF9UT19ORVRXT1JLX05BTUUoY2hhaW5JZCl9YCxcbiAgICAgICAgICAgICAgICBpZDogYGUxYyR7Y2hhaW5JZH1gLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgTkFNRVNQQUNFLFxuICAgICAgICAgICAgICBgR0VUX1FVT1RFX1JFUVVFU1RFRF9DSEFJTklEOiAke2NoYWluSWR9YCxcbiAgICAgICAgICAgICAgJ1NlcnZpY2UnLFxuICAgICAgICAgICAgICAnUm91dGluZ0FQSScsXG4gICAgICAgICAgICAgIHsgaWQ6IGBtcmVxYyR7Y2hhaW5JZH1gLCBsYWJlbDogYFJlcXVlc3RzIG9uIENoYWluICR7Y2hhaW5JZH1gLCB2aXNpYmxlOiBmYWxzZSB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgJy4nLFxuICAgICAgICAgICAgICBgR0VUX1FVT1RFXzIwMF9DSEFJTklEOiAke2NoYWluSWR9YCxcbiAgICAgICAgICAgICAgJy4nLFxuICAgICAgICAgICAgICAnLicsXG4gICAgICAgICAgICAgIHsgaWQ6IGBtMjAwYyR7Y2hhaW5JZH1gLCBsYWJlbDogYDJYWCBSZXF1ZXN0cyBvbiBDaGFpbiAke2NoYWluSWR9YCwgdmlzaWJsZTogZmFsc2UgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgXSksXG4gICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgIHJlZ2lvbixcbiAgICAgICAgICBzdGF0OiAnU3VtJyxcbiAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICB0aXRsZTogJ1N1Y2Nlc3MgUmF0ZXMgKHcuIDRYWCkgYnkgQ2hhaW4nLFxuICAgICAgICAgIHNldFBlcmlvZFRvVGltZVJhbmdlOiB0cnVlLFxuICAgICAgICAgIHlBeGlzOiB7XG4gICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgIHNob3dVbml0czogZmFsc2UsXG4gICAgICAgICAgICAgIGxhYmVsOiAnJScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBoZWlnaHQ6IDgsXG4gICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICBtZXRyaWNzOiBfLmZsYXRNYXAoY2hhaW5zLCAoY2hhaW5JZCkgPT4gW1xuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgZXhwcmVzc2lvbjogYChtNTAwYyR7Y2hhaW5JZH0gLyBtcmVxYyR7Y2hhaW5JZH0pICogMTAwYCxcbiAgICAgICAgICAgICAgICBsYWJlbDogYDVYWCBFcnJvciBSYXRlIG9uICR7SURfVE9fTkVUV09SS19OQU1FKGNoYWluSWQpfWAsXG4gICAgICAgICAgICAgICAgaWQ6IGBlMWMke2NoYWluSWR9YCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBbXG4gICAgICAgICAgICAgIE5BTUVTUEFDRSxcbiAgICAgICAgICAgICAgYEdFVF9RVU9URV9SRVFVRVNURURfQ0hBSU5JRDogJHtjaGFpbklkfWAsXG4gICAgICAgICAgICAgICdTZXJ2aWNlJyxcbiAgICAgICAgICAgICAgJ1JvdXRpbmdBUEknLFxuICAgICAgICAgICAgICB7IGlkOiBgbXJlcWMke2NoYWluSWR9YCwgbGFiZWw6IGBSZXF1ZXN0cyBvbiBDaGFpbiAke2NoYWluSWR9YCwgdmlzaWJsZTogZmFsc2UgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBbXG4gICAgICAgICAgICAgICcuJyxcbiAgICAgICAgICAgICAgYEdFVF9RVU9URV81MDBfQ0hBSU5JRDogJHtjaGFpbklkfWAsXG4gICAgICAgICAgICAgICcuJyxcbiAgICAgICAgICAgICAgJy4nLFxuICAgICAgICAgICAgICB7IGlkOiBgbTUwMGMke2NoYWluSWR9YCwgbGFiZWw6IGA1WFggRXJyb3JzIG9uIENoYWluICR7Y2hhaW5JZH1gLCB2aXNpYmxlOiBmYWxzZSB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICBdKSxcbiAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgIHN0YXQ6ICdTdW0nLFxuICAgICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgICAgIHRpdGxlOiAnNVhYIEVycm9yIFJhdGVzIGJ5IENoYWluJyxcbiAgICAgICAgICBzZXRQZXJpb2RUb1RpbWVSYW5nZTogdHJ1ZSxcbiAgICAgICAgICB5QXhpczoge1xuICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICBzaG93VW5pdHM6IGZhbHNlLFxuICAgICAgICAgICAgICBsYWJlbDogJyUnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaGVpZ2h0OiA4LFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgbWV0cmljczogXy5mbGF0TWFwKGNoYWlucywgKGNoYWluSWQpID0+IFtcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIGV4cHJlc3Npb246IGAobTQwMGMke2NoYWluSWR9IC8gbXJlcWMke2NoYWluSWR9KSAqIDEwMGAsXG4gICAgICAgICAgICAgICAgbGFiZWw6IGA0WFggRXJyb3IgUmF0ZSBvbiAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX1gLFxuICAgICAgICAgICAgICAgIGlkOiBgZTJjJHtjaGFpbklkfWAsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICBOQU1FU1BBQ0UsXG4gICAgICAgICAgICAgIGBHRVRfUVVPVEVfUkVRVUVTVEVEX0NIQUlOSUQ6ICR7Y2hhaW5JZH1gLFxuICAgICAgICAgICAgICAnU2VydmljZScsXG4gICAgICAgICAgICAgICdSb3V0aW5nQVBJJyxcbiAgICAgICAgICAgICAgeyBpZDogYG1yZXFjJHtjaGFpbklkfWAsIGxhYmVsOiBgUmVxdWVzdHMgb24gQ2hhaW4gJHtjaGFpbklkfWAsIHZpc2libGU6IGZhbHNlIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAnLicsXG4gICAgICAgICAgICAgIGBHRVRfUVVPVEVfNDAwX0NIQUlOSUQ6ICR7Y2hhaW5JZH1gLFxuICAgICAgICAgICAgICAnLicsXG4gICAgICAgICAgICAgICcuJyxcbiAgICAgICAgICAgICAgeyBpZDogYG00MDBjJHtjaGFpbklkfWAsIGxhYmVsOiBgNFhYIEVycm9ycyBvbiBDaGFpbiAke2NoYWluSWR9YCwgdmlzaWJsZTogZmFsc2UgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgXSksXG4gICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgIHJlZ2lvbixcbiAgICAgICAgICBzdGF0OiAnU3VtJyxcbiAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICB0aXRsZTogJzRYWCBFcnJvciBSYXRlcyBieSBDaGFpbicsXG4gICAgICAgICAgc2V0UGVyaW9kVG9UaW1lUmFuZ2U6IHRydWUsXG4gICAgICAgICAgeUF4aXM6IHtcbiAgICAgICAgICAgIGxlZnQ6IHtcbiAgICAgICAgICAgICAgc2hvd1VuaXRzOiBmYWxzZSxcbiAgICAgICAgICAgICAgbGFiZWw6ICclJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgXSlcblxuICAgIGNvbnN0IHJwY1Byb3ZpZGVyc1dpZGdldHNGb3JSb3V0aW5nRGFzaGJvYXJkID0gbmV3IFJwY1Byb3ZpZGVyc1dpZGdldHNGYWN0b3J5KFxuICAgICAgTkFNRVNQQUNFLFxuICAgICAgcmVnaW9uLFxuICAgICAgTUFJTk5FVFMuY29uY2F0KFRFU1RORVRTKVxuICAgICkuZ2VuZXJhdGVXaWRnZXRzKClcblxuICAgIG5ldyBhd3NfY2xvdWR3YXRjaC5DZm5EYXNoYm9hcmQodGhpcywgJ1JvdXRpbmdBUElEYXNoYm9hcmQnLCB7XG4gICAgICBkYXNoYm9hcmROYW1lOiBgUm91dGluZ0Rhc2hib2FyZGAsXG4gICAgICBkYXNoYm9hcmRCb2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHBlcmlvZE92ZXJyaWRlOiAnaW5oZXJpdCcsXG4gICAgICAgIHdpZGdldHM6IHBlckNoYWluV2lkZ2V0c0ZvclJvdXRpbmdEYXNoYm9hcmRcbiAgICAgICAgICAuY29uY2F0KFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgaGVpZ2h0OiA2LFxuICAgICAgICAgICAgICB3aWR0aDogMjQsXG4gICAgICAgICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgICAgbWV0cmljczogW1xuICAgICAgICAgICAgICAgICAgWydBV1MvQXBpR2F0ZXdheScsICdDb3VudCcsICdBcGlOYW1lJywgYXBpTmFtZSwgeyBsYWJlbDogJ1JlcXVlc3RzJyB9XSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICc1WFhFcnJvcicsICcuJywgJy4nLCB7IGxhYmVsOiAnNVhYRXJyb3IgUmVzcG9uc2VzJywgY29sb3I6ICcjZmY3ZjBlJyB9XSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICc0WFhFcnJvcicsICcuJywgJy4nLCB7IGxhYmVsOiAnNFhYRXJyb3IgUmVzcG9uc2VzJywgY29sb3I6ICcjMmNhMDJjJyB9XSxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICByZWdpb24sXG4gICAgICAgICAgICAgICAgc3RhdDogJ1N1bScsXG4gICAgICAgICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgICAgICAgdGl0bGU6ICdUb3RhbCBSZXF1ZXN0cy9SZXNwb25zZXMnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgaGVpZ2h0OiA2LFxuICAgICAgICAgICAgICB3aWR0aDogMjQsXG4gICAgICAgICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgICAgbWV0cmljczogUkVRVUVTVF9TT1VSQ0VTLm1hcCgoc291cmNlKSA9PiBbXG4gICAgICAgICAgICAgICAgICAnVW5pc3dhcCcsXG4gICAgICAgICAgICAgICAgICBgR0VUX1FVT1RFX1JFUVVFU1RfU09VUkNFOiAke3NvdXJjZX1gLFxuICAgICAgICAgICAgICAgICAgJ1NlcnZpY2UnLFxuICAgICAgICAgICAgICAgICAgJ1JvdXRpbmdBUEknLFxuICAgICAgICAgICAgICAgICAgeyBsYWJlbDogYCR7c291cmNlfWAgfSxcbiAgICAgICAgICAgICAgICBdKSxcbiAgICAgICAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgICAgICAgIHN0YXQ6ICdTdW0nLFxuICAgICAgICAgICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgICAgICAgICAgIHRpdGxlOiAnUmVxdWVzdHMgYnkgU291cmNlJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGhlaWdodDogNixcbiAgICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgICAgIG1ldHJpY3M6IFtcbiAgICAgICAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgIGV4cHJlc3Npb246ICdtMSAqIDEwMCcsXG4gICAgICAgICAgICAgICAgICAgICAgbGFiZWw6ICc1WFggRXJyb3IgUmF0ZScsXG4gICAgICAgICAgICAgICAgICAgICAgaWQ6ICdlMScsXG4gICAgICAgICAgICAgICAgICAgICAgY29sb3I6ICcjZmY3ZjBlJyxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICBbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICBleHByZXNzaW9uOiAnbTIgKiAxMDAnLFxuICAgICAgICAgICAgICAgICAgICAgIGxhYmVsOiAnNFhYIEVycm9yIFJhdGUnLFxuICAgICAgICAgICAgICAgICAgICAgIGlkOiAnZTInLFxuICAgICAgICAgICAgICAgICAgICAgIGNvbG9yOiAnIzJjYTAyYycsXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAgICAgICAnQVdTL0FwaUdhdGV3YXknLFxuICAgICAgICAgICAgICAgICAgICAnNVhYRXJyb3InLFxuICAgICAgICAgICAgICAgICAgICAnQXBpTmFtZScsXG4gICAgICAgICAgICAgICAgICAgICdSb3V0aW5nIEFQSScsXG4gICAgICAgICAgICAgICAgICAgIHsgaWQ6ICdtMScsIGxhYmVsOiAnNVhYRXJyb3InLCB2aXNpYmxlOiBmYWxzZSB9LFxuICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICc0WFhFcnJvcicsICcuJywgJy4nLCB7IGlkOiAnbTInLCB2aXNpYmxlOiBmYWxzZSB9XSxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICByZWdpb24sXG4gICAgICAgICAgICAgICAgc3RhdDogJ0F2ZXJhZ2UnLFxuICAgICAgICAgICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgICAgICAgICAgIHRpdGxlOiAnNVhYLzRYWCBFcnJvciBSYXRlcycsXG4gICAgICAgICAgICAgICAgc2V0UGVyaW9kVG9UaW1lUmFuZ2U6IHRydWUsXG4gICAgICAgICAgICAgICAgeUF4aXM6IHtcbiAgICAgICAgICAgICAgICAgIGxlZnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgc2hvd1VuaXRzOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgbGFiZWw6ICclJyxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGhlaWdodDogNixcbiAgICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgICAgIG1ldHJpY3M6IFtbJ0FXUy9BcGlHYXRld2F5JywgJ0xhdGVuY3knLCAnQXBpTmFtZScsIGFwaU5hbWVdXSxcbiAgICAgICAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgICAgICAgICAgIHN0YXQ6ICdwOTAnLFxuICAgICAgICAgICAgICAgIHRpdGxlOiAnTGF0ZW5jeSBwOTAnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgICAgICAgIHdpZHRoOiAyNCxcbiAgICAgICAgICAgICAgaGVpZ2h0OiA2LFxuICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgIG1ldHJpY3M6IFtcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsICdRdW90ZXNGZXRjaGVkJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgJ1YzUXVvdGVzRmV0Y2hlZCcsICdTZXJ2aWNlJywgJ1JvdXRpbmdBUEknXSxcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsICdWMlF1b3Rlc0ZldGNoZWQnLCAnU2VydmljZScsICdSb3V0aW5nQVBJJ10sXG4gICAgICAgICAgICAgICAgICBbTkFNRVNQQUNFLCAnTWl4ZWRRdW90ZXNGZXRjaGVkJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgICAgICAgIHRpdGxlOiAncDkwIFF1b3RlcyBGZXRjaGVkIFBlciBTd2FwJyxcbiAgICAgICAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICAgICAgICBzdGF0OiAncDkwJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICAgICAgICB3aWR0aDogMjQsXG4gICAgICAgICAgICAgIGhlaWdodDogNixcbiAgICAgICAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBpbnNpZ2h0UnVsZToge1xuICAgICAgICAgICAgICAgICAgbWF4Q29udHJpYnV0b3JDb3VudDogMjUsXG4gICAgICAgICAgICAgICAgICBvcmRlckJ5OiAnU3VtJyxcbiAgICAgICAgICAgICAgICAgIHJ1bGVOYW1lOiBSRVFVRVNURURfUVVPVEVTX1JVTEVfTkFNRSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGxlZ2VuZDoge1xuICAgICAgICAgICAgICAgICAgcG9zaXRpb246ICdib3R0b20nLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgICAgICAgIHRpdGxlOiAnUmVxdWVzdGVkIFF1b3RlcycsXG4gICAgICAgICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgICAgICAgc3RhdDogJ1N1bScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgICAgICBoZWlnaHQ6IDYsXG4gICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgaW5zaWdodFJ1bGU6IHtcbiAgICAgICAgICAgICAgICAgIG1heENvbnRyaWJ1dG9yQ291bnQ6IDI1LFxuICAgICAgICAgICAgICAgICAgb3JkZXJCeTogJ1N1bScsXG4gICAgICAgICAgICAgICAgICBydWxlTmFtZTogUkVRVUVTVEVEX1FVT1RFU19CWV9DSEFJTl9SVUxFX05BTUUsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBsZWdlbmQ6IHtcbiAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiAnYm90dG9tJyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHJlZ2lvbixcbiAgICAgICAgICAgICAgICB0aXRsZTogJ1JlcXVlc3RlZCBRdW90ZXMgQnkgQ2hhaW4nLFxuICAgICAgICAgICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgICAgICAgICAgIHN0YXQ6ICdTdW0nLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgICAgICAgIHdpZHRoOiAyNCxcbiAgICAgICAgICAgICAgaGVpZ2h0OiA2LFxuICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgIG1ldHJpY3M6IFtcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsICdNaXhlZEFuZFYzQW5kVjJTcGxpdFJvdXRlJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgJ01peGVkQW5kVjNTcGxpdFJvdXRlJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgJ01peGVkQW5kVjJTcGxpdFJvdXRlJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgJ01peGVkU3BsaXRSb3V0ZScsICdTZXJ2aWNlJywgJ1JvdXRpbmdBUEknXSxcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsICdNaXhlZFJvdXRlJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgJ1YzQW5kVjJTcGxpdFJvdXRlJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgJ1YzU3BsaXRSb3V0ZScsICdTZXJ2aWNlJywgJ1JvdXRpbmdBUEknXSxcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsICdWM1JvdXRlJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgJ1YyU3BsaXRSb3V0ZScsICdTZXJ2aWNlJywgJ1JvdXRpbmdBUEknXSxcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsICdWMlJvdXRlJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgICAgICAgIHRpdGxlOiAnVHlwZXMgb2Ygcm91dGVzIHJldHVybmVkIGFjcm9zcyBhbGwgY2hhaW5zJyxcbiAgICAgICAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICAgICAgICBzdGF0OiAnU3VtJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICAgICAgICB3aWR0aDogMjQsXG4gICAgICAgICAgICAgIGhlaWdodDogNixcbiAgICAgICAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBtZXRyaWNzOiBfLmZsYXRNYXAoU1VQUE9SVEVEX0NIQUlOUywgKGNoYWluSWQ6IENoYWluSWQpID0+IFtcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsIGBNaXhlZEFuZFYzQW5kVjJTcGxpdFJvdXRlRm9yQ2hhaW4ke2NoYWluSWR9YCwgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgYE1peGVkQW5kVjNTcGxpdFJvdXRlRm9yQ2hhaW4ke2NoYWluSWR9YCwgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgYE1peGVkQW5kVjJTcGxpdFJvdXRlRm9yQ2hhaW4ke2NoYWluSWR9YCwgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgYE1peGVkU3BsaXRSb3V0ZUZvckNoYWluJHtjaGFpbklkfWAsICdTZXJ2aWNlJywgJ1JvdXRpbmdBUEknXSxcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsIGBNaXhlZFJvdXRlRm9yQ2hhaW4ke2NoYWluSWR9YCwgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgYFYzQW5kVjJTcGxpdFJvdXRlRm9yQ2hhaW4ke2NoYWluSWR9YCwgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgYFYzU3BsaXRSb3V0ZUZvckNoYWluJHtjaGFpbklkfWAsICdTZXJ2aWNlJywgJ1JvdXRpbmdBUEknXSxcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsIGBWM1JvdXRlRm9yQ2hhaW4ke2NoYWluSWR9YCwgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgW05BTUVTUEFDRSwgYFYyU3BsaXRSb3V0ZUZvckNoYWluJHtjaGFpbklkfWAsICdTZXJ2aWNlJywgJ1JvdXRpbmdBUEknXSxcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsIGBWMlJvdXRlRm9yQ2hhaW4ke2NoYWluSWR9YCwgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgICAgIHJlZ2lvbixcbiAgICAgICAgICAgICAgICB0aXRsZTogJ1R5cGVzIG9mIFYzIHJvdXRlcyByZXR1cm5lZCBieSBjaGFpbicsXG4gICAgICAgICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgICAgICAgc3RhdDogJ1N1bScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgICAgICBoZWlnaHQ6IDYsXG4gICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgICBtZXRyaWNzOiBfLmZsYXRNYXAoU1VQUE9SVEVEX0NIQUlOUywgKGNoYWluSWQ6IENoYWluSWQpID0+IFtcbiAgICAgICAgICAgICAgICAgIFsnVW5pc3dhcCcsIGBRdW90ZUZvdW5kRm9yQ2hhaW4ke2NoYWluSWR9YCwgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgICAgWydVbmlzd2FwJywgYFF1b3RlUmVxdWVzdGVkRm9yQ2hhaW4ke2NoYWluSWR9YCwgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgIF0pLFxuICAgICAgICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBzdGF0OiAnU3VtJyxcbiAgICAgICAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICAgICAgICByZWdpb24sXG4gICAgICAgICAgICAgICAgdGl0bGU6ICdRdW90ZSBSZXF1ZXN0ZWQvRm91bmQgYnkgQ2hhaW4nLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgaGVpZ2h0OiAxMixcbiAgICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgICAgIG1ldHJpY3M6IFtcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsICdUb2tlbkxpc3RMb2FkJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSScsIHsgY29sb3I6ICcjYzViMGQ1JyB9XSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICdHYXNQcmljZUxvYWQnLCAnLicsICcuJywgeyBjb2xvcjogJyMxN2JlY2YnIH1dLFxuICAgICAgICAgICAgICAgICAgWycuJywgJ1YzUG9vbHNMb2FkJywgJy4nLCAnLicsIHsgY29sb3I6ICcjZTM3N2MyJyB9XSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICdWMlBvb2xzTG9hZCcsICcuJywgJy4nLCB7IGNvbG9yOiAnI2UzNzdjMicgfV0sXG4gICAgICAgICAgICAgICAgICBbJy4nLCAnVjNTdWJncmFwaFBvb2xzTG9hZCcsICcuJywgJy4nLCB7IGNvbG9yOiAnIzFmNzdiNCcgfV0sXG4gICAgICAgICAgICAgICAgICBbJy4nLCAnVjJTdWJncmFwaFBvb2xzTG9hZCcsICcuJywgJy4nLCB7IGNvbG9yOiAnI2JmNzdiNCcgfV0sXG4gICAgICAgICAgICAgICAgICBbJy4nLCAnVjNRdW90ZXNMb2FkJywgJy4nLCAnLicsIHsgY29sb3I6ICcjMmNhMDJjJyB9XSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICdNaXhlZFF1b3Rlc0xvYWQnLCAnLicsICcuJywgeyBjb2xvcjogJyNmZWZhNjMnIH1dLFxuICAgICAgICAgICAgICAgICAgWycuJywgJ1YyUXVvdGVzTG9hZCcsICcuJywgJy4nLCB7IGNvbG9yOiAnIzdmN2Y3ZicgfV0sXG4gICAgICAgICAgICAgICAgICBbJy4nLCAnRmluZEJlc3RTd2FwUm91dGUnLCAnLicsICcuJywgeyBjb2xvcjogJyNkNjI3MjgnIH1dLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgICAgICAgIHN0YWNrZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgcmVnaW9uLFxuICAgICAgICAgICAgICAgIHN0YXQ6ICdwOTAnLFxuICAgICAgICAgICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgICAgICAgICAgIHRpdGxlOiAnTGF0ZW5jeSBCcmVha2Rvd24nLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgICAgICAgIHdpZHRoOiAyNCxcbiAgICAgICAgICAgICAgaGVpZ2h0OiA5LFxuICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgIG1ldHJpY3M6IFtcbiAgICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsICdWM3RvcDJkaXJlY3Rzd2FwcG9vbCcsICdTZXJ2aWNlJywgJ1JvdXRpbmdBUEknXSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICdWM3RvcDJldGhxdW90ZXRva2VucG9vbCcsICcuJywgJy4nXSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICdWM3RvcGJ5dHZsJywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICAgICAgWycuJywgJ1YzdG9wYnl0dmx1c2luZ3Rva2VuaW4nLCAnLicsICcuJ10sXG4gICAgICAgICAgICAgICAgICBbJy4nLCAnVjN0b3BieXR2bHVzaW5ndG9rZW5pbnNlY29uZGhvcHMnLCAnLicsICcuJ10sXG4gICAgICAgICAgICAgICAgICBbJy4nLCAnVjJ0b3BieXR2bHVzaW5ndG9rZW5vdXQnLCAnLicsICcuJ10sXG4gICAgICAgICAgICAgICAgICBbJy4nLCAnVjN0b3BieXR2bHVzaW5ndG9rZW5vdXRzZWNvbmRob3BzJywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICAgICAgWycuJywgJ1YzdG9wYnliYXNld2l0aHRva2VuaW4nLCAnLicsICcuJ10sXG4gICAgICAgICAgICAgICAgICBbJy4nLCAnVjN0b3BieWJhc2V3aXRodG9rZW5vdXQnLCAnLicsICcuJ10sXG4gICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICByZWdpb246IHJlZ2lvbixcbiAgICAgICAgICAgICAgICB0aXRsZTogJ3A5NSBWMyBUb3AgTiBQb29scyBVc2VkIEZyb20gU291cmNlcyBpbiBCZXN0IFJvdXRlJyxcbiAgICAgICAgICAgICAgICBzdGF0OiAncDk1JyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICAgICAgICB3aWR0aDogMjQsXG4gICAgICAgICAgICAgIGhlaWdodDogOSxcbiAgICAgICAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBtZXRyaWNzOiBbXG4gICAgICAgICAgICAgICAgICBbTkFNRVNQQUNFLCAnVjJ0b3AyZGlyZWN0c3dhcHBvb2wnLCAnU2VydmljZScsICdSb3V0aW5nQVBJJ10sXG4gICAgICAgICAgICAgICAgICBbJy4nLCAnVjJ0b3AyZXRocXVvdGV0b2tlbnBvb2wnLCAnLicsICcuJ10sXG4gICAgICAgICAgICAgICAgICBbJy4nLCAnVjJ0b3BieXR2bCcsICcuJywgJy4nXSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICdWMnRvcGJ5dHZsdXNpbmd0b2tlbmluJywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICAgICAgWycuJywgJ1YydG9wYnl0dmx1c2luZ3Rva2VuaW5zZWNvbmRob3BzJywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICAgICAgWycuJywgJ1YydG9wYnl0dmx1c2luZ3Rva2Vub3V0JywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICAgICAgWycuJywgJ1YydG9wYnl0dmx1c2luZ3Rva2Vub3V0c2Vjb25kaG9wcycsICcuJywgJy4nXSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICdWMnRvcGJ5YmFzZXdpdGh0b2tlbmluJywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICAgICAgWycuJywgJ1YydG9wYnliYXNld2l0aHRva2Vub3V0JywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcmVnaW9uOiByZWdpb24sXG4gICAgICAgICAgICAgICAgdGl0bGU6ICdwOTUgVjIgVG9wIE4gUG9vbHMgVXNlZCBGcm9tIFNvdXJjZXMgaW4gQmVzdCBSb3V0ZScsXG4gICAgICAgICAgICAgICAgc3RhdDogJ3A5NScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgICAgICBoZWlnaHQ6IDksXG4gICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgbWV0cmljczogW1xuICAgICAgICAgICAgICAgICAgWydBV1MvTGFtYmRhJywgJ1Byb3Zpc2lvbmVkQ29uY3VycmVudEV4ZWN1dGlvbnMnLCAnRnVuY3Rpb25OYW1lJywgcm91dGluZ0xhbWJkYU5hbWVdLFxuICAgICAgICAgICAgICAgICAgWycuJywgJ0NvbmN1cnJlbnRFeGVjdXRpb25zJywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICAgICAgWycuJywgJ1Byb3Zpc2lvbmVkQ29uY3VycmVuY3lTcGlsbG92ZXJJbnZvY2F0aW9ucycsICcuJywgJy4nLCB7IHN0YXQ6ICdTdW0nIH1dLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcmVnaW9uOiByZWdpb24sXG4gICAgICAgICAgICAgICAgdGl0bGU6ICdSb3V0aW5nIExhbWJkYSBQcm92aXNpb25lZCBDb25jdXJyZW5jeScsXG4gICAgICAgICAgICAgICAgc3RhdDogJ01heGltdW0nLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgICAgICAgIHdpZHRoOiAyNCxcbiAgICAgICAgICAgICAgaGVpZ2h0OiA5LFxuICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgIG1ldHJpY3M6IFtcbiAgICAgICAgICAgICAgICAgIC4uLnBvb2xDYWNoZUxhbWJkYU1ldHJpY3MsXG4gICAgICAgICAgICAgICAgICAuLi4oaXBmc1Bvb2xDYWNoZUxhbWJkYU5hbWVcbiAgICAgICAgICAgICAgICAgICAgPyBbXG4gICAgICAgICAgICAgICAgICAgICAgICBbJ0FXUy9MYW1iZGEnLCAnRXJyb3JzJywgJ0Z1bmN0aW9uTmFtZScsIGlwZnNQb29sQ2FjaGVMYW1iZGFOYW1lXSxcbiAgICAgICAgICAgICAgICAgICAgICAgIFsnLicsICdJbnZvY2F0aW9ucycsICcuJywgJy4nXSxcbiAgICAgICAgICAgICAgICAgICAgICBdXG4gICAgICAgICAgICAgICAgICAgIDogW10pLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgcmVnaW9uOiByZWdpb24sXG4gICAgICAgICAgICAgICAgdGl0bGU6ICdQb29sIENhY2hlIExhbWJkYSBFcnJvci9JbnZvY2F0aW9ucycsXG4gICAgICAgICAgICAgICAgc3RhdDogJ1N1bScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBoZWlnaHQ6IDgsXG4gICAgICAgICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgICBtZXRyaWNzOiBbXG4gICAgICAgICAgICAgICAgICBbXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICBleHByZXNzaW9uOiBgKG0xIC8gbTIpICogMTAwYCxcbiAgICAgICAgICAgICAgICAgICAgICBsYWJlbDogYFRlbmRlcmx5IFNpbXVsYXRpb24gQVBJIFN1Y2Nlc3MgUmF0ZSBieSBIVFRQIFN0YXR1cyBDb2RlYCxcbiAgICAgICAgICAgICAgICAgICAgICBpZDogYHRlbmRlcmx5U2ltdWxhdGlvbkh0dHBTdWNjZXNzUmF0ZWAsXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAgICAgICBOQU1FU1BBQ0UsXG4gICAgICAgICAgICAgICAgICAgICdUZW5kZXJseVNpbXVsYXRpb25Vbml2ZXJzYWxSb3V0ZXJSZXNwb25zZVN0YXR1czIwMCcsXG4gICAgICAgICAgICAgICAgICAgICdTZXJ2aWNlJyxcbiAgICAgICAgICAgICAgICAgICAgJ1JvdXRpbmdBUEknLFxuICAgICAgICAgICAgICAgICAgICB7IGlkOiAnbTEnLCB2aXNpYmxlOiBmYWxzZSB9LFxuICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgIFsnLicsICdUZW5kZXJseVNpbXVsYXRpb25Vbml2ZXJzYWxSb3V0ZXJSZXF1ZXN0cycsICcuJywgJy4nLCB7IGlkOiAnbTInLCB2aXNpYmxlOiBmYWxzZSB9XSxcbiAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICByZWdpb24sXG4gICAgICAgICAgICAgICAgc3RhdDogJ1N1bScsXG4gICAgICAgICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgICAgICAgdGl0bGU6ICdUZW5kZXJseSBTaW11bGF0aW9uIEFQSSBTdWNjZXNzIFJhdGUgYnkgSFRUUCBTdGF0dXMgQ29kZScsXG4gICAgICAgICAgICAgICAgc2V0UGVyaW9kVG9UaW1lUmFuZ2U6IHRydWUsXG4gICAgICAgICAgICAgICAgeUF4aXM6IHtcbiAgICAgICAgICAgICAgICAgIGxlZnQ6IHtcbiAgICAgICAgICAgICAgICAgICAgc2hvd1VuaXRzOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgbGFiZWw6ICclJyxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSlcbiAgICAgICAgICAuY29uY2F0KHJwY1Byb3ZpZGVyc1dpZGdldHNGb3JSb3V0aW5nRGFzaGJvYXJkKSxcbiAgICAgIH0pLFxuICAgIH0pXG5cbiAgICBjb25zdCBxdW90ZUFtb3VudHNXaWRnZXRzID0gbmV3IFF1b3RlQW1vdW50c1dpZGdldHNGYWN0b3J5KE5BTUVTUEFDRSwgcmVnaW9uKVxuICAgIG5ldyBhd3NfY2xvdWR3YXRjaC5DZm5EYXNoYm9hcmQodGhpcywgJ1JvdXRpbmdBUElUcmFja2VkUGFpcnNEYXNoYm9hcmQnLCB7XG4gICAgICBkYXNoYm9hcmROYW1lOiAnUm91dGluZ0FQSVRyYWNrZWRQYWlyc0Rhc2hib2FyZCcsXG4gICAgICBkYXNoYm9hcmRCb2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHBlcmlvZE92ZXJyaWRlOiAnaW5oZXJpdCcsXG4gICAgICAgIHdpZGdldHM6IHF1b3RlQW1vdW50c1dpZGdldHMuZ2VuZXJhdGVXaWRnZXRzKCksXG4gICAgICB9KSxcbiAgICB9KVxuXG4gICAgY29uc3QgY2FjaGVkUm91dGVzV2lkZ2V0cyA9IG5ldyBDYWNoZWRSb3V0ZXNXaWRnZXRzRmFjdG9yeShOQU1FU1BBQ0UsIHJlZ2lvbiwgcm91dGluZ0xhbWJkYU5hbWUpXG4gICAgbmV3IGF3c19jbG91ZHdhdGNoLkNmbkRhc2hib2FyZCh0aGlzLCAnQ2FjaGVkUm91dGVzUGVyZm9ybWFuY2VEYXNoYm9hcmQnLCB7XG4gICAgICBkYXNoYm9hcmROYW1lOiAnQ2FjaGVkUm91dGVzUGVyZm9ybWFuY2VEYXNoYm9hcmQnLFxuICAgICAgZGFzaGJvYXJkQm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwZXJpb2RPdmVycmlkZTogJ2luaGVyaXQnLFxuICAgICAgICB3aWRnZXRzOiBjYWNoZWRSb3V0ZXNXaWRnZXRzLmdlbmVyYXRlV2lkZ2V0cygpLFxuICAgICAgfSksXG4gICAgfSlcblxuICAgIG5ldyBhd3NfY2xvdWR3YXRjaC5DZm5EYXNoYm9hcmQodGhpcywgJ1JvdXRpbmdBUElRdW90ZVByb3ZpZGVyRGFzaGJvYXJkJywge1xuICAgICAgZGFzaGJvYXJkTmFtZTogYFJvdXRpbmdRdW90ZVByb3ZpZGVyRGFzaGJvYXJkYCxcbiAgICAgIGRhc2hib2FyZEJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcGVyaW9kT3ZlcnJpZGU6ICdpbmhlcml0JyxcbiAgICAgICAgd2lkZ2V0czogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGhlaWdodDogNixcbiAgICAgICAgICAgIHdpZHRoOiAyNCxcbiAgICAgICAgICAgIHk6IDAsXG4gICAgICAgICAgICB4OiAwLFxuICAgICAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgIG1ldHJpY3M6IFtbTkFNRVNQQUNFLCAnUXVvdGVBcHByb3hHYXNVc2VkUGVyU3VjY2Vzc2Z1bENhbGwnLCAnU2VydmljZScsICdSb3V0aW5nQVBJJ11dLFxuICAgICAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICByZWdpb24sXG4gICAgICAgICAgICAgIHN0YXQ6ICdBdmVyYWdlJyxcbiAgICAgICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgICAgIHRpdGxlOiAnQXBwcm94IGdhcyB1c2VkIGJ5IGVhY2ggY2FsbCcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgaGVpZ2h0OiA2LFxuICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgICAgeTogNixcbiAgICAgICAgICAgIHg6IDAsXG4gICAgICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICAgICAgbWV0cmljczogW1xuICAgICAgICAgICAgICAgIFtOQU1FU1BBQ0UsICdRdW90ZVRvdGFsQ2FsbHNUb1Byb3ZpZGVyJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgIFsnLicsICdRdW90ZUV4cGVjdGVkQ2FsbHNUb1Byb3ZpZGVyJywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICAgIFsnLicsICdRdW90ZU51bVJldHJpZWRDYWxscycsICcuJywgJy4nXSxcbiAgICAgICAgICAgICAgICBbJy4nLCAnUXVvdGVOdW1SZXRyeUxvb3BzJywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICByZWdpb24sXG4gICAgICAgICAgICAgIHN0YXQ6ICdBdmVyYWdlJyxcbiAgICAgICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgICAgIHRpdGxlOiAnTnVtYmVyIG9mIHJldHJpZXMgdG8gcHJvdmlkZXIgbmVlZGVkIHRvIGdldCBxdW90ZScsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgaGVpZ2h0OiA2LFxuICAgICAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICAgICAgeTogMTIsXG4gICAgICAgICAgICB4OiAwLFxuICAgICAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgICAgIG1ldHJpY3M6IFtcbiAgICAgICAgICAgICAgICBbTkFNRVNQQUNFLCAnUXVvdGVPdXRPZkdhc0V4Y2VwdGlvblJldHJ5JywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSSddLFxuICAgICAgICAgICAgICAgIFsnLicsICdRdW90ZVN1Y2Nlc3NSYXRlUmV0cnknLCAnLicsICcuJ10sXG4gICAgICAgICAgICAgICAgWycuJywgJ1F1b3RlQmxvY2tIZWFkZXJOb3RGb3VuZFJldHJ5JywgJy4nLCAnLiddLFxuICAgICAgICAgICAgICAgIFsnLicsICdRdW90ZVRpbWVvdXRSZXRyeScsICcuJywgJy4nXSxcbiAgICAgICAgICAgICAgICBbJy4nLCAnUXVvdGVVbmtub3duUmVhc29uUmV0cnknLCAnLicsICcuJ10sXG4gICAgICAgICAgICAgICAgWycuJywgJ1F1b3RlQmxvY2tDb25mbGljdEVycm9yUmV0cnknLCAnLicsICcuJ10sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgICAgIHJlZ2lvbixcbiAgICAgICAgICAgICAgcGVyaW9kOiAzMDAsXG4gICAgICAgICAgICAgIHN0YXQ6ICdTdW0nLFxuICAgICAgICAgICAgICB0aXRsZTogJ051bWJlciBvZiByZXF1ZXN0cyB0aGF0IHJldHJpZWQgaW4gdGhlIHF1b3RlIHByb3ZpZGVyJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0pLFxuICAgIH0pXG4gIH1cbn1cbiJdfQ==