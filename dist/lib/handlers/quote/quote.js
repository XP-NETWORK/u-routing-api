import { Protocol } from '@uniswap/router-sdk';
import { UNIVERSAL_ROUTER_ADDRESS } from '@uniswap/universal-router-sdk';
import { CurrencyAmount, TradeType } from '@uniswap/sdk-core';
import { MetricLoggerUnit, routeAmountsToString, SwapType, SimulationStatus, ID_TO_NETWORK_NAME, } from '@uniswap/smart-order-router';
import { Pool } from '@uniswap/v3-sdk';
import JSBI from 'jsbi';
import _ from 'lodash';
import { APIGLambdaHandler } from '../handler';
import { QuoteResponseSchemaJoi } from '../schema';
import { DEFAULT_ROUTING_CONFIG_BY_CHAIN, parseDeadline, parseSlippageTolerance, QUOTE_SPEED_CONFIG, INTENT_SPECIFIC_CONFIG, FEE_ON_TRANSFER_SPECIFIC_CONFIG, populateFeeOptions, computePortionAmount, } from '../shared';
import { QuoteQueryParamsJoi } from './schema/quote-schema';
import { utils } from 'ethers';
import { simulationStatusToString } from './util/simulation';
import { PAIRS_TO_TRACK } from './util/pairs-to-track';
import { measureDistributionPercentChangeImpact } from '../../util/alpha-config-measurement';
import { CurrencyLookup } from '../CurrencyLookup';
export class QuoteHandler extends APIGLambdaHandler {
    async handleRequest(params) {
        const { chainId, metric, log, quoteSpeed, intent } = params.requestInjected;
        // Mark the start of core business logic for latency bookkeeping.
        // Note that some time may have elapsed before handleRequest was called, so this
        // time does not accurately indicate when our lambda started processing the request,
        // resulting in slightly underreported metrics.
        //
        // To use the true requestStartTime, the route APIGLambdaHandler needs to be
        // refactored to call handleRequest with the startTime.
        const startTime = Date.now();
        let result;
        try {
            result = await this.handleRequestInternal(params, startTime);
            switch (result.statusCode) {
                case 200:
                case 202:
                    metric.putMetric(`GET_QUOTE_200_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count);
                    break;
                case 400:
                case 403:
                case 404:
                case 408:
                case 409:
                    metric.putMetric(`GET_QUOTE_400_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count);
                    log.error({
                        statusCode: result === null || result === void 0 ? void 0 : result.statusCode,
                        errorCode: result === null || result === void 0 ? void 0 : result.errorCode,
                        detail: result === null || result === void 0 ? void 0 : result.detail,
                    }, `Quote 4XX Error [${result === null || result === void 0 ? void 0 : result.statusCode}] on ${ID_TO_NETWORK_NAME(chainId)} with errorCode '${result === null || result === void 0 ? void 0 : result.errorCode}': ${result === null || result === void 0 ? void 0 : result.detail}`);
                    break;
                case 500:
                    metric.putMetric(`GET_QUOTE_500_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count);
                    break;
            }
        }
        catch (err) {
            metric.putMetric(`GET_QUOTE_500_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count);
            throw err;
        }
        finally {
            // This metric is logged after calling the internal handler to correlate with the status metrics
            metric.putMetric(`GET_QUOTE_REQUEST_SOURCE: ${params.requestQueryParams.source}`, 1, MetricLoggerUnit.Count);
            metric.putMetric(`GET_QUOTE_REQUESTED_CHAINID: ${chainId}`, 1, MetricLoggerUnit.Count);
            metric.putMetric(`GET_QUOTE_LATENCY_CHAIN_${chainId}`, Date.now() - startTime, MetricLoggerUnit.Milliseconds);
            metric.putMetric(`GET_QUOTE_LATENCY_CHAIN_${chainId}_QUOTE_SPEED_${quoteSpeed !== null && quoteSpeed !== void 0 ? quoteSpeed : 'standard'}`, Date.now() - startTime, MetricLoggerUnit.Milliseconds);
            metric.putMetric(`GET_QUOTE_LATENCY_CHAIN_${chainId}_INTENT_${intent !== null && intent !== void 0 ? intent : 'quote'}`, Date.now() - startTime, MetricLoggerUnit.Milliseconds);
        }
        return result;
    }
    async handleRequestInternal(params, handleRequestStartTime) {
        const { requestQueryParams: { tokenInAddress, tokenInChainId, tokenOutAddress, tokenOutChainId, amount: amountRaw, type, recipient, slippageTolerance, deadline, minSplits, forceCrossProtocol, forceMixedRoutes, protocols: protocolsStr, simulateFromAddress, permitSignature, permitNonce, permitExpiration, permitAmount, permitSigDeadline, enableUniversalRouter, quoteSpeed, debugRoutingConfig, unicornSecret, intent, enableFeeOnTransferFeeFetching, portionBips, portionAmount, portionRecipient, }, requestInjected: { router, log, id: quoteId, chainId, tokenProvider, tokenListProvider, v3PoolProvider: v3PoolProvider, v2PoolProvider: v2PoolProvider, metric, }, } = params;
        if (tokenInChainId !== tokenOutChainId) {
            return {
                statusCode: 400,
                errorCode: 'TOKEN_CHAINS_DIFFERENT',
                detail: `Cannot request quotes for tokens on different chains`,
            };
        }
        let protocols = [];
        if (protocolsStr) {
            for (const protocolStr of protocolsStr) {
                switch (protocolStr.toLowerCase()) {
                    case 'v2':
                        protocols.push(Protocol.V2);
                        break;
                    case 'v3':
                        protocols.push(Protocol.V3);
                        break;
                    case 'mixed':
                        protocols.push(Protocol.MIXED);
                        break;
                    default:
                        return {
                            statusCode: 400,
                            errorCode: 'INVALID_PROTOCOL',
                            detail: `Invalid protocol specified. Supported protocols: ${JSON.stringify(Object.values(Protocol))}`,
                        };
                }
            }
        }
        else if (!forceCrossProtocol) {
            protocols = [Protocol.V3];
        }
        // Parse user provided token address/symbol to Currency object.
        const currencyLookupStartTime = Date.now();
        const currencyLookup = new CurrencyLookup(tokenListProvider, tokenProvider, log);
        const [currencyIn, currencyOut] = await Promise.all([
            currencyLookup.searchForToken(tokenInAddress, tokenInChainId),
            currencyLookup.searchForToken(tokenOutAddress, tokenOutChainId),
        ]);
        metric.putMetric('TokenInOutStrToToken', Date.now() - currencyLookupStartTime, MetricLoggerUnit.Milliseconds);
        if (!currencyIn) {
            return {
                statusCode: 400,
                errorCode: 'TOKEN_IN_INVALID',
                detail: `Could not find token with address "${tokenInAddress}"`,
            };
        }
        if (!currencyOut) {
            return {
                statusCode: 400,
                errorCode: 'TOKEN_OUT_INVALID',
                detail: `Could not find token with address "${tokenOutAddress}"`,
            };
        }
        if (currencyIn.equals(currencyOut)) {
            return {
                statusCode: 400,
                errorCode: 'TOKEN_IN_OUT_SAME',
                detail: `tokenIn and tokenOut must be different`,
            };
        }
        let parsedDebugRoutingConfig = {};
        if (debugRoutingConfig && unicornSecret && unicornSecret === process.env.UNICORN_SECRET) {
            parsedDebugRoutingConfig = JSON.parse(debugRoutingConfig);
        }
        const routingConfig = {
            ...DEFAULT_ROUTING_CONFIG_BY_CHAIN(chainId),
            ...(minSplits ? { minSplits } : {}),
            ...(forceCrossProtocol ? { forceCrossProtocol } : {}),
            ...(forceMixedRoutes ? { forceMixedRoutes } : {}),
            protocols,
            ...(quoteSpeed ? QUOTE_SPEED_CONFIG[quoteSpeed] : {}),
            ...parsedDebugRoutingConfig,
            ...(intent ? INTENT_SPECIFIC_CONFIG[intent] : {}),
            // Only when enableFeeOnTransferFeeFetching is explicitly set to true, then we
            // override usedCachedRoutes to false. This is to ensure that we don't use
            // accidentally override usedCachedRoutes in the normal path.
            ...(enableFeeOnTransferFeeFetching ? FEE_ON_TRANSFER_SPECIFIC_CONFIG(enableFeeOnTransferFeeFetching) : {}),
        };
        metric.putMetric(`${intent}Intent`, 1, MetricLoggerUnit.Count);
        let swapParams = undefined;
        // e.g. Inputs of form "1.25%" with 2dp max. Convert to fractional representation => 1.25 => 125 / 10000
        if (slippageTolerance) {
            const slippageTolerancePercent = parseSlippageTolerance(slippageTolerance);
            // TODO: Remove once universal router is no longer behind a feature flag.
            if (enableUniversalRouter) {
                const allFeeOptions = populateFeeOptions(type, portionBips, portionRecipient, portionAmount !== null && portionAmount !== void 0 ? portionAmount : computePortionAmount(CurrencyAmount.fromRawAmount(currencyOut, JSBI.BigInt(amountRaw)), portionBips));
                swapParams = {
                    type: SwapType.UNIVERSAL_ROUTER,
                    deadlineOrPreviousBlockhash: deadline ? parseDeadline(deadline) : undefined,
                    recipient: recipient,
                    slippageTolerance: slippageTolerancePercent,
                    ...allFeeOptions,
                };
            }
            else {
                if (deadline && recipient) {
                    swapParams = {
                        type: SwapType.SWAP_ROUTER_02,
                        deadline: parseDeadline(deadline),
                        recipient: recipient,
                        slippageTolerance: slippageTolerancePercent,
                    };
                }
            }
            if (enableUniversalRouter &&
                permitSignature &&
                permitNonce &&
                permitExpiration &&
                permitAmount &&
                permitSigDeadline) {
                const permit = {
                    details: {
                        token: currencyIn.wrapped.address,
                        amount: permitAmount,
                        expiration: permitExpiration,
                        nonce: permitNonce,
                    },
                    spender: UNIVERSAL_ROUTER_ADDRESS(chainId),
                    sigDeadline: permitSigDeadline,
                };
                if (swapParams) {
                    swapParams.inputTokenPermit = {
                        ...permit,
                        signature: permitSignature,
                    };
                }
            }
            else if (!enableUniversalRouter &&
                permitSignature &&
                ((permitNonce && permitExpiration) || (permitAmount && permitSigDeadline))) {
                const { v, r, s } = utils.splitSignature(permitSignature);
                if (swapParams) {
                    swapParams.inputTokenPermit = {
                        v: v,
                        r,
                        s,
                        ...(permitNonce && permitExpiration
                            ? { nonce: permitNonce, expiry: permitExpiration }
                            : { amount: permitAmount, deadline: permitSigDeadline }),
                    };
                }
            }
            if (simulateFromAddress) {
                metric.putMetric('Simulation Requested', 1, MetricLoggerUnit.Count);
                if (swapParams) {
                    swapParams.simulate = { fromAddress: simulateFromAddress };
                }
            }
        }
        let swapRoute;
        let amount;
        let tokenPairSymbol = '';
        let tokenPairSymbolChain = '';
        if (currencyIn.symbol && currencyOut.symbol) {
            tokenPairSymbol = _([currencyIn.symbol, currencyOut.symbol]).join('/');
            tokenPairSymbolChain = `${tokenPairSymbol}/${chainId}`;
        }
        const [token0Symbol, token0Address, token1Symbol, token1Address] = currencyIn.wrapped.sortsBefore(currencyOut.wrapped)
            ? [currencyIn.symbol, currencyIn.wrapped.address, currencyOut.symbol, currencyOut.wrapped.address]
            : [currencyOut.symbol, currencyOut.wrapped.address, currencyIn.symbol, currencyIn.wrapped.address];
        switch (type) {
            case 'exactIn':
                amount = CurrencyAmount.fromRawAmount(currencyIn, JSBI.BigInt(amountRaw));
                log.info({
                    amountIn: amount.toExact(),
                    token0Address,
                    token1Address,
                    token0Symbol,
                    token1Symbol,
                    tokenInSymbol: currencyIn.symbol,
                    tokenOutSymbol: currencyOut.symbol,
                    tokenPairSymbol,
                    tokenPairSymbolChain,
                    type,
                    routingConfig: routingConfig,
                    swapParams,
                    intent,
                }, `Exact In Swap: Give ${amount.toExact()} ${amount.currency.symbol}, Want: ${currencyOut.symbol}. Chain: ${chainId}`);
                swapRoute = await router.route(amount, currencyOut, TradeType.EXACT_INPUT, swapParams, routingConfig);
                break;
            case 'exactOut':
                amount = CurrencyAmount.fromRawAmount(currencyOut, JSBI.BigInt(amountRaw));
                log.info({
                    amountOut: amount.toExact(),
                    token0Address,
                    token1Address,
                    token0Symbol,
                    token1Symbol,
                    tokenInSymbol: currencyIn.symbol,
                    tokenOutSymbol: currencyOut.symbol,
                    tokenPairSymbol,
                    tokenPairSymbolChain,
                    type,
                    routingConfig: routingConfig,
                    swapParams,
                }, `Exact Out Swap: Want ${amount.toExact()} ${amount.currency.symbol} Give: ${currencyIn.symbol}. Chain: ${chainId}`);
                swapRoute = await router.route(amount, currencyIn, TradeType.EXACT_OUTPUT, swapParams, routingConfig);
                break;
            default:
                throw new Error('Invalid swap type');
        }
        if (!swapRoute) {
            log.info({
                type,
                tokenIn: currencyIn,
                tokenOut: currencyOut,
                amount: amount.quotient.toString(),
            }, `No route found. 404`);
            return {
                statusCode: 404,
                errorCode: 'NO_ROUTE',
                detail: 'No route found',
            };
        }
        const { quote, quoteGasAdjusted, quoteGasAndPortionAdjusted, route, estimatedGasUsed, estimatedGasUsedQuoteToken, estimatedGasUsedUSD, gasPriceWei, methodParameters, blockNumber, simulationStatus, hitsCachedRoute, portionAmount: outputPortionAmount, // TODO: name it back to portionAmount
         } = swapRoute;
        if (simulationStatus == SimulationStatus.Failed) {
            metric.putMetric('SimulationFailed', 1, MetricLoggerUnit.Count);
        }
        else if (simulationStatus == SimulationStatus.Succeeded) {
            metric.putMetric('SimulationSuccessful', 1, MetricLoggerUnit.Count);
        }
        else if (simulationStatus == SimulationStatus.InsufficientBalance) {
            metric.putMetric('SimulationInsufficientBalance', 1, MetricLoggerUnit.Count);
        }
        else if (simulationStatus == SimulationStatus.NotApproved) {
            metric.putMetric('SimulationNotApproved', 1, MetricLoggerUnit.Count);
        }
        else if (simulationStatus == SimulationStatus.NotSupported) {
            metric.putMetric('SimulationNotSupported', 1, MetricLoggerUnit.Count);
        }
        const routeResponse = [];
        for (const subRoute of route) {
            const { amount, quote, tokenPath } = subRoute;
            const pools = subRoute.protocol == Protocol.V2 ? subRoute.route.pairs : subRoute.route.pools;
            const curRoute = [];
            for (let i = 0; i < pools.length; i++) {
                const nextPool = pools[i];
                const tokenIn = tokenPath[i];
                const tokenOut = tokenPath[i + 1];
                let edgeAmountIn = undefined;
                if (i == 0) {
                    edgeAmountIn = type == 'exactIn' ? amount.quotient.toString() : quote.quotient.toString();
                }
                let edgeAmountOut = undefined;
                if (i == pools.length - 1) {
                    edgeAmountOut = type == 'exactIn' ? quote.quotient.toString() : amount.quotient.toString();
                }
                if (nextPool instanceof Pool) {
                    curRoute.push({
                        type: 'v3-pool',
                        address: v3PoolProvider.getPoolAddress(nextPool.token0, nextPool.token1, nextPool.fee).poolAddress,
                        tokenIn: {
                            chainId: tokenIn.chainId,
                            decimals: tokenIn.decimals.toString(),
                            address: tokenIn.address,
                            symbol: tokenIn.symbol,
                        },
                        tokenOut: {
                            chainId: tokenOut.chainId,
                            decimals: tokenOut.decimals.toString(),
                            address: tokenOut.address,
                            symbol: tokenOut.symbol,
                        },
                        fee: nextPool.fee.toString(),
                        liquidity: nextPool.liquidity.toString(),
                        sqrtRatioX96: nextPool.sqrtRatioX96.toString(),
                        tickCurrent: nextPool.tickCurrent.toString(),
                        amountIn: edgeAmountIn,
                        amountOut: edgeAmountOut,
                    });
                }
                else {
                    const reserve0 = nextPool.reserve0;
                    const reserve1 = nextPool.reserve1;
                    curRoute.push({
                        type: 'v2-pool',
                        address: v2PoolProvider.getPoolAddress(nextPool.token0, nextPool.token1).poolAddress,
                        tokenIn: {
                            chainId: tokenIn.chainId,
                            decimals: tokenIn.decimals.toString(),
                            address: tokenIn.address,
                            symbol: tokenIn.symbol,
                            buyFeeBps: this.deriveBuyFeeBps(tokenIn, reserve0, reserve1, enableFeeOnTransferFeeFetching),
                            sellFeeBps: this.deriveSellFeeBps(tokenIn, reserve0, reserve1, enableFeeOnTransferFeeFetching),
                        },
                        tokenOut: {
                            chainId: tokenOut.chainId,
                            decimals: tokenOut.decimals.toString(),
                            address: tokenOut.address,
                            symbol: tokenOut.symbol,
                            buyFeeBps: this.deriveBuyFeeBps(tokenOut, reserve0, reserve1, enableFeeOnTransferFeeFetching),
                            sellFeeBps: this.deriveSellFeeBps(tokenOut, reserve0, reserve1, enableFeeOnTransferFeeFetching),
                        },
                        reserve0: {
                            token: {
                                chainId: reserve0.currency.wrapped.chainId,
                                decimals: reserve0.currency.wrapped.decimals.toString(),
                                address: reserve0.currency.wrapped.address,
                                symbol: reserve0.currency.wrapped.symbol,
                                buyFeeBps: this.deriveBuyFeeBps(reserve0.currency.wrapped, reserve0, undefined, enableFeeOnTransferFeeFetching),
                                sellFeeBps: this.deriveSellFeeBps(reserve0.currency.wrapped, reserve0, undefined, enableFeeOnTransferFeeFetching),
                            },
                            quotient: reserve0.quotient.toString(),
                        },
                        reserve1: {
                            token: {
                                chainId: reserve1.currency.wrapped.chainId,
                                decimals: reserve1.currency.wrapped.decimals.toString(),
                                address: reserve1.currency.wrapped.address,
                                symbol: reserve1.currency.wrapped.symbol,
                                buyFeeBps: this.deriveBuyFeeBps(reserve1.currency.wrapped, undefined, reserve1, enableFeeOnTransferFeeFetching),
                                sellFeeBps: this.deriveSellFeeBps(reserve1.currency.wrapped, undefined, reserve1, enableFeeOnTransferFeeFetching),
                            },
                            quotient: reserve1.quotient.toString(),
                        },
                        amountIn: edgeAmountIn,
                        amountOut: edgeAmountOut,
                    });
                }
            }
            routeResponse.push(curRoute);
        }
        const routeString = routeAmountsToString(route);
        const result = {
            methodParameters,
            blockNumber: blockNumber.toString(),
            amount: amount.quotient.toString(),
            amountDecimals: amount.toExact(),
            quote: quote.quotient.toString(),
            quoteDecimals: quote.toExact(),
            quoteGasAdjusted: quoteGasAdjusted.quotient.toString(),
            quoteGasAdjustedDecimals: quoteGasAdjusted.toExact(),
            quoteGasAndPortionAdjusted: quoteGasAndPortionAdjusted === null || quoteGasAndPortionAdjusted === void 0 ? void 0 : quoteGasAndPortionAdjusted.quotient.toString(),
            quoteGasAndPortionAdjustedDecimals: quoteGasAndPortionAdjusted === null || quoteGasAndPortionAdjusted === void 0 ? void 0 : quoteGasAndPortionAdjusted.toExact(),
            gasUseEstimateQuote: estimatedGasUsedQuoteToken.quotient.toString(),
            gasUseEstimateQuoteDecimals: estimatedGasUsedQuoteToken.toExact(),
            gasUseEstimate: estimatedGasUsed.toString(),
            gasUseEstimateUSD: estimatedGasUsedUSD.toExact(),
            simulationStatus: simulationStatusToString(simulationStatus, log),
            simulationError: simulationStatus == SimulationStatus.Failed,
            gasPriceWei: gasPriceWei.toString(),
            route: routeResponse,
            routeString,
            quoteId,
            hitsCachedRoutes: hitsCachedRoute,
            portionBips: portionBips,
            portionRecipient: portionRecipient,
            portionAmount: outputPortionAmount === null || outputPortionAmount === void 0 ? void 0 : outputPortionAmount.quotient.toString(),
            portionAmountDecimals: outputPortionAmount === null || outputPortionAmount === void 0 ? void 0 : outputPortionAmount.toExact(),
        };
        this.logRouteMetrics(log, metric, handleRequestStartTime, currencyIn, currencyOut, tokenInAddress, tokenOutAddress, type, chainId, amount, routeString, swapRoute);
        return {
            statusCode: 200,
            body: result,
        };
    }
    deriveBuyFeeBps(token, reserve0, reserve1, enableFeeOnTransferFeeFetching) {
        var _a, _b;
        if (!enableFeeOnTransferFeeFetching) {
            return undefined;
        }
        if (reserve0 === null || reserve0 === void 0 ? void 0 : reserve0.currency.equals(token)) {
            return (_a = reserve0.currency.buyFeeBps) === null || _a === void 0 ? void 0 : _a.toString();
        }
        if (reserve1 === null || reserve1 === void 0 ? void 0 : reserve1.currency.equals(token)) {
            return (_b = reserve1.currency.buyFeeBps) === null || _b === void 0 ? void 0 : _b.toString();
        }
        return undefined;
    }
    deriveSellFeeBps(token, reserve0, reserve1, enableFeeOnTransferFeeFetching) {
        var _a, _b;
        if (!enableFeeOnTransferFeeFetching) {
            return undefined;
        }
        if (reserve0 === null || reserve0 === void 0 ? void 0 : reserve0.currency.equals(token)) {
            return (_a = reserve0.currency.sellFeeBps) === null || _a === void 0 ? void 0 : _a.toString();
        }
        if (reserve1 === null || reserve1 === void 0 ? void 0 : reserve1.currency.equals(token)) {
            return (_b = reserve1.currency.sellFeeBps) === null || _b === void 0 ? void 0 : _b.toString();
        }
        return undefined;
    }
    logRouteMetrics(log, metric, handleRequestStartTime, currencyIn, currencyOut, tokenInAddress, tokenOutAddress, tradeType, chainId, amount, routeString, swapRoute) {
        var _a;
        const tradingPair = `${currencyIn.wrapped.symbol}/${currencyOut.wrapped.symbol}`;
        const wildcardInPair = `${currencyIn.wrapped.symbol}/*`;
        const wildcardOutPair = `*/${currencyOut.wrapped.symbol}`;
        const tradeTypeEnumValue = tradeType == 'exactIn' ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT;
        const pairsTracked = (_a = PAIRS_TO_TRACK.get(chainId)) === null || _a === void 0 ? void 0 : _a.get(tradeTypeEnumValue);
        measureDistributionPercentChangeImpact(5, 10, swapRoute, currencyIn, currencyOut, tradeType, chainId, amount);
        if ((pairsTracked === null || pairsTracked === void 0 ? void 0 : pairsTracked.includes(tradingPair)) ||
            (pairsTracked === null || pairsTracked === void 0 ? void 0 : pairsTracked.includes(wildcardInPair)) ||
            (pairsTracked === null || pairsTracked === void 0 ? void 0 : pairsTracked.includes(wildcardOutPair))) {
            const metricPair = (pairsTracked === null || pairsTracked === void 0 ? void 0 : pairsTracked.includes(tradingPair))
                ? tradingPair
                : (pairsTracked === null || pairsTracked === void 0 ? void 0 : pairsTracked.includes(wildcardInPair))
                    ? wildcardInPair
                    : wildcardOutPair;
            metric.putMetric(`GET_QUOTE_AMOUNT_${metricPair}_${tradeType.toUpperCase()}_CHAIN_${chainId}`, Number(amount.toExact()), MetricLoggerUnit.None);
            metric.putMetric(`GET_QUOTE_LATENCY_${metricPair}_${tradeType.toUpperCase()}_CHAIN_${chainId}`, Date.now() - handleRequestStartTime, MetricLoggerUnit.Milliseconds);
            // Create a hashcode from the routeString, this will indicate that a different route is being used
            // hashcode function copied from: https://gist.github.com/hyamamoto/fd435505d29ebfa3d9716fd2be8d42f0?permalink_comment_id=4261728#gistcomment-4261728
            const routeStringHash = Math.abs(routeString.split('').reduce((s, c) => (Math.imul(31, s) + c.charCodeAt(0)) | 0, 0));
            // Log the chose route
            log.info({
                tradingPair,
                tokenInAddress,
                tokenOutAddress,
                tradeType,
                amount: amount.toExact(),
                routeString,
                routeStringHash,
                chainId,
            }, `Tracked Route for pair [${tradingPair}/${tradeType.toUpperCase()}] on chain [${chainId}] with route hash [${routeStringHash}] for amount [${amount.toExact()}]`);
        }
    }
    requestBodySchema() {
        return null;
    }
    requestQueryParamsSchema() {
        return QuoteQueryParamsJoi;
    }
    responseBodySchema() {
        return QuoteResponseSchemaJoi;
    }
    afterHandler(metric, response, requestStart) {
        metric.putMetric(`GET_QUOTE_LATENCY_TOP_LEVEL_${response.hitsCachedRoutes ? 'CACHED_ROUTES_HIT' : 'CACHED_ROUTES_MISS'}`, Date.now() - requestStart, MetricLoggerUnit.Milliseconds);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicXVvdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9saWIvaGFuZGxlcnMvcXVvdGUvcXVvdGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQ0EsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLHFCQUFxQixDQUFBO0FBQzlDLE9BQU8sRUFBRSx3QkFBd0IsRUFBRSxNQUFNLCtCQUErQixDQUFBO0FBRXhFLE9BQU8sRUFBcUIsY0FBYyxFQUFTLFNBQVMsRUFBRSxNQUFNLG1CQUFtQixDQUFBO0FBQ3ZGLE9BQU8sRUFHTCxnQkFBZ0IsRUFDaEIsb0JBQW9CLEVBR3BCLFFBQVEsRUFDUixnQkFBZ0IsRUFFaEIsa0JBQWtCLEdBQ25CLE1BQU0sNkJBQTZCLENBQUE7QUFDcEMsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLGlCQUFpQixDQUFBO0FBQ3RDLE9BQU8sSUFBSSxNQUFNLE1BQU0sQ0FBQTtBQUN2QixPQUFPLENBQUMsTUFBTSxRQUFRLENBQUE7QUFDdEIsT0FBTyxFQUFFLGlCQUFpQixFQUFnRCxNQUFNLFlBQVksQ0FBQTtBQUU1RixPQUFPLEVBQWlCLHNCQUFzQixFQUFnQyxNQUFNLFdBQVcsQ0FBQTtBQUMvRixPQUFPLEVBQ0wsK0JBQStCLEVBQy9CLGFBQWEsRUFDYixzQkFBc0IsRUFDdEIsa0JBQWtCLEVBQ2xCLHNCQUFzQixFQUN0QiwrQkFBK0IsRUFDL0Isa0JBQWtCLEVBQ2xCLG9CQUFvQixHQUNyQixNQUFNLFdBQVcsQ0FBQTtBQUNsQixPQUFPLEVBQW9CLG1CQUFtQixFQUFFLE1BQU0sdUJBQXVCLENBQUE7QUFDN0UsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLFFBQVEsQ0FBQTtBQUM5QixPQUFPLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQTtBQUU1RCxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sdUJBQXVCLENBQUE7QUFDdEQsT0FBTyxFQUFFLHNDQUFzQyxFQUFFLE1BQU0scUNBQXFD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ZCwrQkFBK0IsUUFBUSxDQUFDLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDLENBQUMsb0JBQW9CLEVBQUUsRUFDdkcsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLFlBQVksRUFDekIsZ0JBQWdCLENBQUMsWUFBWSxDQUM5QixDQUFBO0lBQ0gsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IEpvaSBmcm9tICdAaGFwaS9qb2knXG5pbXBvcnQgeyBQcm90b2NvbCB9IGZyb20gJ0B1bmlzd2FwL3JvdXRlci1zZGsnXG5pbXBvcnQgeyBVTklWRVJTQUxfUk9VVEVSX0FERFJFU1MgfSBmcm9tICdAdW5pc3dhcC91bml2ZXJzYWwtcm91dGVyLXNkaydcbmltcG9ydCB7IFBlcm1pdFNpbmdsZSB9IGZyb20gJ0B1bmlzd2FwL3Blcm1pdDItc2RrJ1xuaW1wb3J0IHsgQ2hhaW5JZCwgQ3VycmVuY3ksIEN1cnJlbmN5QW1vdW50LCBUb2tlbiwgVHJhZGVUeXBlIH0gZnJvbSAnQHVuaXN3YXAvc2RrLWNvcmUnXG5pbXBvcnQge1xuICBBbHBoYVJvdXRlckNvbmZpZyxcbiAgSVJvdXRlcixcbiAgTWV0cmljTG9nZ2VyVW5pdCxcbiAgcm91dGVBbW91bnRzVG9TdHJpbmcsXG4gIFN3YXBSb3V0ZSxcbiAgU3dhcE9wdGlvbnMsXG4gIFN3YXBUeXBlLFxuICBTaW11bGF0aW9uU3RhdHVzLFxuICBJTWV0cmljLFxuICBJRF9UT19ORVRXT1JLX05BTUUsXG59IGZyb20gJ0B1bmlzd2FwL3NtYXJ0LW9yZGVyLXJvdXRlcidcbmltcG9ydCB7IFBvb2wgfSBmcm9tICdAdW5pc3dhcC92My1zZGsnXG5pbXBvcnQgSlNCSSBmcm9tICdqc2JpJ1xuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJ1xuaW1wb3J0IHsgQVBJR0xhbWJkYUhhbmRsZXIsIEVycm9yUmVzcG9uc2UsIEhhbmRsZVJlcXVlc3RQYXJhbXMsIFJlc3BvbnNlIH0gZnJvbSAnLi4vaGFuZGxlcidcbmltcG9ydCB7IENvbnRhaW5lckluamVjdGVkLCBSZXF1ZXN0SW5qZWN0ZWQgfSBmcm9tICcuLi9pbmplY3Rvci1zb3InXG5pbXBvcnQgeyBRdW90ZVJlc3BvbnNlLCBRdW90ZVJlc3BvbnNlU2NoZW1hSm9pLCBWMlBvb2xJblJvdXRlLCBWM1Bvb2xJblJvdXRlIH0gZnJvbSAnLi4vc2NoZW1hJ1xuaW1wb3J0IHtcbiAgREVGQVVMVF9ST1VUSU5HX0NPTkZJR19CWV9DSEFJTixcbiAgcGFyc2VEZWFkbGluZSxcbiAgcGFyc2VTbGlwcGFnZVRvbGVyYW5jZSxcbiAgUVVPVEVfU1BFRURfQ09ORklHLFxuICBJTlRFTlRfU1BFQ0lGSUNfQ09ORklHLFxuICBGRUVfT05fVFJBTlNGRVJfU1BFQ0lGSUNfQ09ORklHLFxuICBwb3B1bGF0ZUZlZU9wdGlvbnMsXG4gIGNvbXB1dGVQb3J0aW9uQW1vdW50LFxufSBmcm9tICcuLi9zaGFyZWQnXG5pbXBvcnQgeyBRdW90ZVF1ZXJ5UGFyYW1zLCBRdW90ZVF1ZXJ5UGFyYW1zSm9pIH0gZnJvbSAnLi9zY2hlbWEvcXVvdGUtc2NoZW1hJ1xuaW1wb3J0IHsgdXRpbHMgfSBmcm9tICdldGhlcnMnXG5pbXBvcnQgeyBzaW11bGF0aW9uU3RhdHVzVG9TdHJpbmcgfSBmcm9tICcuL3V0aWwvc2ltdWxhdGlvbidcbmltcG9ydCBMb2dnZXIgZnJvbSAnYnVueWFuJ1xuaW1wb3J0IHsgUEFJUlNfVE9fVFJBQ0sgfSBmcm9tICcuL3V0aWwvcGFpcnMtdG8tdHJhY2snXG5pbXBvcnQgeyBtZWFzdXJlRGlzdHJpYnV0aW9uUGVyY2VudENoYW5nZUltcGFjdCB9IGZyb20gJy4uLy4uL3V0aWwvYWxwaGEtY29uZmlnLW1lYXN1cmVtZW50J1xuaW1wb3J0IHsgTWV0cmljc0xvZ2dlciB9IGZyb20gJ2F3cy1lbWJlZGRlZC1tZXRyaWNzJ1xuaW1wb3J0IHsgQ3VycmVuY3lMb29rdXAgfSBmcm9tICcuLi9DdXJyZW5jeUxvb2t1cCdcblxuZXhwb3J0IGNsYXNzIFF1b3RlSGFuZGxlciBleHRlbmRzIEFQSUdMYW1iZGFIYW5kbGVyPFxuICBDb250YWluZXJJbmplY3RlZCxcbiAgUmVxdWVzdEluamVjdGVkPElSb3V0ZXI8QWxwaGFSb3V0ZXJDb25maWc+PixcbiAgdm9pZCxcbiAgUXVvdGVRdWVyeVBhcmFtcyxcbiAgUXVvdGVSZXNwb25zZVxuPiB7XG4gIHB1YmxpYyBhc3luYyBoYW5kbGVSZXF1ZXN0KFxuICAgIHBhcmFtczogSGFuZGxlUmVxdWVzdFBhcmFtczxDb250YWluZXJJbmplY3RlZCwgUmVxdWVzdEluamVjdGVkPElSb3V0ZXI8YW55Pj4sIHZvaWQsIFF1b3RlUXVlcnlQYXJhbXM+XG4gICk6IFByb21pc2U8UmVzcG9uc2U8UXVvdGVSZXNwb25zZT4gfCBFcnJvclJlc3BvbnNlPiB7XG4gICAgY29uc3QgeyBjaGFpbklkLCBtZXRyaWMsIGxvZywgcXVvdGVTcGVlZCwgaW50ZW50IH0gPSBwYXJhbXMucmVxdWVzdEluamVjdGVkXG5cbiAgICAvLyBNYXJrIHRoZSBzdGFydCBvZiBjb3JlIGJ1c2luZXNzIGxvZ2ljIGZvciBsYXRlbmN5IGJvb2trZWVwaW5nLlxuICAgIC8vIE5vdGUgdGhhdCBzb21lIHRpbWUgbWF5IGhhdmUgZWxhcHNlZCBiZWZvcmUgaGFuZGxlUmVxdWVzdCB3YXMgY2FsbGVkLCBzbyB0aGlzXG4gICAgLy8gdGltZSBkb2VzIG5vdCBhY2N1cmF0ZWx5IGluZGljYXRlIHdoZW4gb3VyIGxhbWJkYSBzdGFydGVkIHByb2Nlc3NpbmcgdGhlIHJlcXVlc3QsXG4gICAgLy8gcmVzdWx0aW5nIGluIHNsaWdodGx5IHVuZGVycmVwb3J0ZWQgbWV0cmljcy5cbiAgICAvL1xuICAgIC8vIFRvIHVzZSB0aGUgdHJ1ZSByZXF1ZXN0U3RhcnRUaW1lLCB0aGUgcm91dGUgQVBJR0xhbWJkYUhhbmRsZXIgbmVlZHMgdG8gYmVcbiAgICAvLyByZWZhY3RvcmVkIHRvIGNhbGwgaGFuZGxlUmVxdWVzdCB3aXRoIHRoZSBzdGFydFRpbWUuXG4gICAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKVxuXG4gICAgbGV0IHJlc3VsdDogUmVzcG9uc2U8UXVvdGVSZXNwb25zZT4gfCBFcnJvclJlc3BvbnNlXG5cbiAgICB0cnkge1xuICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5oYW5kbGVSZXF1ZXN0SW50ZXJuYWwocGFyYW1zLCBzdGFydFRpbWUpXG5cbiAgICAgIHN3aXRjaCAocmVzdWx0LnN0YXR1c0NvZGUpIHtcbiAgICAgICAgY2FzZSAyMDA6XG4gICAgICAgIGNhc2UgMjAyOlxuICAgICAgICAgIG1ldHJpYy5wdXRNZXRyaWMoYEdFVF9RVU9URV8yMDBfQ0hBSU5JRDogJHtjaGFpbklkfWAsIDEsIE1ldHJpY0xvZ2dlclVuaXQuQ291bnQpXG4gICAgICAgICAgYnJlYWtcbiAgICAgICAgY2FzZSA0MDA6XG4gICAgICAgIGNhc2UgNDAzOlxuICAgICAgICBjYXNlIDQwNDpcbiAgICAgICAgY2FzZSA0MDg6XG4gICAgICAgIGNhc2UgNDA5OlxuICAgICAgICAgIG1ldHJpYy5wdXRNZXRyaWMoYEdFVF9RVU9URV80MDBfQ0hBSU5JRDogJHtjaGFpbklkfWAsIDEsIE1ldHJpY0xvZ2dlclVuaXQuQ291bnQpXG4gICAgICAgICAgbG9nLmVycm9yKFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBzdGF0dXNDb2RlOiByZXN1bHQ/LnN0YXR1c0NvZGUsXG4gICAgICAgICAgICAgIGVycm9yQ29kZTogcmVzdWx0Py5lcnJvckNvZGUsXG4gICAgICAgICAgICAgIGRldGFpbDogcmVzdWx0Py5kZXRhaWwsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgYFF1b3RlIDRYWCBFcnJvciBbJHtyZXN1bHQ/LnN0YXR1c0NvZGV9XSBvbiAke0lEX1RPX05FVFdPUktfTkFNRShjaGFpbklkKX0gd2l0aCBlcnJvckNvZGUgJyR7XG4gICAgICAgICAgICAgIHJlc3VsdD8uZXJyb3JDb2RlXG4gICAgICAgICAgICB9JzogJHtyZXN1bHQ/LmRldGFpbH1gXG4gICAgICAgICAgKVxuICAgICAgICAgIGJyZWFrXG4gICAgICAgIGNhc2UgNTAwOlxuICAgICAgICAgIG1ldHJpYy5wdXRNZXRyaWMoYEdFVF9RVU9URV81MDBfQ0hBSU5JRDogJHtjaGFpbklkfWAsIDEsIE1ldHJpY0xvZ2dlclVuaXQuQ291bnQpXG4gICAgICAgICAgYnJlYWtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoYEdFVF9RVU9URV81MDBfQ0hBSU5JRDogJHtjaGFpbklkfWAsIDEsIE1ldHJpY0xvZ2dlclVuaXQuQ291bnQpXG5cbiAgICAgIHRocm93IGVyclxuICAgIH0gZmluYWxseSB7XG4gICAgICAvLyBUaGlzIG1ldHJpYyBpcyBsb2dnZWQgYWZ0ZXIgY2FsbGluZyB0aGUgaW50ZXJuYWwgaGFuZGxlciB0byBjb3JyZWxhdGUgd2l0aCB0aGUgc3RhdHVzIG1ldHJpY3NcbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoYEdFVF9RVU9URV9SRVFVRVNUX1NPVVJDRTogJHtwYXJhbXMucmVxdWVzdFF1ZXJ5UGFyYW1zLnNvdXJjZX1gLCAxLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuICAgICAgbWV0cmljLnB1dE1ldHJpYyhgR0VUX1FVT1RFX1JFUVVFU1RFRF9DSEFJTklEOiAke2NoYWluSWR9YCwgMSwgTWV0cmljTG9nZ2VyVW5pdC5Db3VudClcbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoYEdFVF9RVU9URV9MQVRFTkNZX0NIQUlOXyR7Y2hhaW5JZH1gLCBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLCBNZXRyaWNMb2dnZXJVbml0Lk1pbGxpc2Vjb25kcylcblxuICAgICAgbWV0cmljLnB1dE1ldHJpYyhcbiAgICAgICAgYEdFVF9RVU9URV9MQVRFTkNZX0NIQUlOXyR7Y2hhaW5JZH1fUVVPVEVfU1BFRURfJHtxdW90ZVNwZWVkID8/ICdzdGFuZGFyZCd9YCxcbiAgICAgICAgRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSxcbiAgICAgICAgTWV0cmljTG9nZ2VyVW5pdC5NaWxsaXNlY29uZHNcbiAgICAgIClcbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoXG4gICAgICAgIGBHRVRfUVVPVEVfTEFURU5DWV9DSEFJTl8ke2NoYWluSWR9X0lOVEVOVF8ke2ludGVudCA/PyAncXVvdGUnfWAsXG4gICAgICAgIERhdGUubm93KCkgLSBzdGFydFRpbWUsXG4gICAgICAgIE1ldHJpY0xvZ2dlclVuaXQuTWlsbGlzZWNvbmRzXG4gICAgICApXG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdFxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBoYW5kbGVSZXF1ZXN0SW50ZXJuYWwoXG4gICAgcGFyYW1zOiBIYW5kbGVSZXF1ZXN0UGFyYW1zPENvbnRhaW5lckluamVjdGVkLCBSZXF1ZXN0SW5qZWN0ZWQ8SVJvdXRlcjxhbnk+Piwgdm9pZCwgUXVvdGVRdWVyeVBhcmFtcz4sXG4gICAgaGFuZGxlUmVxdWVzdFN0YXJ0VGltZTogbnVtYmVyXG4gICk6IFByb21pc2U8UmVzcG9uc2U8UXVvdGVSZXNwb25zZT4gfCBFcnJvclJlc3BvbnNlPiB7XG4gICAgY29uc3Qge1xuICAgICAgcmVxdWVzdFF1ZXJ5UGFyYW1zOiB7XG4gICAgICAgIHRva2VuSW5BZGRyZXNzLFxuICAgICAgICB0b2tlbkluQ2hhaW5JZCxcbiAgICAgICAgdG9rZW5PdXRBZGRyZXNzLFxuICAgICAgICB0b2tlbk91dENoYWluSWQsXG4gICAgICAgIGFtb3VudDogYW1vdW50UmF3LFxuICAgICAgICB0eXBlLFxuICAgICAgICByZWNpcGllbnQsXG4gICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlLFxuICAgICAgICBkZWFkbGluZSxcbiAgICAgICAgbWluU3BsaXRzLFxuICAgICAgICBmb3JjZUNyb3NzUHJvdG9jb2wsXG4gICAgICAgIGZvcmNlTWl4ZWRSb3V0ZXMsXG4gICAgICAgIHByb3RvY29sczogcHJvdG9jb2xzU3RyLFxuICAgICAgICBzaW11bGF0ZUZyb21BZGRyZXNzLFxuICAgICAgICBwZXJtaXRTaWduYXR1cmUsXG4gICAgICAgIHBlcm1pdE5vbmNlLFxuICAgICAgICBwZXJtaXRFeHBpcmF0aW9uLFxuICAgICAgICBwZXJtaXRBbW91bnQsXG4gICAgICAgIHBlcm1pdFNpZ0RlYWRsaW5lLFxuICAgICAgICBlbmFibGVVbml2ZXJzYWxSb3V0ZXIsXG4gICAgICAgIHF1b3RlU3BlZWQsXG4gICAgICAgIGRlYnVnUm91dGluZ0NvbmZpZyxcbiAgICAgICAgdW5pY29yblNlY3JldCxcbiAgICAgICAgaW50ZW50LFxuICAgICAgICBlbmFibGVGZWVPblRyYW5zZmVyRmVlRmV0Y2hpbmcsXG4gICAgICAgIHBvcnRpb25CaXBzLFxuICAgICAgICBwb3J0aW9uQW1vdW50LFxuICAgICAgICBwb3J0aW9uUmVjaXBpZW50LFxuICAgICAgfSxcbiAgICAgIHJlcXVlc3RJbmplY3RlZDoge1xuICAgICAgICByb3V0ZXIsXG4gICAgICAgIGxvZyxcbiAgICAgICAgaWQ6IHF1b3RlSWQsXG4gICAgICAgIGNoYWluSWQsXG4gICAgICAgIHRva2VuUHJvdmlkZXIsXG4gICAgICAgIHRva2VuTGlzdFByb3ZpZGVyLFxuICAgICAgICB2M1Bvb2xQcm92aWRlcjogdjNQb29sUHJvdmlkZXIsXG4gICAgICAgIHYyUG9vbFByb3ZpZGVyOiB2MlBvb2xQcm92aWRlcixcbiAgICAgICAgbWV0cmljLFxuICAgICAgfSxcbiAgICB9ID0gcGFyYW1zXG4gICAgaWYgKHRva2VuSW5DaGFpbklkICE9PSB0b2tlbk91dENoYWluSWQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgZXJyb3JDb2RlOiAnVE9LRU5fQ0hBSU5TX0RJRkZFUkVOVCcsXG4gICAgICAgIGRldGFpbDogYENhbm5vdCByZXF1ZXN0IHF1b3RlcyBmb3IgdG9rZW5zIG9uIGRpZmZlcmVudCBjaGFpbnNgLFxuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBwcm90b2NvbHM6IFByb3RvY29sW10gPSBbXVxuICAgIGlmIChwcm90b2NvbHNTdHIpIHtcbiAgICAgIGZvciAoY29uc3QgcHJvdG9jb2xTdHIgb2YgcHJvdG9jb2xzU3RyKSB7XG4gICAgICAgIHN3aXRjaCAocHJvdG9jb2xTdHIudG9Mb3dlckNhc2UoKSkge1xuICAgICAgICAgIGNhc2UgJ3YyJzpcbiAgICAgICAgICAgIHByb3RvY29scy5wdXNoKFByb3RvY29sLlYyKVxuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICBjYXNlICd2Myc6XG4gICAgICAgICAgICBwcm90b2NvbHMucHVzaChQcm90b2NvbC5WMylcbiAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgY2FzZSAnbWl4ZWQnOlxuICAgICAgICAgICAgcHJvdG9jb2xzLnB1c2goUHJvdG9jb2wuTUlYRUQpXG4gICAgICAgICAgICBicmVha1xuICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgICAgIGVycm9yQ29kZTogJ0lOVkFMSURfUFJPVE9DT0wnLFxuICAgICAgICAgICAgICBkZXRhaWw6IGBJbnZhbGlkIHByb3RvY29sIHNwZWNpZmllZC4gU3VwcG9ydGVkIHByb3RvY29sczogJHtKU09OLnN0cmluZ2lmeShPYmplY3QudmFsdWVzKFByb3RvY29sKSl9YCxcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoIWZvcmNlQ3Jvc3NQcm90b2NvbCkge1xuICAgICAgcHJvdG9jb2xzID0gW1Byb3RvY29sLlYzXVxuICAgIH1cblxuICAgIC8vIFBhcnNlIHVzZXIgcHJvdmlkZWQgdG9rZW4gYWRkcmVzcy9zeW1ib2wgdG8gQ3VycmVuY3kgb2JqZWN0LlxuICAgIGNvbnN0IGN1cnJlbmN5TG9va3VwU3RhcnRUaW1lID0gRGF0ZS5ub3coKVxuICAgIGNvbnN0IGN1cnJlbmN5TG9va3VwID0gbmV3IEN1cnJlbmN5TG9va3VwKHRva2VuTGlzdFByb3ZpZGVyLCB0b2tlblByb3ZpZGVyLCBsb2cpXG4gICAgY29uc3QgW2N1cnJlbmN5SW4sIGN1cnJlbmN5T3V0XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIGN1cnJlbmN5TG9va3VwLnNlYXJjaEZvclRva2VuKHRva2VuSW5BZGRyZXNzLCB0b2tlbkluQ2hhaW5JZCksXG4gICAgICBjdXJyZW5jeUxvb2t1cC5zZWFyY2hGb3JUb2tlbih0b2tlbk91dEFkZHJlc3MsIHRva2VuT3V0Q2hhaW5JZCksXG4gICAgXSlcblxuICAgIG1ldHJpYy5wdXRNZXRyaWMoJ1Rva2VuSW5PdXRTdHJUb1Rva2VuJywgRGF0ZS5ub3coKSAtIGN1cnJlbmN5TG9va3VwU3RhcnRUaW1lLCBNZXRyaWNMb2dnZXJVbml0Lk1pbGxpc2Vjb25kcylcblxuICAgIGlmICghY3VycmVuY3lJbikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBlcnJvckNvZGU6ICdUT0tFTl9JTl9JTlZBTElEJyxcbiAgICAgICAgZGV0YWlsOiBgQ291bGQgbm90IGZpbmQgdG9rZW4gd2l0aCBhZGRyZXNzIFwiJHt0b2tlbkluQWRkcmVzc31cImAsXG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFjdXJyZW5jeU91dCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICBlcnJvckNvZGU6ICdUT0tFTl9PVVRfSU5WQUxJRCcsXG4gICAgICAgIGRldGFpbDogYENvdWxkIG5vdCBmaW5kIHRva2VuIHdpdGggYWRkcmVzcyBcIiR7dG9rZW5PdXRBZGRyZXNzfVwiYCxcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoY3VycmVuY3lJbi5lcXVhbHMoY3VycmVuY3lPdXQpKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgIGVycm9yQ29kZTogJ1RPS0VOX0lOX09VVF9TQU1FJyxcbiAgICAgICAgZGV0YWlsOiBgdG9rZW5JbiBhbmQgdG9rZW5PdXQgbXVzdCBiZSBkaWZmZXJlbnRgLFxuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBwYXJzZWREZWJ1Z1JvdXRpbmdDb25maWcgPSB7fVxuICAgIGlmIChkZWJ1Z1JvdXRpbmdDb25maWcgJiYgdW5pY29yblNlY3JldCAmJiB1bmljb3JuU2VjcmV0ID09PSBwcm9jZXNzLmVudi5VTklDT1JOX1NFQ1JFVCkge1xuICAgICAgcGFyc2VkRGVidWdSb3V0aW5nQ29uZmlnID0gSlNPTi5wYXJzZShkZWJ1Z1JvdXRpbmdDb25maWcpXG4gICAgfVxuXG4gICAgY29uc3Qgcm91dGluZ0NvbmZpZzogQWxwaGFSb3V0ZXJDb25maWcgPSB7XG4gICAgICAuLi5ERUZBVUxUX1JPVVRJTkdfQ09ORklHX0JZX0NIQUlOKGNoYWluSWQpLFxuICAgICAgLi4uKG1pblNwbGl0cyA/IHsgbWluU3BsaXRzIH0gOiB7fSksXG4gICAgICAuLi4oZm9yY2VDcm9zc1Byb3RvY29sID8geyBmb3JjZUNyb3NzUHJvdG9jb2wgfSA6IHt9KSxcbiAgICAgIC4uLihmb3JjZU1peGVkUm91dGVzID8geyBmb3JjZU1peGVkUm91dGVzIH0gOiB7fSksXG4gICAgICBwcm90b2NvbHMsXG4gICAgICAuLi4ocXVvdGVTcGVlZCA/IFFVT1RFX1NQRUVEX0NPTkZJR1txdW90ZVNwZWVkXSA6IHt9KSxcbiAgICAgIC4uLnBhcnNlZERlYnVnUm91dGluZ0NvbmZpZyxcbiAgICAgIC4uLihpbnRlbnQgPyBJTlRFTlRfU1BFQ0lGSUNfQ09ORklHW2ludGVudF0gOiB7fSksXG4gICAgICAvLyBPbmx5IHdoZW4gZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nIGlzIGV4cGxpY2l0bHkgc2V0IHRvIHRydWUsIHRoZW4gd2VcbiAgICAgIC8vIG92ZXJyaWRlIHVzZWRDYWNoZWRSb3V0ZXMgdG8gZmFsc2UuIFRoaXMgaXMgdG8gZW5zdXJlIHRoYXQgd2UgZG9uJ3QgdXNlXG4gICAgICAvLyBhY2NpZGVudGFsbHkgb3ZlcnJpZGUgdXNlZENhY2hlZFJvdXRlcyBpbiB0aGUgbm9ybWFsIHBhdGguXG4gICAgICAuLi4oZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nID8gRkVFX09OX1RSQU5TRkVSX1NQRUNJRklDX0NPTkZJRyhlbmFibGVGZWVPblRyYW5zZmVyRmVlRmV0Y2hpbmcpIDoge30pLFxuICAgIH1cblxuICAgIG1ldHJpYy5wdXRNZXRyaWMoYCR7aW50ZW50fUludGVudGAsIDEsIE1ldHJpY0xvZ2dlclVuaXQuQ291bnQpXG5cbiAgICBsZXQgc3dhcFBhcmFtczogU3dhcE9wdGlvbnMgfCB1bmRlZmluZWQgPSB1bmRlZmluZWRcblxuICAgIC8vIGUuZy4gSW5wdXRzIG9mIGZvcm0gXCIxLjI1JVwiIHdpdGggMmRwIG1heC4gQ29udmVydCB0byBmcmFjdGlvbmFsIHJlcHJlc2VudGF0aW9uID0+IDEuMjUgPT4gMTI1IC8gMTAwMDBcbiAgICBpZiAoc2xpcHBhZ2VUb2xlcmFuY2UpIHtcbiAgICAgIGNvbnN0IHNsaXBwYWdlVG9sZXJhbmNlUGVyY2VudCA9IHBhcnNlU2xpcHBhZ2VUb2xlcmFuY2Uoc2xpcHBhZ2VUb2xlcmFuY2UpXG5cbiAgICAgIC8vIFRPRE86IFJlbW92ZSBvbmNlIHVuaXZlcnNhbCByb3V0ZXIgaXMgbm8gbG9uZ2VyIGJlaGluZCBhIGZlYXR1cmUgZmxhZy5cbiAgICAgIGlmIChlbmFibGVVbml2ZXJzYWxSb3V0ZXIpIHtcbiAgICAgICAgY29uc3QgYWxsRmVlT3B0aW9ucyA9IHBvcHVsYXRlRmVlT3B0aW9ucyhcbiAgICAgICAgICB0eXBlLFxuICAgICAgICAgIHBvcnRpb25CaXBzLFxuICAgICAgICAgIHBvcnRpb25SZWNpcGllbnQsXG4gICAgICAgICAgcG9ydGlvbkFtb3VudCA/P1xuICAgICAgICAgICAgY29tcHV0ZVBvcnRpb25BbW91bnQoQ3VycmVuY3lBbW91bnQuZnJvbVJhd0Ftb3VudChjdXJyZW5jeU91dCwgSlNCSS5CaWdJbnQoYW1vdW50UmF3KSksIHBvcnRpb25CaXBzKVxuICAgICAgICApXG5cbiAgICAgICAgc3dhcFBhcmFtcyA9IHtcbiAgICAgICAgICB0eXBlOiBTd2FwVHlwZS5VTklWRVJTQUxfUk9VVEVSLFxuICAgICAgICAgIGRlYWRsaW5lT3JQcmV2aW91c0Jsb2NraGFzaDogZGVhZGxpbmUgPyBwYXJzZURlYWRsaW5lKGRlYWRsaW5lKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICByZWNpcGllbnQ6IHJlY2lwaWVudCxcbiAgICAgICAgICBzbGlwcGFnZVRvbGVyYW5jZTogc2xpcHBhZ2VUb2xlcmFuY2VQZXJjZW50LFxuICAgICAgICAgIC4uLmFsbEZlZU9wdGlvbnMsXG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChkZWFkbGluZSAmJiByZWNpcGllbnQpIHtcbiAgICAgICAgICBzd2FwUGFyYW1zID0ge1xuICAgICAgICAgICAgdHlwZTogU3dhcFR5cGUuU1dBUF9ST1VURVJfMDIsXG4gICAgICAgICAgICBkZWFkbGluZTogcGFyc2VEZWFkbGluZShkZWFkbGluZSksXG4gICAgICAgICAgICByZWNpcGllbnQ6IHJlY2lwaWVudCxcbiAgICAgICAgICAgIHNsaXBwYWdlVG9sZXJhbmNlOiBzbGlwcGFnZVRvbGVyYW5jZVBlcmNlbnQsXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChcbiAgICAgICAgZW5hYmxlVW5pdmVyc2FsUm91dGVyICYmXG4gICAgICAgIHBlcm1pdFNpZ25hdHVyZSAmJlxuICAgICAgICBwZXJtaXROb25jZSAmJlxuICAgICAgICBwZXJtaXRFeHBpcmF0aW9uICYmXG4gICAgICAgIHBlcm1pdEFtb3VudCAmJlxuICAgICAgICBwZXJtaXRTaWdEZWFkbGluZVxuICAgICAgKSB7XG4gICAgICAgIGNvbnN0IHBlcm1pdDogUGVybWl0U2luZ2xlID0ge1xuICAgICAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgICAgIHRva2VuOiBjdXJyZW5jeUluLndyYXBwZWQuYWRkcmVzcyxcbiAgICAgICAgICAgIGFtb3VudDogcGVybWl0QW1vdW50LFxuICAgICAgICAgICAgZXhwaXJhdGlvbjogcGVybWl0RXhwaXJhdGlvbixcbiAgICAgICAgICAgIG5vbmNlOiBwZXJtaXROb25jZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHNwZW5kZXI6IFVOSVZFUlNBTF9ST1VURVJfQUREUkVTUyhjaGFpbklkKSxcbiAgICAgICAgICBzaWdEZWFkbGluZTogcGVybWl0U2lnRGVhZGxpbmUsXG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc3dhcFBhcmFtcykge1xuICAgICAgICAgIHN3YXBQYXJhbXMuaW5wdXRUb2tlblBlcm1pdCA9IHtcbiAgICAgICAgICAgIC4uLnBlcm1pdCxcbiAgICAgICAgICAgIHNpZ25hdHVyZTogcGVybWl0U2lnbmF0dXJlLFxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgIWVuYWJsZVVuaXZlcnNhbFJvdXRlciAmJlxuICAgICAgICBwZXJtaXRTaWduYXR1cmUgJiZcbiAgICAgICAgKChwZXJtaXROb25jZSAmJiBwZXJtaXRFeHBpcmF0aW9uKSB8fCAocGVybWl0QW1vdW50ICYmIHBlcm1pdFNpZ0RlYWRsaW5lKSlcbiAgICAgICkge1xuICAgICAgICBjb25zdCB7IHYsIHIsIHMgfSA9IHV0aWxzLnNwbGl0U2lnbmF0dXJlKHBlcm1pdFNpZ25hdHVyZSlcblxuICAgICAgICBpZiAoc3dhcFBhcmFtcykge1xuICAgICAgICAgIHN3YXBQYXJhbXMuaW5wdXRUb2tlblBlcm1pdCA9IHtcbiAgICAgICAgICAgIHY6IHYgYXMgMCB8IDEgfCAyNyB8IDI4LFxuICAgICAgICAgICAgcixcbiAgICAgICAgICAgIHMsXG4gICAgICAgICAgICAuLi4ocGVybWl0Tm9uY2UgJiYgcGVybWl0RXhwaXJhdGlvblxuICAgICAgICAgICAgICA/IHsgbm9uY2U6IHBlcm1pdE5vbmNlISwgZXhwaXJ5OiBwZXJtaXRFeHBpcmF0aW9uISB9XG4gICAgICAgICAgICAgIDogeyBhbW91bnQ6IHBlcm1pdEFtb3VudCEsIGRlYWRsaW5lOiBwZXJtaXRTaWdEZWFkbGluZSEgfSksXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChzaW11bGF0ZUZyb21BZGRyZXNzKSB7XG4gICAgICAgIG1ldHJpYy5wdXRNZXRyaWMoJ1NpbXVsYXRpb24gUmVxdWVzdGVkJywgMSwgTWV0cmljTG9nZ2VyVW5pdC5Db3VudClcblxuICAgICAgICBpZiAoc3dhcFBhcmFtcykge1xuICAgICAgICAgIHN3YXBQYXJhbXMuc2ltdWxhdGUgPSB7IGZyb21BZGRyZXNzOiBzaW11bGF0ZUZyb21BZGRyZXNzIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBzd2FwUm91dGU6IFN3YXBSb3V0ZSB8IG51bGxcbiAgICBsZXQgYW1vdW50OiBDdXJyZW5jeUFtb3VudDxDdXJyZW5jeT5cblxuICAgIGxldCB0b2tlblBhaXJTeW1ib2wgPSAnJ1xuICAgIGxldCB0b2tlblBhaXJTeW1ib2xDaGFpbiA9ICcnXG4gICAgaWYgKGN1cnJlbmN5SW4uc3ltYm9sICYmIGN1cnJlbmN5T3V0LnN5bWJvbCkge1xuICAgICAgdG9rZW5QYWlyU3ltYm9sID0gXyhbY3VycmVuY3lJbi5zeW1ib2wsIGN1cnJlbmN5T3V0LnN5bWJvbF0pLmpvaW4oJy8nKVxuICAgICAgdG9rZW5QYWlyU3ltYm9sQ2hhaW4gPSBgJHt0b2tlblBhaXJTeW1ib2x9LyR7Y2hhaW5JZH1gXG4gICAgfVxuXG4gICAgY29uc3QgW3Rva2VuMFN5bWJvbCwgdG9rZW4wQWRkcmVzcywgdG9rZW4xU3ltYm9sLCB0b2tlbjFBZGRyZXNzXSA9IGN1cnJlbmN5SW4ud3JhcHBlZC5zb3J0c0JlZm9yZShcbiAgICAgIGN1cnJlbmN5T3V0LndyYXBwZWRcbiAgICApXG4gICAgICA/IFtjdXJyZW5jeUluLnN5bWJvbCwgY3VycmVuY3lJbi53cmFwcGVkLmFkZHJlc3MsIGN1cnJlbmN5T3V0LnN5bWJvbCwgY3VycmVuY3lPdXQud3JhcHBlZC5hZGRyZXNzXVxuICAgICAgOiBbY3VycmVuY3lPdXQuc3ltYm9sLCBjdXJyZW5jeU91dC53cmFwcGVkLmFkZHJlc3MsIGN1cnJlbmN5SW4uc3ltYm9sLCBjdXJyZW5jeUluLndyYXBwZWQuYWRkcmVzc11cblxuICAgIHN3aXRjaCAodHlwZSkge1xuICAgICAgY2FzZSAnZXhhY3RJbic6XG4gICAgICAgIGFtb3VudCA9IEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoY3VycmVuY3lJbiwgSlNCSS5CaWdJbnQoYW1vdW50UmF3KSlcblxuICAgICAgICBsb2cuaW5mbyhcbiAgICAgICAgICB7XG4gICAgICAgICAgICBhbW91bnRJbjogYW1vdW50LnRvRXhhY3QoKSxcbiAgICAgICAgICAgIHRva2VuMEFkZHJlc3MsXG4gICAgICAgICAgICB0b2tlbjFBZGRyZXNzLFxuICAgICAgICAgICAgdG9rZW4wU3ltYm9sLFxuICAgICAgICAgICAgdG9rZW4xU3ltYm9sLFxuICAgICAgICAgICAgdG9rZW5JblN5bWJvbDogY3VycmVuY3lJbi5zeW1ib2wsXG4gICAgICAgICAgICB0b2tlbk91dFN5bWJvbDogY3VycmVuY3lPdXQuc3ltYm9sLFxuICAgICAgICAgICAgdG9rZW5QYWlyU3ltYm9sLFxuICAgICAgICAgICAgdG9rZW5QYWlyU3ltYm9sQ2hhaW4sXG4gICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgcm91dGluZ0NvbmZpZzogcm91dGluZ0NvbmZpZyxcbiAgICAgICAgICAgIHN3YXBQYXJhbXMsXG4gICAgICAgICAgICBpbnRlbnQsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBgRXhhY3QgSW4gU3dhcDogR2l2ZSAke2Ftb3VudC50b0V4YWN0KCl9ICR7YW1vdW50LmN1cnJlbmN5LnN5bWJvbH0sIFdhbnQ6ICR7XG4gICAgICAgICAgICBjdXJyZW5jeU91dC5zeW1ib2xcbiAgICAgICAgICB9LiBDaGFpbjogJHtjaGFpbklkfWBcbiAgICAgICAgKVxuXG4gICAgICAgIHN3YXBSb3V0ZSA9IGF3YWl0IHJvdXRlci5yb3V0ZShhbW91bnQsIGN1cnJlbmN5T3V0LCBUcmFkZVR5cGUuRVhBQ1RfSU5QVVQsIHN3YXBQYXJhbXMsIHJvdXRpbmdDb25maWcpXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICdleGFjdE91dCc6XG4gICAgICAgIGFtb3VudCA9IEN1cnJlbmN5QW1vdW50LmZyb21SYXdBbW91bnQoY3VycmVuY3lPdXQsIEpTQkkuQmlnSW50KGFtb3VudFJhdykpXG5cbiAgICAgICAgbG9nLmluZm8oXG4gICAgICAgICAge1xuICAgICAgICAgICAgYW1vdW50T3V0OiBhbW91bnQudG9FeGFjdCgpLFxuICAgICAgICAgICAgdG9rZW4wQWRkcmVzcyxcbiAgICAgICAgICAgIHRva2VuMUFkZHJlc3MsXG4gICAgICAgICAgICB0b2tlbjBTeW1ib2wsXG4gICAgICAgICAgICB0b2tlbjFTeW1ib2wsXG4gICAgICAgICAgICB0b2tlbkluU3ltYm9sOiBjdXJyZW5jeUluLnN5bWJvbCxcbiAgICAgICAgICAgIHRva2VuT3V0U3ltYm9sOiBjdXJyZW5jeU91dC5zeW1ib2wsXG4gICAgICAgICAgICB0b2tlblBhaXJTeW1ib2wsXG4gICAgICAgICAgICB0b2tlblBhaXJTeW1ib2xDaGFpbixcbiAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICByb3V0aW5nQ29uZmlnOiByb3V0aW5nQ29uZmlnLFxuICAgICAgICAgICAgc3dhcFBhcmFtcyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGBFeGFjdCBPdXQgU3dhcDogV2FudCAke2Ftb3VudC50b0V4YWN0KCl9ICR7YW1vdW50LmN1cnJlbmN5LnN5bWJvbH0gR2l2ZTogJHtcbiAgICAgICAgICAgIGN1cnJlbmN5SW4uc3ltYm9sXG4gICAgICAgICAgfS4gQ2hhaW46ICR7Y2hhaW5JZH1gXG4gICAgICAgIClcblxuICAgICAgICBzd2FwUm91dGUgPSBhd2FpdCByb3V0ZXIucm91dGUoYW1vdW50LCBjdXJyZW5jeUluLCBUcmFkZVR5cGUuRVhBQ1RfT1VUUFVULCBzd2FwUGFyYW1zLCByb3V0aW5nQ29uZmlnKVxuICAgICAgICBicmVha1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIHN3YXAgdHlwZScpXG4gICAgfVxuXG4gICAgaWYgKCFzd2FwUm91dGUpIHtcbiAgICAgIGxvZy5pbmZvKFxuICAgICAgICB7XG4gICAgICAgICAgdHlwZSxcbiAgICAgICAgICB0b2tlbkluOiBjdXJyZW5jeUluLFxuICAgICAgICAgIHRva2VuT3V0OiBjdXJyZW5jeU91dCxcbiAgICAgICAgICBhbW91bnQ6IGFtb3VudC5xdW90aWVudC50b1N0cmluZygpLFxuICAgICAgICB9LFxuICAgICAgICBgTm8gcm91dGUgZm91bmQuIDQwNGBcbiAgICAgIClcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgICBlcnJvckNvZGU6ICdOT19ST1VURScsXG4gICAgICAgIGRldGFpbDogJ05vIHJvdXRlIGZvdW5kJyxcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCB7XG4gICAgICBxdW90ZSxcbiAgICAgIHF1b3RlR2FzQWRqdXN0ZWQsXG4gICAgICBxdW90ZUdhc0FuZFBvcnRpb25BZGp1c3RlZCxcbiAgICAgIHJvdXRlLFxuICAgICAgZXN0aW1hdGVkR2FzVXNlZCxcbiAgICAgIGVzdGltYXRlZEdhc1VzZWRRdW90ZVRva2VuLFxuICAgICAgZXN0aW1hdGVkR2FzVXNlZFVTRCxcbiAgICAgIGdhc1ByaWNlV2VpLFxuICAgICAgbWV0aG9kUGFyYW1ldGVycyxcbiAgICAgIGJsb2NrTnVtYmVyLFxuICAgICAgc2ltdWxhdGlvblN0YXR1cyxcbiAgICAgIGhpdHNDYWNoZWRSb3V0ZSxcbiAgICAgIHBvcnRpb25BbW91bnQ6IG91dHB1dFBvcnRpb25BbW91bnQsIC8vIFRPRE86IG5hbWUgaXQgYmFjayB0byBwb3J0aW9uQW1vdW50XG4gICAgfSA9IHN3YXBSb3V0ZVxuXG4gICAgaWYgKHNpbXVsYXRpb25TdGF0dXMgPT0gU2ltdWxhdGlvblN0YXR1cy5GYWlsZWQpIHtcbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoJ1NpbXVsYXRpb25GYWlsZWQnLCAxLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuICAgIH0gZWxzZSBpZiAoc2ltdWxhdGlvblN0YXR1cyA9PSBTaW11bGF0aW9uU3RhdHVzLlN1Y2NlZWRlZCkge1xuICAgICAgbWV0cmljLnB1dE1ldHJpYygnU2ltdWxhdGlvblN1Y2Nlc3NmdWwnLCAxLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuICAgIH0gZWxzZSBpZiAoc2ltdWxhdGlvblN0YXR1cyA9PSBTaW11bGF0aW9uU3RhdHVzLkluc3VmZmljaWVudEJhbGFuY2UpIHtcbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoJ1NpbXVsYXRpb25JbnN1ZmZpY2llbnRCYWxhbmNlJywgMSwgTWV0cmljTG9nZ2VyVW5pdC5Db3VudClcbiAgICB9IGVsc2UgaWYgKHNpbXVsYXRpb25TdGF0dXMgPT0gU2ltdWxhdGlvblN0YXR1cy5Ob3RBcHByb3ZlZCkge1xuICAgICAgbWV0cmljLnB1dE1ldHJpYygnU2ltdWxhdGlvbk5vdEFwcHJvdmVkJywgMSwgTWV0cmljTG9nZ2VyVW5pdC5Db3VudClcbiAgICB9IGVsc2UgaWYgKHNpbXVsYXRpb25TdGF0dXMgPT0gU2ltdWxhdGlvblN0YXR1cy5Ob3RTdXBwb3J0ZWQpIHtcbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoJ1NpbXVsYXRpb25Ob3RTdXBwb3J0ZWQnLCAxLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuICAgIH1cblxuICAgIGNvbnN0IHJvdXRlUmVzcG9uc2U6IEFycmF5PChWM1Bvb2xJblJvdXRlIHwgVjJQb29sSW5Sb3V0ZSlbXT4gPSBbXVxuXG4gICAgZm9yIChjb25zdCBzdWJSb3V0ZSBvZiByb3V0ZSkge1xuICAgICAgY29uc3QgeyBhbW91bnQsIHF1b3RlLCB0b2tlblBhdGggfSA9IHN1YlJvdXRlXG5cbiAgICAgIGNvbnN0IHBvb2xzID0gc3ViUm91dGUucHJvdG9jb2wgPT0gUHJvdG9jb2wuVjIgPyBzdWJSb3V0ZS5yb3V0ZS5wYWlycyA6IHN1YlJvdXRlLnJvdXRlLnBvb2xzXG4gICAgICBjb25zdCBjdXJSb3V0ZTogKFYzUG9vbEluUm91dGUgfCBWMlBvb2xJblJvdXRlKVtdID0gW11cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcG9vbHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgbmV4dFBvb2wgPSBwb29sc1tpXVxuICAgICAgICBjb25zdCB0b2tlbkluID0gdG9rZW5QYXRoW2ldXG4gICAgICAgIGNvbnN0IHRva2VuT3V0ID0gdG9rZW5QYXRoW2kgKyAxXVxuXG4gICAgICAgIGxldCBlZGdlQW1vdW50SW4gPSB1bmRlZmluZWRcbiAgICAgICAgaWYgKGkgPT0gMCkge1xuICAgICAgICAgIGVkZ2VBbW91bnRJbiA9IHR5cGUgPT0gJ2V4YWN0SW4nID8gYW1vdW50LnF1b3RpZW50LnRvU3RyaW5nKCkgOiBxdW90ZS5xdW90aWVudC50b1N0cmluZygpXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZWRnZUFtb3VudE91dCA9IHVuZGVmaW5lZFxuICAgICAgICBpZiAoaSA9PSBwb29scy5sZW5ndGggLSAxKSB7XG4gICAgICAgICAgZWRnZUFtb3VudE91dCA9IHR5cGUgPT0gJ2V4YWN0SW4nID8gcXVvdGUucXVvdGllbnQudG9TdHJpbmcoKSA6IGFtb3VudC5xdW90aWVudC50b1N0cmluZygpXG4gICAgICAgIH1cblxuICAgICAgICBpZiAobmV4dFBvb2wgaW5zdGFuY2VvZiBQb29sKSB7XG4gICAgICAgICAgY3VyUm91dGUucHVzaCh7XG4gICAgICAgICAgICB0eXBlOiAndjMtcG9vbCcsXG4gICAgICAgICAgICBhZGRyZXNzOiB2M1Bvb2xQcm92aWRlci5nZXRQb29sQWRkcmVzcyhuZXh0UG9vbC50b2tlbjAsIG5leHRQb29sLnRva2VuMSwgbmV4dFBvb2wuZmVlKS5wb29sQWRkcmVzcyxcbiAgICAgICAgICAgIHRva2VuSW46IHtcbiAgICAgICAgICAgICAgY2hhaW5JZDogdG9rZW5Jbi5jaGFpbklkLFxuICAgICAgICAgICAgICBkZWNpbWFsczogdG9rZW5Jbi5kZWNpbWFscy50b1N0cmluZygpLFxuICAgICAgICAgICAgICBhZGRyZXNzOiB0b2tlbkluLmFkZHJlc3MsXG4gICAgICAgICAgICAgIHN5bWJvbDogdG9rZW5Jbi5zeW1ib2whLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHRva2VuT3V0OiB7XG4gICAgICAgICAgICAgIGNoYWluSWQ6IHRva2VuT3V0LmNoYWluSWQsXG4gICAgICAgICAgICAgIGRlY2ltYWxzOiB0b2tlbk91dC5kZWNpbWFscy50b1N0cmluZygpLFxuICAgICAgICAgICAgICBhZGRyZXNzOiB0b2tlbk91dC5hZGRyZXNzLFxuICAgICAgICAgICAgICBzeW1ib2w6IHRva2VuT3V0LnN5bWJvbCEsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZmVlOiBuZXh0UG9vbC5mZWUudG9TdHJpbmcoKSxcbiAgICAgICAgICAgIGxpcXVpZGl0eTogbmV4dFBvb2wubGlxdWlkaXR5LnRvU3RyaW5nKCksXG4gICAgICAgICAgICBzcXJ0UmF0aW9YOTY6IG5leHRQb29sLnNxcnRSYXRpb1g5Ni50b1N0cmluZygpLFxuICAgICAgICAgICAgdGlja0N1cnJlbnQ6IG5leHRQb29sLnRpY2tDdXJyZW50LnRvU3RyaW5nKCksXG4gICAgICAgICAgICBhbW91bnRJbjogZWRnZUFtb3VudEluLFxuICAgICAgICAgICAgYW1vdW50T3V0OiBlZGdlQW1vdW50T3V0LFxuICAgICAgICAgIH0pXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgcmVzZXJ2ZTAgPSBuZXh0UG9vbC5yZXNlcnZlMFxuICAgICAgICAgIGNvbnN0IHJlc2VydmUxID0gbmV4dFBvb2wucmVzZXJ2ZTFcblxuICAgICAgICAgIGN1clJvdXRlLnB1c2goe1xuICAgICAgICAgICAgdHlwZTogJ3YyLXBvb2wnLFxuICAgICAgICAgICAgYWRkcmVzczogdjJQb29sUHJvdmlkZXIuZ2V0UG9vbEFkZHJlc3MobmV4dFBvb2wudG9rZW4wLCBuZXh0UG9vbC50b2tlbjEpLnBvb2xBZGRyZXNzLFxuICAgICAgICAgICAgdG9rZW5Jbjoge1xuICAgICAgICAgICAgICBjaGFpbklkOiB0b2tlbkluLmNoYWluSWQsXG4gICAgICAgICAgICAgIGRlY2ltYWxzOiB0b2tlbkluLmRlY2ltYWxzLnRvU3RyaW5nKCksXG4gICAgICAgICAgICAgIGFkZHJlc3M6IHRva2VuSW4uYWRkcmVzcyxcbiAgICAgICAgICAgICAgc3ltYm9sOiB0b2tlbkluLnN5bWJvbCEsXG4gICAgICAgICAgICAgIGJ1eUZlZUJwczogdGhpcy5kZXJpdmVCdXlGZWVCcHModG9rZW5JbiwgcmVzZXJ2ZTAsIHJlc2VydmUxLCBlbmFibGVGZWVPblRyYW5zZmVyRmVlRmV0Y2hpbmcpLFxuICAgICAgICAgICAgICBzZWxsRmVlQnBzOiB0aGlzLmRlcml2ZVNlbGxGZWVCcHModG9rZW5JbiwgcmVzZXJ2ZTAsIHJlc2VydmUxLCBlbmFibGVGZWVPblRyYW5zZmVyRmVlRmV0Y2hpbmcpLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHRva2VuT3V0OiB7XG4gICAgICAgICAgICAgIGNoYWluSWQ6IHRva2VuT3V0LmNoYWluSWQsXG4gICAgICAgICAgICAgIGRlY2ltYWxzOiB0b2tlbk91dC5kZWNpbWFscy50b1N0cmluZygpLFxuICAgICAgICAgICAgICBhZGRyZXNzOiB0b2tlbk91dC5hZGRyZXNzLFxuICAgICAgICAgICAgICBzeW1ib2w6IHRva2VuT3V0LnN5bWJvbCEsXG4gICAgICAgICAgICAgIGJ1eUZlZUJwczogdGhpcy5kZXJpdmVCdXlGZWVCcHModG9rZW5PdXQsIHJlc2VydmUwLCByZXNlcnZlMSwgZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nKSxcbiAgICAgICAgICAgICAgc2VsbEZlZUJwczogdGhpcy5kZXJpdmVTZWxsRmVlQnBzKHRva2VuT3V0LCByZXNlcnZlMCwgcmVzZXJ2ZTEsIGVuYWJsZUZlZU9uVHJhbnNmZXJGZWVGZXRjaGluZyksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcmVzZXJ2ZTA6IHtcbiAgICAgICAgICAgICAgdG9rZW46IHtcbiAgICAgICAgICAgICAgICBjaGFpbklkOiByZXNlcnZlMC5jdXJyZW5jeS53cmFwcGVkLmNoYWluSWQsXG4gICAgICAgICAgICAgICAgZGVjaW1hbHM6IHJlc2VydmUwLmN1cnJlbmN5LndyYXBwZWQuZGVjaW1hbHMudG9TdHJpbmcoKSxcbiAgICAgICAgICAgICAgICBhZGRyZXNzOiByZXNlcnZlMC5jdXJyZW5jeS53cmFwcGVkLmFkZHJlc3MsXG4gICAgICAgICAgICAgICAgc3ltYm9sOiByZXNlcnZlMC5jdXJyZW5jeS53cmFwcGVkLnN5bWJvbCEsXG4gICAgICAgICAgICAgICAgYnV5RmVlQnBzOiB0aGlzLmRlcml2ZUJ1eUZlZUJwcyhcbiAgICAgICAgICAgICAgICAgIHJlc2VydmUwLmN1cnJlbmN5LndyYXBwZWQsXG4gICAgICAgICAgICAgICAgICByZXNlcnZlMCxcbiAgICAgICAgICAgICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgIGVuYWJsZUZlZU9uVHJhbnNmZXJGZWVGZXRjaGluZ1xuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgc2VsbEZlZUJwczogdGhpcy5kZXJpdmVTZWxsRmVlQnBzKFxuICAgICAgICAgICAgICAgICAgcmVzZXJ2ZTAuY3VycmVuY3kud3JhcHBlZCxcbiAgICAgICAgICAgICAgICAgIHJlc2VydmUwLFxuICAgICAgICAgICAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgcXVvdGllbnQ6IHJlc2VydmUwLnF1b3RpZW50LnRvU3RyaW5nKCksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcmVzZXJ2ZTE6IHtcbiAgICAgICAgICAgICAgdG9rZW46IHtcbiAgICAgICAgICAgICAgICBjaGFpbklkOiByZXNlcnZlMS5jdXJyZW5jeS53cmFwcGVkLmNoYWluSWQsXG4gICAgICAgICAgICAgICAgZGVjaW1hbHM6IHJlc2VydmUxLmN1cnJlbmN5LndyYXBwZWQuZGVjaW1hbHMudG9TdHJpbmcoKSxcbiAgICAgICAgICAgICAgICBhZGRyZXNzOiByZXNlcnZlMS5jdXJyZW5jeS53cmFwcGVkLmFkZHJlc3MsXG4gICAgICAgICAgICAgICAgc3ltYm9sOiByZXNlcnZlMS5jdXJyZW5jeS53cmFwcGVkLnN5bWJvbCEsXG4gICAgICAgICAgICAgICAgYnV5RmVlQnBzOiB0aGlzLmRlcml2ZUJ1eUZlZUJwcyhcbiAgICAgICAgICAgICAgICAgIHJlc2VydmUxLmN1cnJlbmN5LndyYXBwZWQsXG4gICAgICAgICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICByZXNlcnZlMSxcbiAgICAgICAgICAgICAgICAgIGVuYWJsZUZlZU9uVHJhbnNmZXJGZWVGZXRjaGluZ1xuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgc2VsbEZlZUJwczogdGhpcy5kZXJpdmVTZWxsRmVlQnBzKFxuICAgICAgICAgICAgICAgICAgcmVzZXJ2ZTEuY3VycmVuY3kud3JhcHBlZCxcbiAgICAgICAgICAgICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgIHJlc2VydmUxLFxuICAgICAgICAgICAgICAgICAgZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgcXVvdGllbnQ6IHJlc2VydmUxLnF1b3RpZW50LnRvU3RyaW5nKCksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgYW1vdW50SW46IGVkZ2VBbW91bnRJbixcbiAgICAgICAgICAgIGFtb3VudE91dDogZWRnZUFtb3VudE91dCxcbiAgICAgICAgICB9KVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJvdXRlUmVzcG9uc2UucHVzaChjdXJSb3V0ZSlcbiAgICB9XG5cbiAgICBjb25zdCByb3V0ZVN0cmluZyA9IHJvdXRlQW1vdW50c1RvU3RyaW5nKHJvdXRlKVxuXG4gICAgY29uc3QgcmVzdWx0OiBRdW90ZVJlc3BvbnNlID0ge1xuICAgICAgbWV0aG9kUGFyYW1ldGVycyxcbiAgICAgIGJsb2NrTnVtYmVyOiBibG9ja051bWJlci50b1N0cmluZygpLFxuICAgICAgYW1vdW50OiBhbW91bnQucXVvdGllbnQudG9TdHJpbmcoKSxcbiAgICAgIGFtb3VudERlY2ltYWxzOiBhbW91bnQudG9FeGFjdCgpLFxuICAgICAgcXVvdGU6IHF1b3RlLnF1b3RpZW50LnRvU3RyaW5nKCksXG4gICAgICBxdW90ZURlY2ltYWxzOiBxdW90ZS50b0V4YWN0KCksXG4gICAgICBxdW90ZUdhc0FkanVzdGVkOiBxdW90ZUdhc0FkanVzdGVkLnF1b3RpZW50LnRvU3RyaW5nKCksXG4gICAgICBxdW90ZUdhc0FkanVzdGVkRGVjaW1hbHM6IHF1b3RlR2FzQWRqdXN0ZWQudG9FeGFjdCgpLFxuICAgICAgcXVvdGVHYXNBbmRQb3J0aW9uQWRqdXN0ZWQ6IHF1b3RlR2FzQW5kUG9ydGlvbkFkanVzdGVkPy5xdW90aWVudC50b1N0cmluZygpLFxuICAgICAgcXVvdGVHYXNBbmRQb3J0aW9uQWRqdXN0ZWREZWNpbWFsczogcXVvdGVHYXNBbmRQb3J0aW9uQWRqdXN0ZWQ/LnRvRXhhY3QoKSxcbiAgICAgIGdhc1VzZUVzdGltYXRlUXVvdGU6IGVzdGltYXRlZEdhc1VzZWRRdW90ZVRva2VuLnF1b3RpZW50LnRvU3RyaW5nKCksXG4gICAgICBnYXNVc2VFc3RpbWF0ZVF1b3RlRGVjaW1hbHM6IGVzdGltYXRlZEdhc1VzZWRRdW90ZVRva2VuLnRvRXhhY3QoKSxcbiAgICAgIGdhc1VzZUVzdGltYXRlOiBlc3RpbWF0ZWRHYXNVc2VkLnRvU3RyaW5nKCksXG4gICAgICBnYXNVc2VFc3RpbWF0ZVVTRDogZXN0aW1hdGVkR2FzVXNlZFVTRC50b0V4YWN0KCksXG4gICAgICBzaW11bGF0aW9uU3RhdHVzOiBzaW11bGF0aW9uU3RhdHVzVG9TdHJpbmcoc2ltdWxhdGlvblN0YXR1cywgbG9nKSxcbiAgICAgIHNpbXVsYXRpb25FcnJvcjogc2ltdWxhdGlvblN0YXR1cyA9PSBTaW11bGF0aW9uU3RhdHVzLkZhaWxlZCxcbiAgICAgIGdhc1ByaWNlV2VpOiBnYXNQcmljZVdlaS50b1N0cmluZygpLFxuICAgICAgcm91dGU6IHJvdXRlUmVzcG9uc2UsXG4gICAgICByb3V0ZVN0cmluZyxcbiAgICAgIHF1b3RlSWQsXG4gICAgICBoaXRzQ2FjaGVkUm91dGVzOiBoaXRzQ2FjaGVkUm91dGUsXG4gICAgICBwb3J0aW9uQmlwczogcG9ydGlvbkJpcHMsXG4gICAgICBwb3J0aW9uUmVjaXBpZW50OiBwb3J0aW9uUmVjaXBpZW50LFxuICAgICAgcG9ydGlvbkFtb3VudDogb3V0cHV0UG9ydGlvbkFtb3VudD8ucXVvdGllbnQudG9TdHJpbmcoKSxcbiAgICAgIHBvcnRpb25BbW91bnREZWNpbWFsczogb3V0cHV0UG9ydGlvbkFtb3VudD8udG9FeGFjdCgpLFxuICAgIH1cblxuICAgIHRoaXMubG9nUm91dGVNZXRyaWNzKFxuICAgICAgbG9nLFxuICAgICAgbWV0cmljLFxuICAgICAgaGFuZGxlUmVxdWVzdFN0YXJ0VGltZSxcbiAgICAgIGN1cnJlbmN5SW4sXG4gICAgICBjdXJyZW5jeU91dCxcbiAgICAgIHRva2VuSW5BZGRyZXNzLFxuICAgICAgdG9rZW5PdXRBZGRyZXNzLFxuICAgICAgdHlwZSxcbiAgICAgIGNoYWluSWQsXG4gICAgICBhbW91bnQsXG4gICAgICByb3V0ZVN0cmluZyxcbiAgICAgIHN3YXBSb3V0ZVxuICAgIClcblxuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICBib2R5OiByZXN1bHQsXG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBkZXJpdmVCdXlGZWVCcHMoXG4gICAgdG9rZW46IEN1cnJlbmN5LFxuICAgIHJlc2VydmUwPzogQ3VycmVuY3lBbW91bnQ8VG9rZW4+LFxuICAgIHJlc2VydmUxPzogQ3VycmVuY3lBbW91bnQ8VG9rZW4+LFxuICAgIGVuYWJsZUZlZU9uVHJhbnNmZXJGZWVGZXRjaGluZz86IGJvb2xlYW5cbiAgKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoIWVuYWJsZUZlZU9uVHJhbnNmZXJGZWVGZXRjaGluZykge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZFxuICAgIH1cblxuICAgIGlmIChyZXNlcnZlMD8uY3VycmVuY3kuZXF1YWxzKHRva2VuKSkge1xuICAgICAgcmV0dXJuIHJlc2VydmUwLmN1cnJlbmN5LmJ1eUZlZUJwcz8udG9TdHJpbmcoKVxuICAgIH1cblxuICAgIGlmIChyZXNlcnZlMT8uY3VycmVuY3kuZXF1YWxzKHRva2VuKSkge1xuICAgICAgcmV0dXJuIHJlc2VydmUxLmN1cnJlbmN5LmJ1eUZlZUJwcz8udG9TdHJpbmcoKVxuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWRcbiAgfVxuXG4gIHByaXZhdGUgZGVyaXZlU2VsbEZlZUJwcyhcbiAgICB0b2tlbjogQ3VycmVuY3ksXG4gICAgcmVzZXJ2ZTA/OiBDdXJyZW5jeUFtb3VudDxUb2tlbj4sXG4gICAgcmVzZXJ2ZTE/OiBDdXJyZW5jeUFtb3VudDxUb2tlbj4sXG4gICAgZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nPzogYm9vbGVhblxuICApOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIGlmICghZW5hYmxlRmVlT25UcmFuc2ZlckZlZUZldGNoaW5nKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkXG4gICAgfVxuXG4gICAgaWYgKHJlc2VydmUwPy5jdXJyZW5jeS5lcXVhbHModG9rZW4pKSB7XG4gICAgICByZXR1cm4gcmVzZXJ2ZTAuY3VycmVuY3kuc2VsbEZlZUJwcz8udG9TdHJpbmcoKVxuICAgIH1cblxuICAgIGlmIChyZXNlcnZlMT8uY3VycmVuY3kuZXF1YWxzKHRva2VuKSkge1xuICAgICAgcmV0dXJuIHJlc2VydmUxLmN1cnJlbmN5LnNlbGxGZWVCcHM/LnRvU3RyaW5nKClcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkXG4gIH1cblxuICBwcml2YXRlIGxvZ1JvdXRlTWV0cmljcyhcbiAgICBsb2c6IExvZ2dlcixcbiAgICBtZXRyaWM6IElNZXRyaWMsXG4gICAgaGFuZGxlUmVxdWVzdFN0YXJ0VGltZTogbnVtYmVyLFxuICAgIGN1cnJlbmN5SW46IEN1cnJlbmN5LFxuICAgIGN1cnJlbmN5T3V0OiBDdXJyZW5jeSxcbiAgICB0b2tlbkluQWRkcmVzczogc3RyaW5nLFxuICAgIHRva2VuT3V0QWRkcmVzczogc3RyaW5nLFxuICAgIHRyYWRlVHlwZTogJ2V4YWN0SW4nIHwgJ2V4YWN0T3V0JyxcbiAgICBjaGFpbklkOiBDaGFpbklkLFxuICAgIGFtb3VudDogQ3VycmVuY3lBbW91bnQ8Q3VycmVuY3k+LFxuICAgIHJvdXRlU3RyaW5nOiBzdHJpbmcsXG4gICAgc3dhcFJvdXRlOiBTd2FwUm91dGVcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgdHJhZGluZ1BhaXIgPSBgJHtjdXJyZW5jeUluLndyYXBwZWQuc3ltYm9sfS8ke2N1cnJlbmN5T3V0LndyYXBwZWQuc3ltYm9sfWBcbiAgICBjb25zdCB3aWxkY2FyZEluUGFpciA9IGAke2N1cnJlbmN5SW4ud3JhcHBlZC5zeW1ib2x9LypgXG4gICAgY29uc3Qgd2lsZGNhcmRPdXRQYWlyID0gYCovJHtjdXJyZW5jeU91dC53cmFwcGVkLnN5bWJvbH1gXG4gICAgY29uc3QgdHJhZGVUeXBlRW51bVZhbHVlID0gdHJhZGVUeXBlID09ICdleGFjdEluJyA/IFRyYWRlVHlwZS5FWEFDVF9JTlBVVCA6IFRyYWRlVHlwZS5FWEFDVF9PVVRQVVRcbiAgICBjb25zdCBwYWlyc1RyYWNrZWQgPSBQQUlSU19UT19UUkFDSy5nZXQoY2hhaW5JZCk/LmdldCh0cmFkZVR5cGVFbnVtVmFsdWUpXG5cbiAgICBtZWFzdXJlRGlzdHJpYnV0aW9uUGVyY2VudENoYW5nZUltcGFjdCg1LCAxMCwgc3dhcFJvdXRlLCBjdXJyZW5jeUluLCBjdXJyZW5jeU91dCwgdHJhZGVUeXBlLCBjaGFpbklkLCBhbW91bnQpXG5cbiAgICBpZiAoXG4gICAgICBwYWlyc1RyYWNrZWQ/LmluY2x1ZGVzKHRyYWRpbmdQYWlyKSB8fFxuICAgICAgcGFpcnNUcmFja2VkPy5pbmNsdWRlcyh3aWxkY2FyZEluUGFpcikgfHxcbiAgICAgIHBhaXJzVHJhY2tlZD8uaW5jbHVkZXMod2lsZGNhcmRPdXRQYWlyKVxuICAgICkge1xuICAgICAgY29uc3QgbWV0cmljUGFpciA9IHBhaXJzVHJhY2tlZD8uaW5jbHVkZXModHJhZGluZ1BhaXIpXG4gICAgICAgID8gdHJhZGluZ1BhaXJcbiAgICAgICAgOiBwYWlyc1RyYWNrZWQ/LmluY2x1ZGVzKHdpbGRjYXJkSW5QYWlyKVxuICAgICAgICA/IHdpbGRjYXJkSW5QYWlyXG4gICAgICAgIDogd2lsZGNhcmRPdXRQYWlyXG5cbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoXG4gICAgICAgIGBHRVRfUVVPVEVfQU1PVU5UXyR7bWV0cmljUGFpcn1fJHt0cmFkZVR5cGUudG9VcHBlckNhc2UoKX1fQ0hBSU5fJHtjaGFpbklkfWAsXG4gICAgICAgIE51bWJlcihhbW91bnQudG9FeGFjdCgpKSxcbiAgICAgICAgTWV0cmljTG9nZ2VyVW5pdC5Ob25lXG4gICAgICApXG5cbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoXG4gICAgICAgIGBHRVRfUVVPVEVfTEFURU5DWV8ke21ldHJpY1BhaXJ9XyR7dHJhZGVUeXBlLnRvVXBwZXJDYXNlKCl9X0NIQUlOXyR7Y2hhaW5JZH1gLFxuICAgICAgICBEYXRlLm5vdygpIC0gaGFuZGxlUmVxdWVzdFN0YXJ0VGltZSxcbiAgICAgICAgTWV0cmljTG9nZ2VyVW5pdC5NaWxsaXNlY29uZHNcbiAgICAgIClcblxuICAgICAgLy8gQ3JlYXRlIGEgaGFzaGNvZGUgZnJvbSB0aGUgcm91dGVTdHJpbmcsIHRoaXMgd2lsbCBpbmRpY2F0ZSB0aGF0IGEgZGlmZmVyZW50IHJvdXRlIGlzIGJlaW5nIHVzZWRcbiAgICAgIC8vIGhhc2hjb2RlIGZ1bmN0aW9uIGNvcGllZCBmcm9tOiBodHRwczovL2dpc3QuZ2l0aHViLmNvbS9oeWFtYW1vdG8vZmQ0MzU1MDVkMjllYmZhM2Q5NzE2ZmQyYmU4ZDQyZjA/cGVybWFsaW5rX2NvbW1lbnRfaWQ9NDI2MTcyOCNnaXN0Y29tbWVudC00MjYxNzI4XG4gICAgICBjb25zdCByb3V0ZVN0cmluZ0hhc2ggPSBNYXRoLmFicyhcbiAgICAgICAgcm91dGVTdHJpbmcuc3BsaXQoJycpLnJlZHVjZSgocywgYykgPT4gKE1hdGguaW11bCgzMSwgcykgKyBjLmNoYXJDb2RlQXQoMCkpIHwgMCwgMClcbiAgICAgIClcbiAgICAgIC8vIExvZyB0aGUgY2hvc2Ugcm91dGVcbiAgICAgIGxvZy5pbmZvKFxuICAgICAgICB7XG4gICAgICAgICAgdHJhZGluZ1BhaXIsXG4gICAgICAgICAgdG9rZW5JbkFkZHJlc3MsXG4gICAgICAgICAgdG9rZW5PdXRBZGRyZXNzLFxuICAgICAgICAgIHRyYWRlVHlwZSxcbiAgICAgICAgICBhbW91bnQ6IGFtb3VudC50b0V4YWN0KCksXG4gICAgICAgICAgcm91dGVTdHJpbmcsXG4gICAgICAgICAgcm91dGVTdHJpbmdIYXNoLFxuICAgICAgICAgIGNoYWluSWQsXG4gICAgICAgIH0sXG4gICAgICAgIGBUcmFja2VkIFJvdXRlIGZvciBwYWlyIFske3RyYWRpbmdQYWlyfS8ke3RyYWRlVHlwZS50b1VwcGVyQ2FzZSgpfV0gb24gY2hhaW4gWyR7Y2hhaW5JZH1dIHdpdGggcm91dGUgaGFzaCBbJHtyb3V0ZVN0cmluZ0hhc2h9XSBmb3IgYW1vdW50IFske2Ftb3VudC50b0V4YWN0KCl9XWBcbiAgICAgIClcbiAgICB9XG4gIH1cblxuICBwcm90ZWN0ZWQgcmVxdWVzdEJvZHlTY2hlbWEoKTogSm9pLk9iamVjdFNjaGVtYSB8IG51bGwge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICBwcm90ZWN0ZWQgcmVxdWVzdFF1ZXJ5UGFyYW1zU2NoZW1hKCk6IEpvaS5PYmplY3RTY2hlbWEgfCBudWxsIHtcbiAgICByZXR1cm4gUXVvdGVRdWVyeVBhcmFtc0pvaVxuICB9XG5cbiAgcHJvdGVjdGVkIHJlc3BvbnNlQm9keVNjaGVtYSgpOiBKb2kuT2JqZWN0U2NoZW1hIHwgbnVsbCB7XG4gICAgcmV0dXJuIFF1b3RlUmVzcG9uc2VTY2hlbWFKb2lcbiAgfVxuXG4gIHByb3RlY3RlZCBhZnRlckhhbmRsZXIobWV0cmljOiBNZXRyaWNzTG9nZ2VyLCByZXNwb25zZTogUXVvdGVSZXNwb25zZSwgcmVxdWVzdFN0YXJ0OiBudW1iZXIpOiB2b2lkIHtcbiAgICBtZXRyaWMucHV0TWV0cmljKFxuICAgICAgYEdFVF9RVU9URV9MQVRFTkNZX1RPUF9MRVZFTF8ke3Jlc3BvbnNlLmhpdHNDYWNoZWRSb3V0ZXMgPyAnQ0FDSEVEX1JPVVRFU19ISVQnIDogJ0NBQ0hFRF9ST1VURVNfTUlTUyd9YCxcbiAgICAgIERhdGUubm93KCkgLSByZXF1ZXN0U3RhcnQsXG4gICAgICBNZXRyaWNMb2dnZXJVbml0Lk1pbGxpc2Vjb25kc1xuICAgIClcbiAgfVxufVxuIl19