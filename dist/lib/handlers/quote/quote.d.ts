/// <reference types="hapi__joi" />
import Joi from '@hapi/joi';
import { AlphaRouterConfig, IRouter } from '@uniswap/smart-order-router';
import { APIGLambdaHandler, ErrorResponse, HandleRequestParams, Response } from '../handler';
import { ContainerInjected, RequestInjected } from '../injector-sor';
import { QuoteResponse } from '../schema';
import { QuoteQueryParams } from './schema/quote-schema';
import { MetricsLogger } from 'aws-embedded-metrics';
export declare class QuoteHandler extends APIGLambdaHandler<ContainerInjected, RequestInjected<IRouter<AlphaRouterConfig>>, void, QuoteQueryParams, QuoteResponse> {
    handleRequest(params: HandleRequestParams<ContainerInjected, RequestInjected<IRouter<any>>, void, QuoteQueryParams>): Promise<Response<QuoteResponse> | ErrorResponse>;
    private handleRequestInternal;
    private deriveBuyFeeBps;
    private deriveSellFeeBps;
    private logRouteMetrics;
    protected requestBodySchema(): Joi.ObjectSchema | null;
    protected requestQueryParamsSchema(): Joi.ObjectSchema | null;
    protected responseBodySchema(): Joi.ObjectSchema | null;
    protected afterHandler(metric: MetricsLogger, response: QuoteResponse, requestStart: number): void;
}
