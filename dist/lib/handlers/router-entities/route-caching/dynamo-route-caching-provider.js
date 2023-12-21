import { CachedRoutes, CacheMode, ID_TO_NETWORK_NAME, IRouteCachingProvider, log, metric, MetricLoggerUnit, routeToString, } from '@uniswap/smart-order-router';
import { DynamoDB, Lambda } from 'aws-sdk';
import { ChainId, Fraction, TradeType } from '@uniswap/sdk-core';
import { Protocol } from '@uniswap/router-sdk';
import { PairTradeTypeChainId } from './model/pair-trade-type-chain-id';
import { CachedRoutesMarshaller } from '../../marshalling/cached-routes-marshaller';
export class DynamoRouteCachingProvider extends IRouteCachingProvider {
    constructor({ routesTableName, routesCachingRequestFlagTableName, cachingQuoteLambdaName }) {
        super();
        this.DEFAULT_CACHEMODE_ROUTES_DB = CacheMode.Livemode;
        this.ROUTES_DB_TTL = 24 * 60 * 60; // 24 hours
        this.ROUTES_DB_FLAG_TTL = 2 * 60; // 2 minutes
        // heuristic is within 30 seconds we find a route.
        // we know each chain block time
        // divide those two
        this.DEFAULT_BLOCKS_TO_LIVE_ROUTES_DB = (chainId) => {
            switch (chainId) {
                // https://dune.com/queries/2138021
                case ChainId.ARBITRUM_ONE:
                    return 100;
                // https://dune.com/queries/2009572
                case ChainId.BASE:
                case ChainId.OPTIMISM:
                    return 60;
                // https://snowtrace.io/chart/blocktime
                case ChainId.AVALANCHE:
                    return 15;
                // https://dune.com/KARTOD/blockchains-analysis
                case ChainId.BNB:
                    return 10;
                // https://dune.com/KARTOD/blockchains-analysis
                case ChainId.POLYGON:
                    return 15;
                //  https://explorer.celo.org/mainnet/
                case ChainId.CELO:
                    return 6;
                // https://dune.com/KARTOD/blockchains-analysis
                case ChainId.MAINNET:
                default:
                    return 2;
            }
        };
        // For the Ratio we are approximating Phi (Golden Ratio) by creating a fraction with 2 consecutive Fibonacci numbers
        this.ROUTES_DB_BUCKET_RATIO = new Fraction(514229, 317811);
        this.ROUTES_TO_TAKE_FROM_ROUTES_DB = 8;
        this.BLOCKS_DIFF_BETWEEN_CACHING_QUOTES = new Map([[ChainId.MAINNET, 3]]);
        this.DEFAULT_BLOCKS_DIFF_CACHING = 15;
        // Since this DDB Table is used for Cache, we will fail fast and limit the timeout.
        this.ddbClient = new DynamoDB.DocumentClient({
            maxRetries: 1,
            retryDelayOptions: {
                base: 20,
            },
            httpOptions: {
                timeout: 100,
            },
        });
        this.lambdaClient = new Lambda();
        this.routesTableName = routesTableName;
        this.routesCachingRequestFlagTableName = routesCachingRequestFlagTableName;
        this.cachingQuoteLambdaName = cachingQuoteLambdaName;
    }
    /**
     * Implementation of the abstract method defined in `IRouteCachingProvider`
     * Given a CachedRoutesStrategy (from CACHED_ROUTES_CONFIGURATION),
     * we will find the BlocksToLive associated to the bucket.
     *
     * @param cachedRoutes
     * @param _
     * @protected
     */
    async _getBlocksToLive(cachedRoutes, _) {
        return this.DEFAULT_BLOCKS_TO_LIVE_ROUTES_DB(cachedRoutes.chainId);
    }
    /**
     * Implementation of the abstract method defined in `IRouteCachingProvider`
     * Fetch the most recent entry from the DynamoDB table for that pair, tradeType, chainId, protocols and bucket
     *
     * @param chainId
     * @param amount
     * @param quoteToken
     * @param tradeType
     * @param _protocols
     * @protected
     */
    async _getCachedRoute(chainId, amount, quoteToken, tradeType, protocols, currentBlockNumber, optimistic) {
        const { tokenIn, tokenOut } = this.determineTokenInOut(amount, quoteToken, tradeType);
        const partitionKey = new PairTradeTypeChainId({
            tokenIn: tokenIn.address,
            tokenOut: tokenOut.address,
            tradeType,
            chainId,
        });
        // If no cachedRoutes were found, we try to fetch from the RoutesDb
        metric.putMetric('RoutesDbQuery', 1, MetricLoggerUnit.Count);
        try {
            const queryParams = {
                TableName: this.routesTableName,
                KeyConditionExpression: '#pk = :pk',
                ExpressionAttributeNames: {
                    '#pk': 'pairTradeTypeChainId',
                },
                ExpressionAttributeValues: {
                    ':pk': partitionKey.toString(),
                },
            };
            const result = await this.ddbClient.query(queryParams).promise();
            if (result.Items && result.Items.length > 0) {
                metric.putMetric('RoutesDbPreFilterEntriesFound', result.Items.length, MetricLoggerUnit.Count);
                // At this point we might have gotten all the routes we have discovered in the last 24 hours for this pair
                // We will sort the routes by blockNumber, and take the first `ROUTES_TO_TAKE_FROM_ROUTES_DB` routes
                const filteredItems = result.Items
                    // Older routes might not have the protocol field, so we keep them if they don't have it
                    .filter((record) => !record.protocol || protocols.includes(record.protocol))
                    .sort((a, b) => b.blockNumber - a.blockNumber)
                    .slice(0, this.ROUTES_TO_TAKE_FROM_ROUTES_DB);
                result.Items = filteredItems;
                return this.parseCachedRoutes(result, chainId, currentBlockNumber, optimistic, partitionKey, amount, protocols);
            }
            else {
                metric.putMetric('RoutesDbEntriesNotFound', 1, MetricLoggerUnit.Count);
                log.warn(`[DynamoRouteCachingProvider] No items found in the query response for ${partitionKey.toString()}`);
            }
        }
        catch (error) {
            metric.putMetric('RoutesDbFetchError', 1, MetricLoggerUnit.Count);
            log.error({ partitionKey, error }, `[DynamoRouteCachingProvider] Error while fetching route from RouteDb`);
        }
        return undefined;
    }
    parseCachedRoutes(result, chainId, currentBlockNumber, optimistic, partitionKey, amount, protocols) {
        metric.putMetric(`RoutesDbEntriesFound`, result.Items.length, MetricLoggerUnit.Count);
        const cachedRoutesArr = result.Items.map((record) => {
            // If we got a response with more than 1 item, we extract the binary field from the response
            const itemBinary = record.item;
            // Then we convert it into a Buffer
            const cachedRoutesBuffer = Buffer.from(itemBinary);
            // We convert that buffer into string and parse as JSON (it was encoded as JSON when it was inserted into cache)
            const cachedRoutesJson = JSON.parse(cachedRoutesBuffer.toString());
            // Finally we unmarshal that JSON into a `CachedRoutes` object
            return CachedRoutesMarshaller.unmarshal(cachedRoutesJson);
        });
        const routesMap = new Map();
        let blockNumber = 0;
        let originalAmount = '';
        cachedRoutesArr.forEach((cachedRoutes) => {
            metric.putMetric(`RoutesDbPerBlockFound`, cachedRoutes.routes.length, MetricLoggerUnit.Count);
            cachedRoutes.routes.forEach((cachedRoute) => {
                // we use the stringified route as identifier
                const routeId = routeToString(cachedRoute.route);
                // Using a map to remove duplicates, we will the different percents of different routes.
                // We also filter by protocol, in case we are loading a route from a protocol that wasn't requested
                if (!routesMap.has(routeId) && protocols.includes(cachedRoute.protocol)) {
                    routesMap.set(routeId, cachedRoute);
                }
            });
            // Find the latest blockNumber
            blockNumber = Math.max(blockNumber, cachedRoutes.blockNumber);
            // Keep track of all the originalAmounts
            if (originalAmount === '') {
                originalAmount = `${cachedRoutes.originalAmount} | ${routesMap.size} | ${cachedRoutes.blockNumber}`;
            }
            else {
                originalAmount = `${originalAmount}, ${cachedRoutes.originalAmount} | ${routesMap.size} | ${cachedRoutes.blockNumber}`;
            }
        });
        const first = cachedRoutesArr[0];
        // Build a new CachedRoutes object with the values calculated earlier
        const cachedRoutes = new CachedRoutes({
            routes: Array.from(routesMap.values()),
            chainId: first.chainId,
            tokenIn: first.tokenIn,
            tokenOut: first.tokenOut,
            protocolsCovered: first.protocolsCovered,
            blockNumber,
            tradeType: first.tradeType,
            originalAmount,
            blocksToLive: first.blocksToLive,
        });
        metric.putMetric(`UniqueRoutesDbFound`, cachedRoutes.routes.length, MetricLoggerUnit.Count);
        log.info({ cachedRoutes }, `[DynamoRouteCachingProvider] Returning the cached and unmarshalled route.`);
        // Normalize blocks difference, if the route is from a new block (which could happen in L2s), consider it same block
        const blocksDifference = Math.max(0, currentBlockNumber - blockNumber);
        metric.putMetric(`RoutesDbBlockDifference`, blocksDifference, MetricLoggerUnit.Count);
        metric.putMetric(`RoutesDbBlockDifference_${ID_TO_NETWORK_NAME(chainId)}`, blocksDifference, MetricLoggerUnit.Count);
        const notExpiredCachedRoute = cachedRoutes.notExpired(currentBlockNumber, optimistic);
        if (notExpiredCachedRoute) {
            metric.putMetric(`RoutesDbNotExpired`, 1, MetricLoggerUnit.Count);
        }
        else {
            metric.putMetric(`RoutesDbExpired`, 1, MetricLoggerUnit.Count);
        }
        // Caching requests are not `optimistic`, we need to be careful of not removing this flag
        // This condition is protecting us against firing another caching request from inside a caching request
        if (optimistic) {
            // We send an async caching quote
            // we do not await on this function, it's a fire and forget
            this.maybeSendCachingQuoteForRoutesDb(partitionKey, amount, currentBlockNumber);
        }
        return cachedRoutes;
    }
    async maybeSendCachingQuoteForRoutesDb(partitionKey, amount, currentBlockNumber) {
        try {
            const queryParams = {
                TableName: this.routesCachingRequestFlagTableName,
                // We use a ratio to get a range of amounts that are close to the amount we are thinking about inserting
                // If there's an item in the table which range covers our amount, we don't need to send a caching request
                KeyConditionExpression: '#pk = :pk AND #amount BETWEEN :amount AND :amount_ratio',
                ExpressionAttributeNames: {
                    '#pk': 'pairTradeTypeChainId',
                    '#amount': 'amount',
                },
                ExpressionAttributeValues: {
                    ':pk': partitionKey.toString(),
                    ':amount': parseFloat(amount.toExact()),
                    ':amount_ratio': parseFloat(amount.multiply(this.ROUTES_DB_BUCKET_RATIO).toExact()),
                },
            };
            metric.putMetric('CachingQuoteForRoutesDbCheck', 1, MetricLoggerUnit.Count);
            const result = await this.ddbClient.query(queryParams).promise();
            const shouldSendCachingRequest = result.Items &&
                (result.Items.length == 0 || // no caching request has been sent recently
                    // or every sampled record is older than maximum blocks diff allowed for the chain
                    result.Items.every((record) => {
                        var _a;
                        const blocksDiff = currentBlockNumber - ((_a = record.blockNumber) !== null && _a !== void 0 ? _a : 0);
                        const maximumBlocksDiff = this.BLOCKS_DIFF_BETWEEN_CACHING_QUOTES.get(partitionKey.chainId) || this.DEFAULT_BLOCKS_DIFF_CACHING;
                        return blocksDiff > maximumBlocksDiff;
                    }));
            // if no Item is found it means we need to send a caching request
            if (shouldSendCachingRequest) {
                metric.putMetric('CachingQuoteForRoutesDbRequestSent', 1, MetricLoggerUnit.Count);
                this.sendAsyncCachingRequest(partitionKey, [Protocol.V2, Protocol.V3, Protocol.MIXED], amount);
                this.setRoutesDbCachingIntentFlag(partitionKey, amount, currentBlockNumber);
            }
            else {
                metric.putMetric('CachingQuoteForRoutesDbRequestNotNeeded', 1, MetricLoggerUnit.Count);
            }
        }
        catch (e) {
            log.error(`[DynamoRouteCachingProvider] Error checking if caching request for RoutesDb was sent: ${e}.`);
        }
    }
    sendAsyncCachingRequest(partitionKey, protocols, amount) {
        const payload = {
            queryStringParameters: {
                tokenInAddress: partitionKey.tokenIn,
                tokenInChainId: partitionKey.chainId.toString(),
                tokenOutAddress: partitionKey.tokenOut,
                tokenOutChainId: partitionKey.chainId.toString(),
                amount: amount.quotient.toString(),
                type: partitionKey.tradeType === 0 ? 'exactIn' : 'exactOut',
                protocols: protocols.map((protocol) => protocol.toLowerCase()).join(','),
                intent: 'caching',
            },
        };
        const params = {
            FunctionName: this.cachingQuoteLambdaName,
            InvocationType: 'Event',
            Payload: JSON.stringify(payload),
        };
        log.info(`[DynamoRouteCachingProvider] Sending async caching request to lambda ${JSON.stringify(params)}`);
        this.lambdaClient.invoke(params).promise();
    }
    setRoutesDbCachingIntentFlag(partitionKey, amount, currentBlockNumber) {
        const putParams = {
            TableName: this.routesCachingRequestFlagTableName,
            Item: {
                pairTradeTypeChainId: partitionKey.toString(),
                amount: parseFloat(amount.toExact()),
                ttl: Math.floor(Date.now() / 1000) + this.ROUTES_DB_FLAG_TTL,
                blockNumber: currentBlockNumber,
            },
        };
        this.ddbClient.put(putParams).promise();
    }
    /**
     * Implementation of the abstract method defined in `IRouteCachingProvider`
     * Attempts to insert the `CachedRoutes` object into cache, if the CachingStrategy returns the CachingParameters
     *
     * @param cachedRoutes
     * @protected
     */
    async _setCachedRoute(cachedRoutes) {
        const routesDbEntries = cachedRoutes.routes.map((route) => {
            const individualCachedRoutes = new CachedRoutes({
                routes: [route],
                chainId: cachedRoutes.chainId,
                tokenIn: cachedRoutes.tokenIn,
                tokenOut: cachedRoutes.tokenOut,
                protocolsCovered: cachedRoutes.protocolsCovered,
                blockNumber: cachedRoutes.blockNumber,
                tradeType: cachedRoutes.tradeType,
                originalAmount: cachedRoutes.originalAmount,
            });
            const ttl = Math.floor(Date.now() / 1000) + this.ROUTES_DB_TTL;
            // Marshal the CachedRoutes object in preparation for storing in DynamoDB
            const marshalledCachedRoutes = CachedRoutesMarshaller.marshal(individualCachedRoutes);
            // Convert the marshalledCachedRoutes to JSON string
            const jsonCachedRoutes = JSON.stringify(marshalledCachedRoutes);
            // Encode the jsonCachedRoutes into Binary
            const binaryCachedRoutes = Buffer.from(jsonCachedRoutes);
            const partitionKey = PairTradeTypeChainId.fromCachedRoutes(cachedRoutes);
            return {
                PutRequest: {
                    Item: {
                        pairTradeTypeChainId: partitionKey.toString(),
                        routeId: route.routeId,
                        blockNumber: cachedRoutes.blockNumber,
                        protocol: route.protocol.toString(),
                        item: binaryCachedRoutes,
                        ttl: ttl,
                    },
                },
            };
        });
        if (routesDbEntries.length > 0) {
            try {
                const batchWriteParams = {
                    RequestItems: {
                        [this.routesTableName]: routesDbEntries,
                    },
                };
                await this.ddbClient.batchWrite(batchWriteParams).promise();
                log.info(`[DynamoRouteCachingProvider] Route Entries inserted to database`);
                return true;
            }
            catch (error) {
                log.error({ error, routesDbEntries }, `[DynamoRouteCachingProvider] Route Entries failed to insert`);
                return false;
            }
        }
        else {
            log.warn(`[DynamoRouteCachingProvider] No Route Entries to insert`);
            return false;
        }
    }
    /**
     * Implementation of the abstract method defined in `IRouteCachingProvider`
     * Obtains the CacheMode from the CachingStrategy, if not found, then return Darkmode.
     *
     * @param _chainId
     * @param _amount
     * @param _quoteToken
     * @param _tradeType
     * @param _protocols
     */
    async getCacheMode(_chainId, _amount, _quoteToken, _tradeType, _protocols) {
        return this.DEFAULT_CACHEMODE_ROUTES_DB;
    }
    /**
     * RoutesDB self-correcting mechanism allows us to look at routes that would have been considered expired
     * We override this method to increase our cache coverage.
     *
     * @param cachedRoutes
     * @param _blockNumber
     * @param _optimistic
     * @protected
     */
    filterExpiredCachedRoutes(cachedRoutes, _blockNumber, _optimistic) {
        return cachedRoutes;
    }
    /**
     * Helper function to determine the tokenIn and tokenOut given the tradeType, quoteToken and amount.currency
     *
     * @param amount
     * @param quoteToken
     * @param tradeType
     * @private
     */
    determineTokenInOut(amount, quoteToken, tradeType) {
        if (tradeType == TradeType.EXACT_INPUT) {
            return { tokenIn: amount.currency.wrapped, tokenOut: quoteToken };
        }
        else {
            return { tokenIn: quoteToken, tokenOut: amount.currency.wrapped };
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZHluYW1vLXJvdXRlLWNhY2hpbmctcHJvdmlkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9saWIvaGFuZGxlcnMvcm91dGVyLWVudGl0aWVzL3JvdXRlLWNhY2hpbmcvZHluYW1vLXJvdXRlLWNhY2hpbmctcHJvdmlkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUVMLFlBQVksRUFDWixTQUFTLEVBQ1Qsa0JBQWtCLEVBQ2xCLHFCQUFxQixFQUNyQixHQUFHLEVBQ0gsTUFBTSxFQUNOLGdCQUFnQixFQUNoQixhQUFhLEdBQ2QsTUFBTSw2QkFBNkIsQ0FBQTtBQUNwQyxPQUFPLEVBQVksUUFBUSxFQUFFLE1BQU0sRUFBRSxNQUFNLFNBQVMsQ0FBQTtBQUNwRCxPQUFPLEVBQUUsT0FBTyxFQUE0QixRQUFRLEVBQVMsU0FBUyxFQUFFLE1BQU0sbUJBQW1CLENBQUE7QUFDakcsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLHFCQUFxQixDQUFBO0FBQzlDLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLGtDQUFrQyxDQUFBO0FBQ3ZFLE9BQU8sRUFBRSxzQkFBc0IsRUFBRSxNQUFNLDRDQUE0QyxDQUFBO0FBbUJuRixNQUFNLE9BQU8sMEJBQTJCLFNBQVEscUJBQXFCO0lBc0RuRSxZQUFZLEVBQUUsZUFBZSxFQUFFLGlDQUFpQyxFQUFFLHNCQUFzQixFQUFxQjtRQUMzRyxLQUFLLEVBQUUsQ0FBQTtRQWhEUSxnQ0FBMkIsR0FBRyxTQUFTLENBQUMsUUFBUSxDQUFBO1FBQ2hELGtCQUFhLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLENBQUEsQ0FBQyxXQUFXO1FBQ3hDLHVCQUFrQixHQUFHLENBQUMsR0FBRyxFQUFFLENBQUEsQ0FBQyxZQUFZO1FBRXpELGtEQUFrRDtRQUNsRCxnQ0FBZ0M7UUFDaEMsbUJBQW1CO1FBQ0YscUNBQWdDLEdBQUcsQ0FBQyxPQUFnQixFQUFFLEVBQUU7WUFD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QUFlLEVBQUUsRUFBRSw2REFBNkQsQ0FBQyxDQUFBO2dCQUVwRyxPQUFPLEtBQUssQ0FBQTthQUNiO1NBQ0Y7YUFBTTtZQUNMLEdBQUcsQ0FBQyxJQUFJLENBQUMseURBQXlELENBQUMsQ0FBQTtZQUNuRSxPQUFPLEtBQUssQ0FBQTtTQUNiO0lBQ0gsQ0FBQztJQUVEOzs7Ozs7Ozs7T0FTRztJQUNJLEtBQUssQ0FBQyxZQUFZLENBQ3ZCLFFBQWlCLEVBQ2pCLE9BQWlDLEVBQ2pDLFdBQWtCLEVBQ2xCLFVBQXFCLEVBQ3JCLFVBQXNCO1FBRXRCLE9BQU8sSUFBSSxDQUFDLDJCQUEyQixDQUFBO0lBQ3pDLENBQUM7SUFFRDs7Ozs7Ozs7T0FRRztJQUNnQix5QkFBeUIsQ0FDMUMsWUFBc0MsRUFDdEMsWUFBb0IsRUFDcEIsV0FBb0I7UUFFcEIsT0FBTyxZQUFZLENBQUE7SUFDckIsQ0FBQztJQUVEOzs7Ozs7O09BT0c7SUFDSyxtQkFBbUIsQ0FDekIsTUFBZ0MsRUFDaEMsVUFBaUIsRUFDakIsU0FBb0I7UUFFcEIsSUFBSSxTQUFTLElBQUksU0FBUyxDQUFDLFdBQVcsRUFBRTtZQUN0QyxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxFQUFFLFFBQVEsRUFBRSxVQUFVLEVBQUUsQ0FBQTtTQUNsRTthQUFNO1lBQ0wsT0FBTyxFQUFFLE9BQU8sRUFBRSxVQUFVLEVBQUUsUUFBUSxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxFQUFFLENBQUE7U0FDbEU7SUFDSCxDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICBDYWNoZWRSb3V0ZSxcbiAgQ2FjaGVkUm91dGVzLFxuICBDYWNoZU1vZGUsXG4gIElEX1RPX05FVFdPUktfTkFNRSxcbiAgSVJvdXRlQ2FjaGluZ1Byb3ZpZGVyLFxuICBsb2csXG4gIG1ldHJpYyxcbiAgTWV0cmljTG9nZ2VyVW5pdCxcbiAgcm91dGVUb1N0cmluZyxcbn0gZnJvbSAnQHVuaXN3YXAvc21hcnQtb3JkZXItcm91dGVyJ1xuaW1wb3J0IHsgQVdTRXJyb3IsIER5bmFtb0RCLCBMYW1iZGEgfSBmcm9tICdhd3Mtc2RrJ1xuaW1wb3J0IHsgQ2hhaW5JZCwgQ3VycmVuY3ksIEN1cnJlbmN5QW1vdW50LCBGcmFjdGlvbiwgVG9rZW4sIFRyYWRlVHlwZSB9IGZyb20gJ0B1bmlzd2FwL3Nkay1jb3JlJ1xuaW1wb3J0IHsgUHJvdG9jb2wgfSBmcm9tICdAdW5pc3dhcC9yb3V0ZXItc2RrJ1xuaW1wb3J0IHsgUGFpclRyYWRlVHlwZUNoYWluSWQgfSBmcm9tICcuL21vZGVsL3BhaXItdHJhZGUtdHlwZS1jaGFpbi1pZCdcbmltcG9ydCB7IENhY2hlZFJvdXRlc01hcnNoYWxsZXIgfSBmcm9tICcuLi8uLi9tYXJzaGFsbGluZy9jYWNoZWQtcm91dGVzLW1hcnNoYWxsZXInXG5pbXBvcnQgeyBNaXhlZFJvdXRlLCBWMlJvdXRlLCBWM1JvdXRlIH0gZnJvbSAnQHVuaXN3YXAvc21hcnQtb3JkZXItcm91dGVyL2J1aWxkL21haW4vcm91dGVycydcbmltcG9ydCB7IFByb21pc2VSZXN1bHQgfSBmcm9tICdhd3Mtc2RrL2xpYi9yZXF1ZXN0J1xuXG5pbnRlcmZhY2UgQ29uc3RydWN0b3JQYXJhbXMge1xuICAvKipcbiAgICogVGhlIFRhYmxlTmFtZSBmb3IgdGhlIER5bmFtb0RCIFRhYmxlIHRoYXQgc3RvcmVzIHJvdXRlc1xuICAgKi9cbiAgcm91dGVzVGFibGVOYW1lOiBzdHJpbmdcbiAgLyoqXG4gICAqIFRoZSBUYWJsZU5hbWUgZm9yIHRoZSBEeW5hbW9EQiBUYWJsZSB0aGF0IHN0b3JlcyB3aGV0aGVyIGEgcmVxdWVzdCBoYXMgYmVlbiBzZW50IGZvciBjYWNoaW5nIHJlbGF0ZWQgdG8gcm91dGVzRGJcbiAgICovXG4gIHJvdXRlc0NhY2hpbmdSZXF1ZXN0RmxhZ1RhYmxlTmFtZTogc3RyaW5nXG4gIC8qKlxuICAgKiBUaGUgTGFtYmRhIEZ1bmN0aW9uIE5hbWUgZm9yIHRoZSBMYW1iZGEgdGhhdCB3aWxsIGJlIGludm9rZWQgdG8gZmlsbCB0aGUgY2FjaGVcbiAgICovXG4gIGNhY2hpbmdRdW90ZUxhbWJkYU5hbWU6IHN0cmluZ1xufVxuXG5leHBvcnQgY2xhc3MgRHluYW1vUm91dGVDYWNoaW5nUHJvdmlkZXIgZXh0ZW5kcyBJUm91dGVDYWNoaW5nUHJvdmlkZXIge1xuICBwcml2YXRlIHJlYWRvbmx5IGRkYkNsaWVudDogRHluYW1vREIuRG9jdW1lbnRDbGllbnRcbiAgcHJpdmF0ZSByZWFkb25seSBsYW1iZGFDbGllbnQ6IExhbWJkYVxuICBwcml2YXRlIHJlYWRvbmx5IHJvdXRlc1RhYmxlTmFtZTogc3RyaW5nXG4gIHByaXZhdGUgcmVhZG9ubHkgcm91dGVzQ2FjaGluZ1JlcXVlc3RGbGFnVGFibGVOYW1lOiBzdHJpbmdcbiAgcHJpdmF0ZSByZWFkb25seSBjYWNoaW5nUXVvdGVMYW1iZGFOYW1lOiBzdHJpbmdcblxuICBwcml2YXRlIHJlYWRvbmx5IERFRkFVTFRfQ0FDSEVNT0RFX1JPVVRFU19EQiA9IENhY2hlTW9kZS5MaXZlbW9kZVxuICBwcml2YXRlIHJlYWRvbmx5IFJPVVRFU19EQl9UVEwgPSAyNCAqIDYwICogNjAgLy8gMjQgaG91cnNcbiAgcHJpdmF0ZSByZWFkb25seSBST1VURVNfREJfRkxBR19UVEwgPSAyICogNjAgLy8gMiBtaW51dGVzXG5cbiAgLy8gaGV1cmlzdGljIGlzIHdpdGhpbiAzMCBzZWNvbmRzIHdlIGZpbmQgYSByb3V0ZS5cbiAgLy8gd2Uga25vdyBlYWNoIGNoYWluIGJsb2NrIHRpbWVcbiAgLy8gZGl2aWRlIHRob3NlIHR3b1xuICBwcml2YXRlIHJlYWRvbmx5IERFRkFVTFRfQkxPQ0tTX1RPX0xJVkVfUk9VVEVTX0RCID0gKGNoYWluSWQ6IENoYWluSWQpID0+IHtcbiAgICBzd2l0Y2ggKGNoYWluSWQpIHtcbiAgICAgIC8vIGh0dHBzOi8vZHVuZS5jb20vcXVlcmllcy8yMTM4MDIxXG4gICAgICBjYXNlIENoYWluSWQuQVJCSVRSVU1fT05FOlxuICAgICAgICByZXR1cm4gMTAwXG5cbiAgICAgIC8vIGh0dHBzOi8vZHVuZS5jb20vcXVlcmllcy8yMDA5NTcyXG4gICAgICBjYXNlIENoYWluSWQuQkFTRTpcbiAgICAgIGNhc2UgQ2hhaW5JZC5PUFRJTUlTTTpcbiAgICAgICAgcmV0dXJuIDYwXG5cbiAgICAgIC8vIGh0dHBzOi8vc25vd3RyYWNlLmlvL2NoYXJ0L2Jsb2NrdGltZVxuICAgICAgY2FzZSBDaGFpbklkLkFWQUxBTkNIRTpcbiAgICAgICAgcmV0dXJuIDE1XG5cbiAgICAgIC8vIGh0dHBzOi8vZHVuZS5jb20vS0FSVE9EL2Jsb2NrY2hhaW5zLWFuYWx5c2lzXG4gICAgICBjYXNlIENoYWluSWQuQk5COlxuICAgICAgICByZXR1cm4gMTBcblxuICAgICAgLy8gaHR0cHM6Ly9kdW5lLmNvbS9LQVJUT0QvYmxvY2tjaGFpbnMtYW5hbHlzaXNcbiAgICAgIGNhc2UgQ2hhaW5JZC5QT0xZR09OOlxuICAgICAgICByZXR1cm4gMTVcblxuICAgICAgLy8gIGh0dHBzOi8vZXhwbG9yZXIuY2Vsby5vcmcvbWFpbm5ldC9cbiAgICAgIGNhc2UgQ2hhaW5JZC5DRUxPOlxuICAgICAgICByZXR1cm4gNlxuXG4gICAgICAvLyBodHRwczovL2R1bmUuY29tL0tBUlRPRC9ibG9ja2NoYWlucy1hbmFseXNpc1xuICAgICAgY2FzZSBDaGFpbklkLk1BSU5ORVQ6XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4gMlxuICAgIH1cbiAgfVxuICAvLyBGb3IgdGhlIFJhdGlvIHdlIGFyZSBhcHByb3hpbWF0aW5nIFBoaSAoR29sZGVuIFJhdGlvKSBieSBjcmVhdGluZyBhIGZyYWN0aW9uIHdpdGggMiBjb25zZWN1dGl2ZSBGaWJvbmFjY2kgbnVtYmVyc1xuICBwcml2YXRlIHJlYWRvbmx5IFJPVVRFU19EQl9CVUNLRVRfUkFUSU86IEZyYWN0aW9uID0gbmV3IEZyYWN0aW9uKDUxNDIyOSwgMzE3ODExKVxuICBwcml2YXRlIHJlYWRvbmx5IFJPVVRFU19UT19UQUtFX0ZST01fUk9VVEVTX0RCID0gOFxuICBwcml2YXRlIHJlYWRvbmx5IEJMT0NLU19ESUZGX0JFVFdFRU5fQ0FDSElOR19RVU9URVM6IE1hcDxDaGFpbklkLCBudW1iZXI+ID0gbmV3IE1hcChbW0NoYWluSWQuTUFJTk5FVCwgM11dKVxuXG4gIHByaXZhdGUgcmVhZG9ubHkgREVGQVVMVF9CTE9DS1NfRElGRl9DQUNISU5HID0gMTVcblxuICBjb25zdHJ1Y3Rvcih7IHJvdXRlc1RhYmxlTmFtZSwgcm91dGVzQ2FjaGluZ1JlcXVlc3RGbGFnVGFibGVOYW1lLCBjYWNoaW5nUXVvdGVMYW1iZGFOYW1lIH06IENvbnN0cnVjdG9yUGFyYW1zKSB7XG4gICAgc3VwZXIoKVxuICAgIC8vIFNpbmNlIHRoaXMgRERCIFRhYmxlIGlzIHVzZWQgZm9yIENhY2hlLCB3ZSB3aWxsIGZhaWwgZmFzdCBhbmQgbGltaXQgdGhlIHRpbWVvdXQuXG4gICAgdGhpcy5kZGJDbGllbnQgPSBuZXcgRHluYW1vREIuRG9jdW1lbnRDbGllbnQoe1xuICAgICAgbWF4UmV0cmllczogMSxcbiAgICAgIHJldHJ5RGVsYXlPcHRpb25zOiB7XG4gICAgICAgIGJhc2U6IDIwLFxuICAgICAgfSxcbiAgICAgIGh0dHBPcHRpb25zOiB7XG4gICAgICAgIHRpbWVvdXQ6IDEwMCxcbiAgICAgIH0sXG4gICAgfSlcbiAgICB0aGlzLmxhbWJkYUNsaWVudCA9IG5ldyBMYW1iZGEoKVxuICAgIHRoaXMucm91dGVzVGFibGVOYW1lID0gcm91dGVzVGFibGVOYW1lXG4gICAgdGhpcy5yb3V0ZXNDYWNoaW5nUmVxdWVzdEZsYWdUYWJsZU5hbWUgPSByb3V0ZXNDYWNoaW5nUmVxdWVzdEZsYWdUYWJsZU5hbWVcbiAgICB0aGlzLmNhY2hpbmdRdW90ZUxhbWJkYU5hbWUgPSBjYWNoaW5nUXVvdGVMYW1iZGFOYW1lXG4gIH1cblxuICAvKipcbiAgICogSW1wbGVtZW50YXRpb24gb2YgdGhlIGFic3RyYWN0IG1ldGhvZCBkZWZpbmVkIGluIGBJUm91dGVDYWNoaW5nUHJvdmlkZXJgXG4gICAqIEdpdmVuIGEgQ2FjaGVkUm91dGVzU3RyYXRlZ3kgKGZyb20gQ0FDSEVEX1JPVVRFU19DT05GSUdVUkFUSU9OKSxcbiAgICogd2Ugd2lsbCBmaW5kIHRoZSBCbG9ja3NUb0xpdmUgYXNzb2NpYXRlZCB0byB0aGUgYnVja2V0LlxuICAgKlxuICAgKiBAcGFyYW0gY2FjaGVkUm91dGVzXG4gICAqIEBwYXJhbSBfXG4gICAqIEBwcm90ZWN0ZWRcbiAgICovXG4gIHByb3RlY3RlZCBhc3luYyBfZ2V0QmxvY2tzVG9MaXZlKGNhY2hlZFJvdXRlczogQ2FjaGVkUm91dGVzLCBfOiBDdXJyZW5jeUFtb3VudDxDdXJyZW5jeT4pOiBQcm9taXNlPG51bWJlcj4ge1xuICAgIHJldHVybiB0aGlzLkRFRkFVTFRfQkxPQ0tTX1RPX0xJVkVfUk9VVEVTX0RCKGNhY2hlZFJvdXRlcy5jaGFpbklkKVxuICB9XG5cbiAgLyoqXG4gICAqIEltcGxlbWVudGF0aW9uIG9mIHRoZSBhYnN0cmFjdCBtZXRob2QgZGVmaW5lZCBpbiBgSVJvdXRlQ2FjaGluZ1Byb3ZpZGVyYFxuICAgKiBGZXRjaCB0aGUgbW9zdCByZWNlbnQgZW50cnkgZnJvbSB0aGUgRHluYW1vREIgdGFibGUgZm9yIHRoYXQgcGFpciwgdHJhZGVUeXBlLCBjaGFpbklkLCBwcm90b2NvbHMgYW5kIGJ1Y2tldFxuICAgKlxuICAgKiBAcGFyYW0gY2hhaW5JZFxuICAgKiBAcGFyYW0gYW1vdW50XG4gICAqIEBwYXJhbSBxdW90ZVRva2VuXG4gICAqIEBwYXJhbSB0cmFkZVR5cGVcbiAgICogQHBhcmFtIF9wcm90b2NvbHNcbiAgICogQHByb3RlY3RlZFxuICAgKi9cbiAgcHJvdGVjdGVkIGFzeW5jIF9nZXRDYWNoZWRSb3V0ZShcbiAgICBjaGFpbklkOiBDaGFpbklkLFxuICAgIGFtb3VudDogQ3VycmVuY3lBbW91bnQ8Q3VycmVuY3k+LFxuICAgIHF1b3RlVG9rZW46IFRva2VuLFxuICAgIHRyYWRlVHlwZTogVHJhZGVUeXBlLFxuICAgIHByb3RvY29sczogUHJvdG9jb2xbXSxcbiAgICBjdXJyZW50QmxvY2tOdW1iZXI6IG51bWJlcixcbiAgICBvcHRpbWlzdGljOiBib29sZWFuXG4gICk6IFByb21pc2U8Q2FjaGVkUm91dGVzIHwgdW5kZWZpbmVkPiB7XG4gICAgY29uc3QgeyB0b2tlbkluLCB0b2tlbk91dCB9ID0gdGhpcy5kZXRlcm1pbmVUb2tlbkluT3V0KGFtb3VudCwgcXVvdGVUb2tlbiwgdHJhZGVUeXBlKVxuXG4gICAgY29uc3QgcGFydGl0aW9uS2V5ID0gbmV3IFBhaXJUcmFkZVR5cGVDaGFpbklkKHtcbiAgICAgIHRva2VuSW46IHRva2VuSW4uYWRkcmVzcyxcbiAgICAgIHRva2VuT3V0OiB0b2tlbk91dC5hZGRyZXNzLFxuICAgICAgdHJhZGVUeXBlLFxuICAgICAgY2hhaW5JZCxcbiAgICB9KVxuXG4gICAgLy8gSWYgbm8gY2FjaGVkUm91dGVzIHdlcmUgZm91bmQsIHdlIHRyeSB0byBmZXRjaCBmcm9tIHRoZSBSb3V0ZXNEYlxuICAgIG1ldHJpYy5wdXRNZXRyaWMoJ1JvdXRlc0RiUXVlcnknLCAxLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHF1ZXJ5UGFyYW1zID0ge1xuICAgICAgICBUYWJsZU5hbWU6IHRoaXMucm91dGVzVGFibGVOYW1lLFxuICAgICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnI3BrID0gOnBrJyxcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICAgJyNwayc6ICdwYWlyVHJhZGVUeXBlQ2hhaW5JZCcsXG4gICAgICAgIH0sXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAnOnBrJzogcGFydGl0aW9uS2V5LnRvU3RyaW5nKCksXG4gICAgICAgIH0sXG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuZGRiQ2xpZW50LnF1ZXJ5KHF1ZXJ5UGFyYW1zKS5wcm9taXNlKClcbiAgICAgIGlmIChyZXN1bHQuSXRlbXMgJiYgcmVzdWx0Lkl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgbWV0cmljLnB1dE1ldHJpYygnUm91dGVzRGJQcmVGaWx0ZXJFbnRyaWVzRm91bmQnLCByZXN1bHQuSXRlbXMubGVuZ3RoLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuICAgICAgICAvLyBBdCB0aGlzIHBvaW50IHdlIG1pZ2h0IGhhdmUgZ290dGVuIGFsbCB0aGUgcm91dGVzIHdlIGhhdmUgZGlzY292ZXJlZCBpbiB0aGUgbGFzdCAyNCBob3VycyBmb3IgdGhpcyBwYWlyXG4gICAgICAgIC8vIFdlIHdpbGwgc29ydCB0aGUgcm91dGVzIGJ5IGJsb2NrTnVtYmVyLCBhbmQgdGFrZSB0aGUgZmlyc3QgYFJPVVRFU19UT19UQUtFX0ZST01fUk9VVEVTX0RCYCByb3V0ZXNcbiAgICAgICAgY29uc3QgZmlsdGVyZWRJdGVtcyA9IHJlc3VsdC5JdGVtc1xuICAgICAgICAgIC8vIE9sZGVyIHJvdXRlcyBtaWdodCBub3QgaGF2ZSB0aGUgcHJvdG9jb2wgZmllbGQsIHNvIHdlIGtlZXAgdGhlbSBpZiB0aGV5IGRvbid0IGhhdmUgaXRcbiAgICAgICAgICAuZmlsdGVyKChyZWNvcmQpID0+ICFyZWNvcmQucHJvdG9jb2wgfHwgcHJvdG9jb2xzLmluY2x1ZGVzKHJlY29yZC5wcm90b2NvbCkpXG4gICAgICAgICAgLnNvcnQoKGEsIGIpID0+IGIuYmxvY2tOdW1iZXIgLSBhLmJsb2NrTnVtYmVyKVxuICAgICAgICAgIC5zbGljZSgwLCB0aGlzLlJPVVRFU19UT19UQUtFX0ZST01fUk9VVEVTX0RCKVxuXG4gICAgICAgIHJlc3VsdC5JdGVtcyA9IGZpbHRlcmVkSXRlbXNcblxuICAgICAgICByZXR1cm4gdGhpcy5wYXJzZUNhY2hlZFJvdXRlcyhyZXN1bHQsIGNoYWluSWQsIGN1cnJlbnRCbG9ja051bWJlciwgb3B0aW1pc3RpYywgcGFydGl0aW9uS2V5LCBhbW91bnQsIHByb3RvY29scylcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG1ldHJpYy5wdXRNZXRyaWMoJ1JvdXRlc0RiRW50cmllc05vdEZvdW5kJywgMSwgTWV0cmljTG9nZ2VyVW5pdC5Db3VudClcbiAgICAgICAgbG9nLndhcm4oYFtEeW5hbW9Sb3V0ZUNhY2hpbmdQcm92aWRlcl0gTm8gaXRlbXMgZm91bmQgaW4gdGhlIHF1ZXJ5IHJlc3BvbnNlIGZvciAke3BhcnRpdGlvbktleS50b1N0cmluZygpfWApXG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoJ1JvdXRlc0RiRmV0Y2hFcnJvcicsIDEsIE1ldHJpY0xvZ2dlclVuaXQuQ291bnQpXG4gICAgICBsb2cuZXJyb3IoeyBwYXJ0aXRpb25LZXksIGVycm9yIH0sIGBbRHluYW1vUm91dGVDYWNoaW5nUHJvdmlkZXJdIEVycm9yIHdoaWxlIGZldGNoaW5nIHJvdXRlIGZyb20gUm91dGVEYmApXG4gICAgfVxuXG4gICAgcmV0dXJuIHVuZGVmaW5lZFxuICB9XG5cbiAgcHJpdmF0ZSBwYXJzZUNhY2hlZFJvdXRlcyhcbiAgICByZXN1bHQ6IFByb21pc2VSZXN1bHQ8RHluYW1vREIuRG9jdW1lbnRDbGllbnQuUXVlcnlPdXRwdXQsIEFXU0Vycm9yPixcbiAgICBjaGFpbklkOiBDaGFpbklkLFxuICAgIGN1cnJlbnRCbG9ja051bWJlcjogbnVtYmVyLFxuICAgIG9wdGltaXN0aWM6IGJvb2xlYW4sXG4gICAgcGFydGl0aW9uS2V5OiBQYWlyVHJhZGVUeXBlQ2hhaW5JZCxcbiAgICBhbW91bnQ6IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5PixcbiAgICBwcm90b2NvbHM6IFByb3RvY29sW11cbiAgKTogQ2FjaGVkUm91dGVzIHtcbiAgICBtZXRyaWMucHV0TWV0cmljKGBSb3V0ZXNEYkVudHJpZXNGb3VuZGAsIHJlc3VsdC5JdGVtcyEubGVuZ3RoLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuICAgIGNvbnN0IGNhY2hlZFJvdXRlc0FycjogQ2FjaGVkUm91dGVzW10gPSByZXN1bHQuSXRlbXMhLm1hcCgocmVjb3JkKSA9PiB7XG4gICAgICAvLyBJZiB3ZSBnb3QgYSByZXNwb25zZSB3aXRoIG1vcmUgdGhhbiAxIGl0ZW0sIHdlIGV4dHJhY3QgdGhlIGJpbmFyeSBmaWVsZCBmcm9tIHRoZSByZXNwb25zZVxuICAgICAgY29uc3QgaXRlbUJpbmFyeSA9IHJlY29yZC5pdGVtXG4gICAgICAvLyBUaGVuIHdlIGNvbnZlcnQgaXQgaW50byBhIEJ1ZmZlclxuICAgICAgY29uc3QgY2FjaGVkUm91dGVzQnVmZmVyID0gQnVmZmVyLmZyb20oaXRlbUJpbmFyeSlcbiAgICAgIC8vIFdlIGNvbnZlcnQgdGhhdCBidWZmZXIgaW50byBzdHJpbmcgYW5kIHBhcnNlIGFzIEpTT04gKGl0IHdhcyBlbmNvZGVkIGFzIEpTT04gd2hlbiBpdCB3YXMgaW5zZXJ0ZWQgaW50byBjYWNoZSlcbiAgICAgIGNvbnN0IGNhY2hlZFJvdXRlc0pzb24gPSBKU09OLnBhcnNlKGNhY2hlZFJvdXRlc0J1ZmZlci50b1N0cmluZygpKVxuICAgICAgLy8gRmluYWxseSB3ZSB1bm1hcnNoYWwgdGhhdCBKU09OIGludG8gYSBgQ2FjaGVkUm91dGVzYCBvYmplY3RcbiAgICAgIHJldHVybiBDYWNoZWRSb3V0ZXNNYXJzaGFsbGVyLnVubWFyc2hhbChjYWNoZWRSb3V0ZXNKc29uKVxuICAgIH0pXG5cbiAgICBjb25zdCByb3V0ZXNNYXA6IE1hcDxzdHJpbmcsIENhY2hlZFJvdXRlPFYzUm91dGUgfCBWMlJvdXRlIHwgTWl4ZWRSb3V0ZT4+ID0gbmV3IE1hcCgpXG4gICAgbGV0IGJsb2NrTnVtYmVyOiBudW1iZXIgPSAwXG4gICAgbGV0IG9yaWdpbmFsQW1vdW50OiBzdHJpbmcgPSAnJ1xuXG4gICAgY2FjaGVkUm91dGVzQXJyLmZvckVhY2goKGNhY2hlZFJvdXRlcykgPT4ge1xuICAgICAgbWV0cmljLnB1dE1ldHJpYyhgUm91dGVzRGJQZXJCbG9ja0ZvdW5kYCwgY2FjaGVkUm91dGVzLnJvdXRlcy5sZW5ndGgsIE1ldHJpY0xvZ2dlclVuaXQuQ291bnQpXG4gICAgICBjYWNoZWRSb3V0ZXMucm91dGVzLmZvckVhY2goKGNhY2hlZFJvdXRlKSA9PiB7XG4gICAgICAgIC8vIHdlIHVzZSB0aGUgc3RyaW5naWZpZWQgcm91dGUgYXMgaWRlbnRpZmllclxuICAgICAgICBjb25zdCByb3V0ZUlkID0gcm91dGVUb1N0cmluZyhjYWNoZWRSb3V0ZS5yb3V0ZSlcbiAgICAgICAgLy8gVXNpbmcgYSBtYXAgdG8gcmVtb3ZlIGR1cGxpY2F0ZXMsIHdlIHdpbGwgdGhlIGRpZmZlcmVudCBwZXJjZW50cyBvZiBkaWZmZXJlbnQgcm91dGVzLlxuICAgICAgICAvLyBXZSBhbHNvIGZpbHRlciBieSBwcm90b2NvbCwgaW4gY2FzZSB3ZSBhcmUgbG9hZGluZyBhIHJvdXRlIGZyb20gYSBwcm90b2NvbCB0aGF0IHdhc24ndCByZXF1ZXN0ZWRcbiAgICAgICAgaWYgKCFyb3V0ZXNNYXAuaGFzKHJvdXRlSWQpICYmIHByb3RvY29scy5pbmNsdWRlcyhjYWNoZWRSb3V0ZS5wcm90b2NvbCkpIHtcbiAgICAgICAgICByb3V0ZXNNYXAuc2V0KHJvdXRlSWQsIGNhY2hlZFJvdXRlKVxuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLy8gRmluZCB0aGUgbGF0ZXN0IGJsb2NrTnVtYmVyXG4gICAgICBibG9ja051bWJlciA9IE1hdGgubWF4KGJsb2NrTnVtYmVyLCBjYWNoZWRSb3V0ZXMuYmxvY2tOdW1iZXIpXG4gICAgICAvLyBLZWVwIHRyYWNrIG9mIGFsbCB0aGUgb3JpZ2luYWxBbW91bnRzXG4gICAgICBpZiAob3JpZ2luYWxBbW91bnQgPT09ICcnKSB7XG4gICAgICAgIG9yaWdpbmFsQW1vdW50ID0gYCR7Y2FjaGVkUm91dGVzLm9yaWdpbmFsQW1vdW50fSB8ICR7cm91dGVzTWFwLnNpemV9IHwgJHtjYWNoZWRSb3V0ZXMuYmxvY2tOdW1iZXJ9YFxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgb3JpZ2luYWxBbW91bnQgPSBgJHtvcmlnaW5hbEFtb3VudH0sICR7Y2FjaGVkUm91dGVzLm9yaWdpbmFsQW1vdW50fSB8ICR7cm91dGVzTWFwLnNpemV9IHwgJHtjYWNoZWRSb3V0ZXMuYmxvY2tOdW1iZXJ9YFxuICAgICAgfVxuICAgIH0pXG5cbiAgICBjb25zdCBmaXJzdCA9IGNhY2hlZFJvdXRlc0FyclswXVxuXG4gICAgLy8gQnVpbGQgYSBuZXcgQ2FjaGVkUm91dGVzIG9iamVjdCB3aXRoIHRoZSB2YWx1ZXMgY2FsY3VsYXRlZCBlYXJsaWVyXG4gICAgY29uc3QgY2FjaGVkUm91dGVzID0gbmV3IENhY2hlZFJvdXRlcyh7XG4gICAgICByb3V0ZXM6IEFycmF5LmZyb20ocm91dGVzTWFwLnZhbHVlcygpKSxcbiAgICAgIGNoYWluSWQ6IGZpcnN0LmNoYWluSWQsXG4gICAgICB0b2tlbkluOiBmaXJzdC50b2tlbkluLFxuICAgICAgdG9rZW5PdXQ6IGZpcnN0LnRva2VuT3V0LFxuICAgICAgcHJvdG9jb2xzQ292ZXJlZDogZmlyc3QucHJvdG9jb2xzQ292ZXJlZCxcbiAgICAgIGJsb2NrTnVtYmVyLFxuICAgICAgdHJhZGVUeXBlOiBmaXJzdC50cmFkZVR5cGUsXG4gICAgICBvcmlnaW5hbEFtb3VudCxcbiAgICAgIGJsb2Nrc1RvTGl2ZTogZmlyc3QuYmxvY2tzVG9MaXZlLFxuICAgIH0pXG5cbiAgICBtZXRyaWMucHV0TWV0cmljKGBVbmlxdWVSb3V0ZXNEYkZvdW5kYCwgY2FjaGVkUm91dGVzLnJvdXRlcy5sZW5ndGgsIE1ldHJpY0xvZ2dlclVuaXQuQ291bnQpXG5cbiAgICBsb2cuaW5mbyh7IGNhY2hlZFJvdXRlcyB9LCBgW0R5bmFtb1JvdXRlQ2FjaGluZ1Byb3ZpZGVyXSBSZXR1cm5pbmcgdGhlIGNhY2hlZCBhbmQgdW5tYXJzaGFsbGVkIHJvdXRlLmApXG5cbiAgICAvLyBOb3JtYWxpemUgYmxvY2tzIGRpZmZlcmVuY2UsIGlmIHRoZSByb3V0ZSBpcyBmcm9tIGEgbmV3IGJsb2NrICh3aGljaCBjb3VsZCBoYXBwZW4gaW4gTDJzKSwgY29uc2lkZXIgaXQgc2FtZSBibG9ja1xuICAgIGNvbnN0IGJsb2Nrc0RpZmZlcmVuY2UgPSBNYXRoLm1heCgwLCBjdXJyZW50QmxvY2tOdW1iZXIgLSBibG9ja051bWJlcilcbiAgICBtZXRyaWMucHV0TWV0cmljKGBSb3V0ZXNEYkJsb2NrRGlmZmVyZW5jZWAsIGJsb2Nrc0RpZmZlcmVuY2UsIE1ldHJpY0xvZ2dlclVuaXQuQ291bnQpXG4gICAgbWV0cmljLnB1dE1ldHJpYyhgUm91dGVzRGJCbG9ja0RpZmZlcmVuY2VfJHtJRF9UT19ORVRXT1JLX05BTUUoY2hhaW5JZCl9YCwgYmxvY2tzRGlmZmVyZW5jZSwgTWV0cmljTG9nZ2VyVW5pdC5Db3VudClcblxuICAgIGNvbnN0IG5vdEV4cGlyZWRDYWNoZWRSb3V0ZSA9IGNhY2hlZFJvdXRlcy5ub3RFeHBpcmVkKGN1cnJlbnRCbG9ja051bWJlciwgb3B0aW1pc3RpYylcbiAgICBpZiAobm90RXhwaXJlZENhY2hlZFJvdXRlKSB7XG4gICAgICBtZXRyaWMucHV0TWV0cmljKGBSb3V0ZXNEYk5vdEV4cGlyZWRgLCAxLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuICAgIH0gZWxzZSB7XG4gICAgICBtZXRyaWMucHV0TWV0cmljKGBSb3V0ZXNEYkV4cGlyZWRgLCAxLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuICAgIH1cblxuICAgIC8vIENhY2hpbmcgcmVxdWVzdHMgYXJlIG5vdCBgb3B0aW1pc3RpY2AsIHdlIG5lZWQgdG8gYmUgY2FyZWZ1bCBvZiBub3QgcmVtb3ZpbmcgdGhpcyBmbGFnXG4gICAgLy8gVGhpcyBjb25kaXRpb24gaXMgcHJvdGVjdGluZyB1cyBhZ2FpbnN0IGZpcmluZyBhbm90aGVyIGNhY2hpbmcgcmVxdWVzdCBmcm9tIGluc2lkZSBhIGNhY2hpbmcgcmVxdWVzdFxuICAgIGlmIChvcHRpbWlzdGljKSB7XG4gICAgICAvLyBXZSBzZW5kIGFuIGFzeW5jIGNhY2hpbmcgcXVvdGVcbiAgICAgIC8vIHdlIGRvIG5vdCBhd2FpdCBvbiB0aGlzIGZ1bmN0aW9uLCBpdCdzIGEgZmlyZSBhbmQgZm9yZ2V0XG4gICAgICB0aGlzLm1heWJlU2VuZENhY2hpbmdRdW90ZUZvclJvdXRlc0RiKHBhcnRpdGlvbktleSwgYW1vdW50LCBjdXJyZW50QmxvY2tOdW1iZXIpXG4gICAgfVxuXG4gICAgcmV0dXJuIGNhY2hlZFJvdXRlc1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBtYXliZVNlbmRDYWNoaW5nUXVvdGVGb3JSb3V0ZXNEYihcbiAgICBwYXJ0aXRpb25LZXk6IFBhaXJUcmFkZVR5cGVDaGFpbklkLFxuICAgIGFtb3VudDogQ3VycmVuY3lBbW91bnQ8Q3VycmVuY3k+LFxuICAgIGN1cnJlbnRCbG9ja051bWJlcjogbnVtYmVyXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgVGFibGVOYW1lOiB0aGlzLnJvdXRlc0NhY2hpbmdSZXF1ZXN0RmxhZ1RhYmxlTmFtZSxcbiAgICAgICAgLy8gV2UgdXNlIGEgcmF0aW8gdG8gZ2V0IGEgcmFuZ2Ugb2YgYW1vdW50cyB0aGF0IGFyZSBjbG9zZSB0byB0aGUgYW1vdW50IHdlIGFyZSB0aGlua2luZyBhYm91dCBpbnNlcnRpbmdcbiAgICAgICAgLy8gSWYgdGhlcmUncyBhbiBpdGVtIGluIHRoZSB0YWJsZSB3aGljaCByYW5nZSBjb3ZlcnMgb3VyIGFtb3VudCwgd2UgZG9uJ3QgbmVlZCB0byBzZW5kIGEgY2FjaGluZyByZXF1ZXN0XG4gICAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICcjcGsgPSA6cGsgQU5EICNhbW91bnQgQkVUV0VFTiA6YW1vdW50IEFORCA6YW1vdW50X3JhdGlvJyxcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICAgJyNwayc6ICdwYWlyVHJhZGVUeXBlQ2hhaW5JZCcsXG4gICAgICAgICAgJyNhbW91bnQnOiAnYW1vdW50JyxcbiAgICAgICAgfSxcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICc6cGsnOiBwYXJ0aXRpb25LZXkudG9TdHJpbmcoKSxcbiAgICAgICAgICAnOmFtb3VudCc6IHBhcnNlRmxvYXQoYW1vdW50LnRvRXhhY3QoKSksXG4gICAgICAgICAgJzphbW91bnRfcmF0aW8nOiBwYXJzZUZsb2F0KGFtb3VudC5tdWx0aXBseSh0aGlzLlJPVVRFU19EQl9CVUNLRVRfUkFUSU8pLnRvRXhhY3QoKSksXG4gICAgICAgIH0sXG4gICAgICB9XG5cbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoJ0NhY2hpbmdRdW90ZUZvclJvdXRlc0RiQ2hlY2snLCAxLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmRkYkNsaWVudC5xdWVyeShxdWVyeVBhcmFtcykucHJvbWlzZSgpXG4gICAgICBjb25zdCBzaG91bGRTZW5kQ2FjaGluZ1JlcXVlc3QgPVxuICAgICAgICByZXN1bHQuSXRlbXMgJiZcbiAgICAgICAgKHJlc3VsdC5JdGVtcy5sZW5ndGggPT0gMCB8fCAvLyBubyBjYWNoaW5nIHJlcXVlc3QgaGFzIGJlZW4gc2VudCByZWNlbnRseVxuICAgICAgICAgIC8vIG9yIGV2ZXJ5IHNhbXBsZWQgcmVjb3JkIGlzIG9sZGVyIHRoYW4gbWF4aW11bSBibG9ja3MgZGlmZiBhbGxvd2VkIGZvciB0aGUgY2hhaW5cbiAgICAgICAgICByZXN1bHQuSXRlbXMuZXZlcnkoKHJlY29yZCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgYmxvY2tzRGlmZiA9IGN1cnJlbnRCbG9ja051bWJlciAtIChyZWNvcmQuYmxvY2tOdW1iZXIgPz8gMClcbiAgICAgICAgICAgIGNvbnN0IG1heGltdW1CbG9ja3NEaWZmID1cbiAgICAgICAgICAgICAgdGhpcy5CTE9DS1NfRElGRl9CRVRXRUVOX0NBQ0hJTkdfUVVPVEVTLmdldChwYXJ0aXRpb25LZXkuY2hhaW5JZCkgfHwgdGhpcy5ERUZBVUxUX0JMT0NLU19ESUZGX0NBQ0hJTkdcbiAgICAgICAgICAgIHJldHVybiBibG9ja3NEaWZmID4gbWF4aW11bUJsb2Nrc0RpZmZcbiAgICAgICAgICB9KSlcblxuICAgICAgLy8gaWYgbm8gSXRlbSBpcyBmb3VuZCBpdCBtZWFucyB3ZSBuZWVkIHRvIHNlbmQgYSBjYWNoaW5nIHJlcXVlc3RcbiAgICAgIGlmIChzaG91bGRTZW5kQ2FjaGluZ1JlcXVlc3QpIHtcbiAgICAgICAgbWV0cmljLnB1dE1ldHJpYygnQ2FjaGluZ1F1b3RlRm9yUm91dGVzRGJSZXF1ZXN0U2VudCcsIDEsIE1ldHJpY0xvZ2dlclVuaXQuQ291bnQpXG4gICAgICAgIHRoaXMuc2VuZEFzeW5jQ2FjaGluZ1JlcXVlc3QocGFydGl0aW9uS2V5LCBbUHJvdG9jb2wuVjIsIFByb3RvY29sLlYzLCBQcm90b2NvbC5NSVhFRF0sIGFtb3VudClcbiAgICAgICAgdGhpcy5zZXRSb3V0ZXNEYkNhY2hpbmdJbnRlbnRGbGFnKHBhcnRpdGlvbktleSwgYW1vdW50LCBjdXJyZW50QmxvY2tOdW1iZXIpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtZXRyaWMucHV0TWV0cmljKCdDYWNoaW5nUXVvdGVGb3JSb3V0ZXNEYlJlcXVlc3ROb3ROZWVkZWQnLCAxLCBNZXRyaWNMb2dnZXJVbml0LkNvdW50KVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZy5lcnJvcihgW0R5bmFtb1JvdXRlQ2FjaGluZ1Byb3ZpZGVyXSBFcnJvciBjaGVja2luZyBpZiBjYWNoaW5nIHJlcXVlc3QgZm9yIFJvdXRlc0RiIHdhcyBzZW50OiAke2V9LmApXG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZW5kQXN5bmNDYWNoaW5nUmVxdWVzdChcbiAgICBwYXJ0aXRpb25LZXk6IFBhaXJUcmFkZVR5cGVDaGFpbklkLFxuICAgIHByb3RvY29sczogUHJvdG9jb2xbXSxcbiAgICBhbW91bnQ6IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5PlxuICApOiB2b2lkIHtcbiAgICBjb25zdCBwYXlsb2FkID0ge1xuICAgICAgcXVlcnlTdHJpbmdQYXJhbWV0ZXJzOiB7XG4gICAgICAgIHRva2VuSW5BZGRyZXNzOiBwYXJ0aXRpb25LZXkudG9rZW5JbixcbiAgICAgICAgdG9rZW5JbkNoYWluSWQ6IHBhcnRpdGlvbktleS5jaGFpbklkLnRvU3RyaW5nKCksXG4gICAgICAgIHRva2VuT3V0QWRkcmVzczogcGFydGl0aW9uS2V5LnRva2VuT3V0LFxuICAgICAgICB0b2tlbk91dENoYWluSWQ6IHBhcnRpdGlvbktleS5jaGFpbklkLnRvU3RyaW5nKCksXG4gICAgICAgIGFtb3VudDogYW1vdW50LnF1b3RpZW50LnRvU3RyaW5nKCksXG4gICAgICAgIHR5cGU6IHBhcnRpdGlvbktleS50cmFkZVR5cGUgPT09IDAgPyAnZXhhY3RJbicgOiAnZXhhY3RPdXQnLFxuICAgICAgICBwcm90b2NvbHM6IHByb3RvY29scy5tYXAoKHByb3RvY29sKSA9PiBwcm90b2NvbC50b0xvd2VyQ2FzZSgpKS5qb2luKCcsJyksXG4gICAgICAgIGludGVudDogJ2NhY2hpbmcnLFxuICAgICAgfSxcbiAgICB9XG5cbiAgICBjb25zdCBwYXJhbXMgPSB7XG4gICAgICBGdW5jdGlvbk5hbWU6IHRoaXMuY2FjaGluZ1F1b3RlTGFtYmRhTmFtZSxcbiAgICAgIEludm9jYXRpb25UeXBlOiAnRXZlbnQnLFxuICAgICAgUGF5bG9hZDogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCksXG4gICAgfVxuXG4gICAgbG9nLmluZm8oYFtEeW5hbW9Sb3V0ZUNhY2hpbmdQcm92aWRlcl0gU2VuZGluZyBhc3luYyBjYWNoaW5nIHJlcXVlc3QgdG8gbGFtYmRhICR7SlNPTi5zdHJpbmdpZnkocGFyYW1zKX1gKVxuXG4gICAgdGhpcy5sYW1iZGFDbGllbnQuaW52b2tlKHBhcmFtcykucHJvbWlzZSgpXG4gIH1cblxuICBwcml2YXRlIHNldFJvdXRlc0RiQ2FjaGluZ0ludGVudEZsYWcoXG4gICAgcGFydGl0aW9uS2V5OiBQYWlyVHJhZGVUeXBlQ2hhaW5JZCxcbiAgICBhbW91bnQ6IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5PixcbiAgICBjdXJyZW50QmxvY2tOdW1iZXI6IG51bWJlclxuICApOiB2b2lkIHtcbiAgICBjb25zdCBwdXRQYXJhbXMgPSB7XG4gICAgICBUYWJsZU5hbWU6IHRoaXMucm91dGVzQ2FjaGluZ1JlcXVlc3RGbGFnVGFibGVOYW1lLFxuICAgICAgSXRlbToge1xuICAgICAgICBwYWlyVHJhZGVUeXBlQ2hhaW5JZDogcGFydGl0aW9uS2V5LnRvU3RyaW5nKCksXG4gICAgICAgIGFtb3VudDogcGFyc2VGbG9hdChhbW91bnQudG9FeGFjdCgpKSxcbiAgICAgICAgdHRsOiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSArIHRoaXMuUk9VVEVTX0RCX0ZMQUdfVFRMLFxuICAgICAgICBibG9ja051bWJlcjogY3VycmVudEJsb2NrTnVtYmVyLFxuICAgICAgfSxcbiAgICB9XG5cbiAgICB0aGlzLmRkYkNsaWVudC5wdXQocHV0UGFyYW1zKS5wcm9taXNlKClcbiAgfVxuXG4gIC8qKlxuICAgKiBJbXBsZW1lbnRhdGlvbiBvZiB0aGUgYWJzdHJhY3QgbWV0aG9kIGRlZmluZWQgaW4gYElSb3V0ZUNhY2hpbmdQcm92aWRlcmBcbiAgICogQXR0ZW1wdHMgdG8gaW5zZXJ0IHRoZSBgQ2FjaGVkUm91dGVzYCBvYmplY3QgaW50byBjYWNoZSwgaWYgdGhlIENhY2hpbmdTdHJhdGVneSByZXR1cm5zIHRoZSBDYWNoaW5nUGFyYW1ldGVyc1xuICAgKlxuICAgKiBAcGFyYW0gY2FjaGVkUm91dGVzXG4gICAqIEBwcm90ZWN0ZWRcbiAgICovXG4gIHByb3RlY3RlZCBhc3luYyBfc2V0Q2FjaGVkUm91dGUoY2FjaGVkUm91dGVzOiBDYWNoZWRSb3V0ZXMpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICBjb25zdCByb3V0ZXNEYkVudHJpZXMgPSBjYWNoZWRSb3V0ZXMucm91dGVzLm1hcCgocm91dGUpID0+IHtcbiAgICAgIGNvbnN0IGluZGl2aWR1YWxDYWNoZWRSb3V0ZXMgPSBuZXcgQ2FjaGVkUm91dGVzKHtcbiAgICAgICAgcm91dGVzOiBbcm91dGVdLFxuICAgICAgICBjaGFpbklkOiBjYWNoZWRSb3V0ZXMuY2hhaW5JZCxcbiAgICAgICAgdG9rZW5JbjogY2FjaGVkUm91dGVzLnRva2VuSW4sXG4gICAgICAgIHRva2VuT3V0OiBjYWNoZWRSb3V0ZXMudG9rZW5PdXQsXG4gICAgICAgIHByb3RvY29sc0NvdmVyZWQ6IGNhY2hlZFJvdXRlcy5wcm90b2NvbHNDb3ZlcmVkLFxuICAgICAgICBibG9ja051bWJlcjogY2FjaGVkUm91dGVzLmJsb2NrTnVtYmVyLFxuICAgICAgICB0cmFkZVR5cGU6IGNhY2hlZFJvdXRlcy50cmFkZVR5cGUsXG4gICAgICAgIG9yaWdpbmFsQW1vdW50OiBjYWNoZWRSb3V0ZXMub3JpZ2luYWxBbW91bnQsXG4gICAgICB9KVxuICAgICAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyB0aGlzLlJPVVRFU19EQl9UVExcbiAgICAgIC8vIE1hcnNoYWwgdGhlIENhY2hlZFJvdXRlcyBvYmplY3QgaW4gcHJlcGFyYXRpb24gZm9yIHN0b3JpbmcgaW4gRHluYW1vREJcbiAgICAgIGNvbnN0IG1hcnNoYWxsZWRDYWNoZWRSb3V0ZXMgPSBDYWNoZWRSb3V0ZXNNYXJzaGFsbGVyLm1hcnNoYWwoaW5kaXZpZHVhbENhY2hlZFJvdXRlcylcbiAgICAgIC8vIENvbnZlcnQgdGhlIG1hcnNoYWxsZWRDYWNoZWRSb3V0ZXMgdG8gSlNPTiBzdHJpbmdcbiAgICAgIGNvbnN0IGpzb25DYWNoZWRSb3V0ZXMgPSBKU09OLnN0cmluZ2lmeShtYXJzaGFsbGVkQ2FjaGVkUm91dGVzKVxuICAgICAgLy8gRW5jb2RlIHRoZSBqc29uQ2FjaGVkUm91dGVzIGludG8gQmluYXJ5XG4gICAgICBjb25zdCBiaW5hcnlDYWNoZWRSb3V0ZXMgPSBCdWZmZXIuZnJvbShqc29uQ2FjaGVkUm91dGVzKVxuXG4gICAgICBjb25zdCBwYXJ0aXRpb25LZXkgPSBQYWlyVHJhZGVUeXBlQ2hhaW5JZC5mcm9tQ2FjaGVkUm91dGVzKGNhY2hlZFJvdXRlcylcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgUHV0UmVxdWVzdDoge1xuICAgICAgICAgIEl0ZW06IHtcbiAgICAgICAgICAgIHBhaXJUcmFkZVR5cGVDaGFpbklkOiBwYXJ0aXRpb25LZXkudG9TdHJpbmcoKSxcbiAgICAgICAgICAgIHJvdXRlSWQ6IHJvdXRlLnJvdXRlSWQsXG4gICAgICAgICAgICBibG9ja051bWJlcjogY2FjaGVkUm91dGVzLmJsb2NrTnVtYmVyLFxuICAgICAgICAgICAgcHJvdG9jb2w6IHJvdXRlLnByb3RvY29sLnRvU3RyaW5nKCksXG4gICAgICAgICAgICBpdGVtOiBiaW5hcnlDYWNoZWRSb3V0ZXMsXG4gICAgICAgICAgICB0dGw6IHR0bCxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfVxuICAgIH0pXG5cbiAgICBpZiAocm91dGVzRGJFbnRyaWVzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGJhdGNoV3JpdGVQYXJhbXMgPSB7XG4gICAgICAgICAgUmVxdWVzdEl0ZW1zOiB7XG4gICAgICAgICAgICBbdGhpcy5yb3V0ZXNUYWJsZU5hbWVdOiByb3V0ZXNEYkVudHJpZXMsXG4gICAgICAgICAgfSxcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCB0aGlzLmRkYkNsaWVudC5iYXRjaFdyaXRlKGJhdGNoV3JpdGVQYXJhbXMpLnByb21pc2UoKVxuICAgICAgICBsb2cuaW5mbyhgW0R5bmFtb1JvdXRlQ2FjaGluZ1Byb3ZpZGVyXSBSb3V0ZSBFbnRyaWVzIGluc2VydGVkIHRvIGRhdGFiYXNlYClcblxuICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgbG9nLmVycm9yKHsgZXJyb3IsIHJvdXRlc0RiRW50cmllcyB9LCBgW0R5bmFtb1JvdXRlQ2FjaGluZ1Byb3ZpZGVyXSBSb3V0ZSBFbnRyaWVzIGZhaWxlZCB0byBpbnNlcnRgKVxuXG4gICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBsb2cud2FybihgW0R5bmFtb1JvdXRlQ2FjaGluZ1Byb3ZpZGVyXSBObyBSb3V0ZSBFbnRyaWVzIHRvIGluc2VydGApXG4gICAgICByZXR1cm4gZmFsc2VcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogSW1wbGVtZW50YXRpb24gb2YgdGhlIGFic3RyYWN0IG1ldGhvZCBkZWZpbmVkIGluIGBJUm91dGVDYWNoaW5nUHJvdmlkZXJgXG4gICAqIE9idGFpbnMgdGhlIENhY2hlTW9kZSBmcm9tIHRoZSBDYWNoaW5nU3RyYXRlZ3ksIGlmIG5vdCBmb3VuZCwgdGhlbiByZXR1cm4gRGFya21vZGUuXG4gICAqXG4gICAqIEBwYXJhbSBfY2hhaW5JZFxuICAgKiBAcGFyYW0gX2Ftb3VudFxuICAgKiBAcGFyYW0gX3F1b3RlVG9rZW5cbiAgICogQHBhcmFtIF90cmFkZVR5cGVcbiAgICogQHBhcmFtIF9wcm90b2NvbHNcbiAgICovXG4gIHB1YmxpYyBhc3luYyBnZXRDYWNoZU1vZGUoXG4gICAgX2NoYWluSWQ6IENoYWluSWQsXG4gICAgX2Ftb3VudDogQ3VycmVuY3lBbW91bnQ8Q3VycmVuY3k+LFxuICAgIF9xdW90ZVRva2VuOiBUb2tlbixcbiAgICBfdHJhZGVUeXBlOiBUcmFkZVR5cGUsXG4gICAgX3Byb3RvY29sczogUHJvdG9jb2xbXVxuICApOiBQcm9taXNlPENhY2hlTW9kZT4ge1xuICAgIHJldHVybiB0aGlzLkRFRkFVTFRfQ0FDSEVNT0RFX1JPVVRFU19EQlxuICB9XG5cbiAgLyoqXG4gICAqIFJvdXRlc0RCIHNlbGYtY29ycmVjdGluZyBtZWNoYW5pc20gYWxsb3dzIHVzIHRvIGxvb2sgYXQgcm91dGVzIHRoYXQgd291bGQgaGF2ZSBiZWVuIGNvbnNpZGVyZWQgZXhwaXJlZFxuICAgKiBXZSBvdmVycmlkZSB0aGlzIG1ldGhvZCB0byBpbmNyZWFzZSBvdXIgY2FjaGUgY292ZXJhZ2UuXG4gICAqXG4gICAqIEBwYXJhbSBjYWNoZWRSb3V0ZXNcbiAgICogQHBhcmFtIF9ibG9ja051bWJlclxuICAgKiBAcGFyYW0gX29wdGltaXN0aWNcbiAgICogQHByb3RlY3RlZFxuICAgKi9cbiAgcHJvdGVjdGVkIG92ZXJyaWRlIGZpbHRlckV4cGlyZWRDYWNoZWRSb3V0ZXMoXG4gICAgY2FjaGVkUm91dGVzOiBDYWNoZWRSb3V0ZXMgfCB1bmRlZmluZWQsXG4gICAgX2Jsb2NrTnVtYmVyOiBudW1iZXIsXG4gICAgX29wdGltaXN0aWM6IGJvb2xlYW5cbiAgKTogQ2FjaGVkUm91dGVzIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gY2FjaGVkUm91dGVzXG4gIH1cblxuICAvKipcbiAgICogSGVscGVyIGZ1bmN0aW9uIHRvIGRldGVybWluZSB0aGUgdG9rZW5JbiBhbmQgdG9rZW5PdXQgZ2l2ZW4gdGhlIHRyYWRlVHlwZSwgcXVvdGVUb2tlbiBhbmQgYW1vdW50LmN1cnJlbmN5XG4gICAqXG4gICAqIEBwYXJhbSBhbW91bnRcbiAgICogQHBhcmFtIHF1b3RlVG9rZW5cbiAgICogQHBhcmFtIHRyYWRlVHlwZVxuICAgKiBAcHJpdmF0ZVxuICAgKi9cbiAgcHJpdmF0ZSBkZXRlcm1pbmVUb2tlbkluT3V0KFxuICAgIGFtb3VudDogQ3VycmVuY3lBbW91bnQ8Q3VycmVuY3k+LFxuICAgIHF1b3RlVG9rZW46IFRva2VuLFxuICAgIHRyYWRlVHlwZTogVHJhZGVUeXBlXG4gICk6IHsgdG9rZW5JbjogVG9rZW47IHRva2VuT3V0OiBUb2tlbiB9IHtcbiAgICBpZiAodHJhZGVUeXBlID09IFRyYWRlVHlwZS5FWEFDVF9JTlBVVCkge1xuICAgICAgcmV0dXJuIHsgdG9rZW5JbjogYW1vdW50LmN1cnJlbmN5LndyYXBwZWQsIHRva2VuT3V0OiBxdW90ZVRva2VuIH1cbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIHsgdG9rZW5JbjogcXVvdGVUb2tlbiwgdG9rZW5PdXQ6IGFtb3VudC5jdXJyZW5jeS53cmFwcGVkIH1cbiAgICB9XG4gIH1cbn1cbiJdfQ==