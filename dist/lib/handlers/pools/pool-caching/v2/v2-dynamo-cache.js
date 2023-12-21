import { DocumentClient } from 'aws-sdk/clients/dynamodb';
import { log, metric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import { PairMarshaller } from '../../../marshalling';
export class V2DynamoCache {
    constructor(tableName) {
        this.tableName = tableName;
        this.DEFAULT_TTL = 60; // 1 minute
        this.ddbClient = new DocumentClient({
            maxRetries: 1,
            retryDelayOptions: {
                base: 20,
            },
            httpOptions: {
                timeout: 100,
            },
        });
    }
    // TODO: ROUTE-81 & ROUTE-84 - once smart-order-router updates the ICache.batchGet API to take in
    // composite key as part of ROUTE-83, then we can leverage the batchGet Dynamo call
    // for both caching-pool-provider and token-properties-provider
    // Prior to completion of ROUTE-81 & ROUTE-84, this function is not being called anywhere.
    async batchGet(keys) {
        var _a, _b, _c, _d, _e, _f;
        const records = {};
        const batchGetParams = {
            RequestItems: {
                [this.tableName]: {
                    Keys: Array.from(keys).map((key) => {
                        // TODO: ROUTE-83 fix the ICache.batchGet to allow passing in composite key type
                        // instead of a simple string type
                        // then fix the key destructuring here
                        const [cacheKey, block] = key.split(':', 2);
                        return {
                            cacheKey: { S: cacheKey },
                            block: { N: block },
                        };
                    }),
                },
            },
        };
        const result = await this.ddbClient.batchGet(batchGetParams).promise();
        const unprocessedKeys = (_b = (_a = result === null || result === void 0 ? void 0 : result.UnprocessedKeys) === null || _a === void 0 ? void 0 : _a[this.tableName]) === null || _b === void 0 ? void 0 : _b.Keys;
        if (unprocessedKeys && unprocessedKeys.length > 0) {
            metric.putMetric('V2_PAIRS_DYNAMO_CACHING_UNPROCESSED_KEYS', unprocessedKeys.length, MetricLoggerUnit.None);
        }
        return ((_f = (_e = (_d = (_c = result.Responses) === null || _c === void 0 ? void 0 : _c[this.tableName]) === null || _d === void 0 ? void 0 : _d.map((item) => {
            const key = item.cacheKey.S;
            const block = parseInt(item.block.N);
            const itemBinary = item.item.B;
            const pairBuffer = Buffer.from(itemBinary);
            const pairJson = JSON.parse(pairBuffer.toString());
            return {
                [key]: {
                    pair: PairMarshaller.unmarshal(pairJson),
                    block,
                },
            };
        })) === null || _e === void 0 ? void 0 : _e.reduce((accumulatedRecords, currentRecord) => ({ ...accumulatedRecords, ...currentRecord }), records)) !== null && _f !== void 0 ? _f : records);
    }
    async get(key) {
        try {
            const queryParams = {
                TableName: this.tableName,
                // Since we don't know what's the latest block that we have in cache, we make a query with a partial sort key
                KeyConditionExpression: '#pk = :pk',
                ExpressionAttributeNames: {
                    '#pk': 'cacheKey',
                },
                ExpressionAttributeValues: {
                    ':pk': key,
                },
                ScanIndexForward: false,
                Limit: Math.max(1),
            };
            const result = await this.ddbClient.query(queryParams).promise();
            if (result.Items && result.Items.length > 0) {
                const record = result.Items[0];
                // If we got a response with more than 1 item, we extract the binary field from the response
                const itemBinary = record.item;
                // Then we convert it into a Buffer
                const pairBuffer = Buffer.from(itemBinary);
                // We convert that buffer into string and parse as JSON (it was encoded as JSON when it was inserted into cache)
                const pairJson = JSON.parse(pairBuffer.toString());
                // Finally we unmarshal that JSON into a `Pair` object
                return {
                    pair: PairMarshaller.unmarshal(pairJson),
                    block: record.block,
                };
            }
            else {
                log.info('[V2DynamoCache] No V2Pair found in cache');
                return;
            }
        }
        catch (e) {
            log.error({ e }, '[V2DynamoCache] Error calling dynamoDB');
        }
        return Promise.resolve(undefined);
    }
    has(key) {
        return this.get(key).then((value) => value != undefined);
    }
    async set(key, value) {
        if (value.block == undefined) {
            log.error('[V2DynamoCache] We can only cache values with a block number');
            return false;
        }
        else {
            // Marshal the Pair object in preparation for storing in DynamoDB
            const marshalledPair = PairMarshaller.marshal(value.pair);
            // Convert the marshalledPair to JSON string
            const jsonPair = JSON.stringify(marshalledPair);
            // Encode the jsonPair into Binary
            const binaryPair = Buffer.from(jsonPair);
            const putParams = {
                TableName: this.tableName,
                Item: {
                    cacheKey: key,
                    block: value.block,
                    item: binaryPair,
                    ttl: Math.floor(Date.now() / 1000) + this.DEFAULT_TTL,
                },
            };
            try {
                await this.ddbClient.put(putParams).promise();
                log.info(`[V2DynamoCache] Pair inserted to cache`);
                return true;
            }
            catch (error) {
                log.error({ error, putParams }, `[V2DynamoCache] Pair failed to insert`);
                return false;
            }
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidjItZHluYW1vLWNhY2hlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vbGliL2hhbmRsZXJzL3Bvb2xzL3Bvb2wtY2FjaGluZy92Mi92Mi1keW5hbW8tY2FjaGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBRUEsT0FBTyxFQUFxQixjQUFjLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQTtBQUM1RSxPQUFPLEVBQUUsR0FBRyxFQUFFLE1BQU0sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLDZCQUE2QixDQUFBO0FBQzNFLE9BQU8sRUFBa0IsY0FBYyxFQUFFLE1BQU0sc0JBQXNCLENBQUE7QUFFckUsTUFBTSxPQUFPLGFBQWE7SUFHeEIsWUFBNkIsU0FBaUI7UUFBakIsY0FBUyxHQUFULFNBQVMsQ0FBUTtRQUQ3QixnQkFBVyxHQUFHLEVBQUUsQ0FBQSxDQUFDLFdBQVc7UUFFM0MsSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLGNBQWMsQ0FBQztZQUNsQyxVQUFVLEVBQUUsQ0FBQztZQUNiLGlCQUFpQixFQUFFO2dCQUNqQixJQUFJLEVBQUUsRUFBRTthQUNUO1lBQ0QsV0FBVyxFQUFFO2dCQUNYLE9BQU8sRUFBRSxHQUFHO2FBQ2I7U0FDRixDQUFDLENBQUE7SUFDSixDQUFDO0lBRUQsaUdBQWlHO0lBQ2pHLG1GQUFtRjtJQUNuRiwrREFBK0Q7SUFDL0QsMEZBQTBGO0lBQzFGLEtBQUssQ0FBQyxRQUFRLENBQUMsSUFBaUI7O1FBQzlCLE1BQU0sT0FBTyxHQUEyRSxFQUFFLENBQUE7UUFDMUYsTUFBTSxjQUFjLEdBQXNCO1lBQ3hDLFlBQVksRUFBRTtnQkFDWixDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRTtvQkFDaEIsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxFQUFFLEVBQUU7d0JBQ2pDLGdGQUFnRjt3QkFDaEYsa0NBQWtDO3dCQUNsQyxz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QUE0QztZQUM1QyxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLGNBQWMsQ0FBQyxDQUFBO1lBQy9DLGtDQUFrQztZQUNsQyxNQUFNLFVBQVUsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFBO1lBRXhDLE1BQU0sU0FBUyxHQUFHO2dCQUNoQixTQUFTLEVBQUUsSUFBSSxDQUFDLFNBQVM7Z0JBQ3pCLElBQUksRUFBRTtvQkFDSixRQUFRLEVBQUUsR0FBRztvQkFDYixLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUs7b0JBQ2xCLElBQUksRUFBRSxVQUFVO29CQUNoQixHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsSUFBSSxDQUFDLFdBQVc7aUJBQ3REO2FBQ0YsQ0FBQTtZQUVELElBQUk7Z0JBQ0YsTUFBTSxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQTtnQkFDN0MsR0FBRyxDQUFDLElBQUksQ0FBQyx3Q0FBd0MsQ0FBQyxDQUFBO2dCQUVsRCxPQUFPLElBQUksQ0FBQTthQUNaO1lBQUMsT0FBTyxLQUFLLEVBQUU7Z0JBQ2QsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLEtBQUssRUFBRSxTQUFTLEVBQUUsRUFBRSx1Q0FBdUMsQ0FBQyxDQUFBO2dCQUV4RSxPQUFPLEtBQUssQ0FBQTthQUNiO1NBQ0Y7SUFDSCxDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBJQ2FjaGUgfSBmcm9tICdAdW5pc3dhcC9zbWFydC1vcmRlci1yb3V0ZXIvYnVpbGQvbWFpbi9wcm92aWRlcnMvY2FjaGUnXG5pbXBvcnQgeyBQYWlyIH0gZnJvbSAnQHVuaXN3YXAvdjItc2RrJ1xuaW1wb3J0IHsgQmF0Y2hHZXRJdGVtSW5wdXQsIERvY3VtZW50Q2xpZW50IH0gZnJvbSAnYXdzLXNkay9jbGllbnRzL2R5bmFtb2RiJ1xuaW1wb3J0IHsgbG9nLCBtZXRyaWMsIE1ldHJpY0xvZ2dlclVuaXQgfSBmcm9tICdAdW5pc3dhcC9zbWFydC1vcmRlci1yb3V0ZXInXG5pbXBvcnQgeyBNYXJzaGFsbGVkUGFpciwgUGFpck1hcnNoYWxsZXIgfSBmcm9tICcuLi8uLi8uLi9tYXJzaGFsbGluZydcblxuZXhwb3J0IGNsYXNzIFYyRHluYW1vQ2FjaGUgaW1wbGVtZW50cyBJQ2FjaGU8eyBwYWlyOiBQYWlyOyBibG9jaz86IG51bWJlciB9PiB7XG4gIHByaXZhdGUgcmVhZG9ubHkgZGRiQ2xpZW50OiBEb2N1bWVudENsaWVudFxuICBwcml2YXRlIHJlYWRvbmx5IERFRkFVTFRfVFRMID0gNjAgLy8gMSBtaW51dGVcbiAgY29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSB0YWJsZU5hbWU6IHN0cmluZykge1xuICAgIHRoaXMuZGRiQ2xpZW50ID0gbmV3IERvY3VtZW50Q2xpZW50KHtcbiAgICAgIG1heFJldHJpZXM6IDEsXG4gICAgICByZXRyeURlbGF5T3B0aW9uczoge1xuICAgICAgICBiYXNlOiAyMCxcbiAgICAgIH0sXG4gICAgICBodHRwT3B0aW9uczoge1xuICAgICAgICB0aW1lb3V0OiAxMDAsXG4gICAgICB9LFxuICAgIH0pXG4gIH1cblxuICAvLyBUT0RPOiBST1VURS04MSAmIFJPVVRFLTg0IC0gb25jZSBzbWFydC1vcmRlci1yb3V0ZXIgdXBkYXRlcyB0aGUgSUNhY2hlLmJhdGNoR2V0IEFQSSB0byB0YWtlIGluXG4gIC8vIGNvbXBvc2l0ZSBrZXkgYXMgcGFydCBvZiBST1VURS04MywgdGhlbiB3ZSBjYW4gbGV2ZXJhZ2UgdGhlIGJhdGNoR2V0IER5bmFtbyBjYWxsXG4gIC8vIGZvciBib3RoIGNhY2hpbmctcG9vbC1wcm92aWRlciBhbmQgdG9rZW4tcHJvcGVydGllcy1wcm92aWRlclxuICAvLyBQcmlvciB0byBjb21wbGV0aW9uIG9mIFJPVVRFLTgxICYgUk9VVEUtODQsIHRoaXMgZnVuY3Rpb24gaXMgbm90IGJlaW5nIGNhbGxlZCBhbnl3aGVyZS5cbiAgYXN5bmMgYmF0Y2hHZXQoa2V5czogU2V0PHN0cmluZz4pOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHsgcGFpcjogUGFpcjsgYmxvY2s/OiBudW1iZXIgfCB1bmRlZmluZWQgfSB8IHVuZGVmaW5lZD4+IHtcbiAgICBjb25zdCByZWNvcmRzOiBSZWNvcmQ8c3RyaW5nLCB7IHBhaXI6IFBhaXI7IGJsb2NrPzogbnVtYmVyIHwgdW5kZWZpbmVkIH0gfCB1bmRlZmluZWQ+ID0ge31cbiAgICBjb25zdCBiYXRjaEdldFBhcmFtczogQmF0Y2hHZXRJdGVtSW5wdXQgPSB7XG4gICAgICBSZXF1ZXN0SXRlbXM6IHtcbiAgICAgICAgW3RoaXMudGFibGVOYW1lXToge1xuICAgICAgICAgIEtleXM6IEFycmF5LmZyb20oa2V5cykubWFwKChrZXkpID0+IHtcbiAgICAgICAgICAgIC8vIFRPRE86IFJPVVRFLTgzIGZpeCB0aGUgSUNhY2hlLmJhdGNoR2V0IHRvIGFsbG93IHBhc3NpbmcgaW4gY29tcG9zaXRlIGtleSB0eXBlXG4gICAgICAgICAgICAvLyBpbnN0ZWFkIG9mIGEgc2ltcGxlIHN0cmluZyB0eXBlXG4gICAgICAgICAgICAvLyB0aGVuIGZpeCB0aGUga2V5IGRlc3RydWN0dXJpbmcgaGVyZVxuICAgICAgICAgICAgY29uc3QgW2NhY2hlS2V5LCBibG9ja10gPSBrZXkuc3BsaXQoJzonLCAyKVxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgY2FjaGVLZXk6IHsgUzogY2FjaGVLZXkgfSxcbiAgICAgICAgICAgICAgYmxvY2s6IHsgTjogYmxvY2sgfSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfVxuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5kZGJDbGllbnQuYmF0Y2hHZXQoYmF0Y2hHZXRQYXJhbXMpLnByb21pc2UoKVxuICAgIGNvbnN0IHVucHJvY2Vzc2VkS2V5cyA9IHJlc3VsdD8uVW5wcm9jZXNzZWRLZXlzPy5bdGhpcy50YWJsZU5hbWVdPy5LZXlzXG5cbiAgICBpZiAodW5wcm9jZXNzZWRLZXlzICYmIHVucHJvY2Vzc2VkS2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICBtZXRyaWMucHV0TWV0cmljKCdWMl9QQUlSU19EWU5BTU9fQ0FDSElOR19VTlBST0NFU1NFRF9LRVlTJywgdW5wcm9jZXNzZWRLZXlzLmxlbmd0aCwgTWV0cmljTG9nZ2VyVW5pdC5Ob25lKVxuICAgIH1cblxuICAgIHJldHVybiAoXG4gICAgICByZXN1bHQuUmVzcG9uc2VzPy5bdGhpcy50YWJsZU5hbWVdXG4gICAgICAgID8ubWFwKChpdGVtKSA9PiB7XG4gICAgICAgICAgY29uc3Qga2V5ID0gaXRlbS5jYWNoZUtleS5TIVxuICAgICAgICAgIGNvbnN0IGJsb2NrID0gcGFyc2VJbnQoaXRlbS5ibG9jay5OISlcbiAgICAgICAgICBjb25zdCBpdGVtQmluYXJ5ID0gaXRlbS5pdGVtLkIhXG4gICAgICAgICAgY29uc3QgcGFpckJ1ZmZlciA9IEJ1ZmZlci5mcm9tKGl0ZW1CaW5hcnkpXG4gICAgICAgICAgY29uc3QgcGFpckpzb246IE1hcnNoYWxsZWRQYWlyID0gSlNPTi5wYXJzZShwYWlyQnVmZmVyLnRvU3RyaW5nKCkpXG5cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgW2tleV06IHtcbiAgICAgICAgICAgICAgcGFpcjogUGFpck1hcnNoYWxsZXIudW5tYXJzaGFsKHBhaXJKc29uKSxcbiAgICAgICAgICAgICAgYmxvY2ssXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgICAgPy5yZWR1Y2UoKGFjY3VtdWxhdGVkUmVjb3JkcywgY3VycmVudFJlY29yZCkgPT4gKHsgLi4uYWNjdW11bGF0ZWRSZWNvcmRzLCAuLi5jdXJyZW50UmVjb3JkIH0pLCByZWNvcmRzKSA/P1xuICAgICAgcmVjb3Jkc1xuICAgIClcbiAgfVxuICBhc3luYyBnZXQoa2V5OiBzdHJpbmcpOiBQcm9taXNlPHsgcGFpcjogUGFpcjsgYmxvY2s/OiBudW1iZXIgfSB8IHVuZGVmaW5lZD4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBxdWVyeVBhcmFtcyA9IHtcbiAgICAgICAgVGFibGVOYW1lOiB0aGlzLnRhYmxlTmFtZSxcbiAgICAgICAgLy8gU2luY2Ugd2UgZG9uJ3Qga25vdyB3aGF0J3MgdGhlIGxhdGVzdCBibG9jayB0aGF0IHdlIGhhdmUgaW4gY2FjaGUsIHdlIG1ha2UgYSBxdWVyeSB3aXRoIGEgcGFydGlhbCBzb3J0IGtleVxuICAgICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uOiAnI3BrID0gOnBrJyxcbiAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICAgJyNwayc6ICdjYWNoZUtleScsXG4gICAgICAgIH0sXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAnOnBrJzoga2V5LFxuICAgICAgICB9LFxuICAgICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSwgLy8gUmV2ZXJzZSBvcmRlciB0byByZXRyaWV2ZSBtb3N0IHJlY2VudCBpdGVtIGZpcnN0XG4gICAgICAgIExpbWl0OiBNYXRoLm1heCgxKSxcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5kZGJDbGllbnQucXVlcnkocXVlcnlQYXJhbXMpLnByb21pc2UoKVxuXG4gICAgICBpZiAocmVzdWx0Lkl0ZW1zICYmIHJlc3VsdC5JdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IHJlY29yZCA9IHJlc3VsdC5JdGVtc1swXVxuICAgICAgICAvLyBJZiB3ZSBnb3QgYSByZXNwb25zZSB3aXRoIG1vcmUgdGhhbiAxIGl0ZW0sIHdlIGV4dHJhY3QgdGhlIGJpbmFyeSBmaWVsZCBmcm9tIHRoZSByZXNwb25zZVxuICAgICAgICBjb25zdCBpdGVtQmluYXJ5ID0gcmVjb3JkLml0ZW1cbiAgICAgICAgLy8gVGhlbiB3ZSBjb252ZXJ0IGl0IGludG8gYSBCdWZmZXJcbiAgICAgICAgY29uc3QgcGFpckJ1ZmZlciA9IEJ1ZmZlci5mcm9tKGl0ZW1CaW5hcnkpXG4gICAgICAgIC8vIFdlIGNvbnZlcnQgdGhhdCBidWZmZXIgaW50byBzdHJpbmcgYW5kIHBhcnNlIGFzIEpTT04gKGl0IHdhcyBlbmNvZGVkIGFzIEpTT04gd2hlbiBpdCB3YXMgaW5zZXJ0ZWQgaW50byBjYWNoZSlcbiAgICAgICAgY29uc3QgcGFpckpzb24gPSBKU09OLnBhcnNlKHBhaXJCdWZmZXIudG9TdHJpbmcoKSlcbiAgICAgICAgLy8gRmluYWxseSB3ZSB1bm1hcnNoYWwgdGhhdCBKU09OIGludG8gYSBgUGFpcmAgb2JqZWN0XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgcGFpcjogUGFpck1hcnNoYWxsZXIudW5tYXJzaGFsKHBhaXJKc29uKSxcbiAgICAgICAgICBibG9jazogcmVjb3JkLmJsb2NrLFxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2cuaW5mbygnW1YyRHluYW1vQ2FjaGVdIE5vIFYyUGFpciBmb3VuZCBpbiBjYWNoZScpXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZy5lcnJvcih7IGUgfSwgJ1tWMkR5bmFtb0NhY2hlXSBFcnJvciBjYWxsaW5nIGR5bmFtb0RCJylcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh1bmRlZmluZWQpXG4gIH1cblxuICBoYXMoa2V5OiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICByZXR1cm4gdGhpcy5nZXQoa2V5KS50aGVuKCh2YWx1ZSkgPT4gdmFsdWUgIT0gdW5kZWZpbmVkKVxuICB9XG5cbiAgYXN5bmMgc2V0KGtleTogc3RyaW5nLCB2YWx1ZTogeyBwYWlyOiBQYWlyOyBibG9jaz86IG51bWJlciB9KTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgaWYgKHZhbHVlLmJsb2NrID09IHVuZGVmaW5lZCkge1xuICAgICAgbG9nLmVycm9yKCdbVjJEeW5hbW9DYWNoZV0gV2UgY2FuIG9ubHkgY2FjaGUgdmFsdWVzIHdpdGggYSBibG9jayBudW1iZXInKVxuICAgICAgcmV0dXJuIGZhbHNlXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIE1hcnNoYWwgdGhlIFBhaXIgb2JqZWN0IGluIHByZXBhcmF0aW9uIGZvciBzdG9yaW5nIGluIER5bmFtb0RCXG4gICAgICBjb25zdCBtYXJzaGFsbGVkUGFpciA9IFBhaXJNYXJzaGFsbGVyLm1hcnNoYWwodmFsdWUucGFpcilcbiAgICAgIC8vIENvbnZlcnQgdGhlIG1hcnNoYWxsZWRQYWlyIHRvIEpTT04gc3RyaW5nXG4gICAgICBjb25zdCBqc29uUGFpciA9IEpTT04uc3RyaW5naWZ5KG1hcnNoYWxsZWRQYWlyKVxuICAgICAgLy8gRW5jb2RlIHRoZSBqc29uUGFpciBpbnRvIEJpbmFyeVxuICAgICAgY29uc3QgYmluYXJ5UGFpciA9IEJ1ZmZlci5mcm9tKGpzb25QYWlyKVxuXG4gICAgICBjb25zdCBwdXRQYXJhbXMgPSB7XG4gICAgICAgIFRhYmxlTmFtZTogdGhpcy50YWJsZU5hbWUsXG4gICAgICAgIEl0ZW06IHtcbiAgICAgICAgICBjYWNoZUtleToga2V5LFxuICAgICAgICAgIGJsb2NrOiB2YWx1ZS5ibG9jayxcbiAgICAgICAgICBpdGVtOiBiaW5hcnlQYWlyLFxuICAgICAgICAgIHR0bDogTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCkgKyB0aGlzLkRFRkFVTFRfVFRMLFxuICAgICAgICB9LFxuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB0aGlzLmRkYkNsaWVudC5wdXQocHV0UGFyYW1zKS5wcm9taXNlKClcbiAgICAgICAgbG9nLmluZm8oYFtWMkR5bmFtb0NhY2hlXSBQYWlyIGluc2VydGVkIHRvIGNhY2hlYClcblxuICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgbG9nLmVycm9yKHsgZXJyb3IsIHB1dFBhcmFtcyB9LCBgW1YyRHluYW1vQ2FjaGVdIFBhaXIgZmFpbGVkIHRvIGluc2VydGApXG5cbiAgICAgICAgcmV0dXJuIGZhbHNlXG4gICAgICB9XG4gICAgfVxuICB9XG59XG4iXX0=