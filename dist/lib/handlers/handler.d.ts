/// <reference types="hapi__joi" />
import Joi from '@hapi/joi';
import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
export type APIGatewayProxyHandler = (event: APIGatewayProxyEvent, context: Context) => Promise<APIGatewayProxyResult>;
export type BaseRInj = {
    log: Logger;
    id: string;
};
export type HandleRequestParams<CInj, RInj, ReqBody, ReqQueryParams> = {
    context: Context;
    event: APIGatewayProxyEvent;
    requestBody: ReqBody;
    requestQueryParams: ReqQueryParams;
    containerInjected: CInj;
    requestInjected: RInj;
};
export type Response<Res> = {
    statusCode: 200 | 202;
    body: Res;
    headers?: any;
};
export type ErrorResponse = {
    statusCode: 400 | 403 | 404 | 408 | 409 | 500;
    errorCode: string;
    detail?: string;
};
export declare class UnsupportedChainError extends Error {
    chainId: number;
    constructor(chainId: number);
    name: string;
}
export declare abstract class Injector<CInj, RInj extends BaseRInj, ReqBody, ReqQueryParams> {
    protected injectorName: string;
    private containerInjected;
    constructor(injectorName: string);
    build(): Promise<this>;
    abstract getRequestInjected(containerInjected: CInj, requestBody: ReqBody, requestQueryParams: ReqQueryParams, event: APIGatewayProxyEvent, context: Context, log: Logger, metrics: MetricsLogger): Promise<RInj>;
    abstract buildContainerInjected(): Promise<CInj>;
    getContainerInjected(): Promise<CInj>;
}
export declare abstract class APIGLambdaHandler<CInj, RInj extends BaseRInj, ReqBody, ReqQueryParams, Res> {
    private handlerName;
    private injectorPromise;
    constructor(handlerName: string, injectorPromise: Promise<Injector<CInj, RInj, ReqBody, ReqQueryParams>>);
    get handler(): APIGatewayProxyHandler;
    private buildHandler;
    protected afterHandler(_: MetricsLogger, __: Res, ___: number): void;
    abstract handleRequest(params: HandleRequestParams<CInj, RInj, ReqBody, ReqQueryParams>): Promise<Response<Res> | ErrorResponse>;
    protected abstract requestBodySchema(): Joi.ObjectSchema | null;
    protected abstract requestQueryParamsSchema(): Joi.ObjectSchema | null;
    protected abstract responseBodySchema(): Joi.ObjectSchema | null;
    private isError;
    private parseAndValidateRequest;
    private parseAndValidateResponse;
}
