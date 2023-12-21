import { AlphaRouterConfig, IRouter, LegacyRoutingConfig } from '@uniswap/smart-order-router';
import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { ContainerInjected, InjectorSOR, RequestInjected } from '../injector-sor';
import { QuoteQueryParams } from './schema/quote-schema';
export declare class QuoteHandlerInjector extends InjectorSOR<IRouter<AlphaRouterConfig | LegacyRoutingConfig>, QuoteQueryParams> {
    getRequestInjected(containerInjected: ContainerInjected, _requestBody: void, requestQueryParams: QuoteQueryParams, _event: APIGatewayProxyEvent, context: Context, log: Logger, metricsLogger: MetricsLogger): Promise<RequestInjected<IRouter<AlphaRouterConfig | LegacyRoutingConfig>>>;
}
