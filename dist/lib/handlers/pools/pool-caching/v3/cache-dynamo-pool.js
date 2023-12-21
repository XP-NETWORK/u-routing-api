import { DynamoCaching } from '../cache-dynamo';
import { log, metric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import { PoolMarshaller } from '../../../marshalling/pool-marshaller';
export class DynamoCachingV3Pool extends DynamoCaching {
    constructor({ tableName, ttlMinutes }) {
        super({ tableName, ttlMinutes });
    }
    async get(partitionKey, sortKey) {
        var _a, _b;
        if (sortKey) {
            const getParams = {
                TableName: this.tableName,
                Key: {
                    poolAddress: partitionKey,
                    blockNumber: sortKey,
                },
            };
            const cachedPoolBinary = (_b = (_a = (await this.ddbClient
                .get(getParams)
                .promise()
                .catch((error) => {
                log.error({ error, getParams }, `[DynamoCachingV3Pool] Cached pool failed to get`);
                return undefined;
            }))) === null || _a === void 0 ? void 0 : _a.Item) === null || _b === void 0 ? void 0 : _b.item;
            if (cachedPoolBinary) {
                metric.putMetric('V3_DYNAMO_CACHING_POOL_HIT_IN_TABLE', 1, MetricLoggerUnit.None);
                const cachedPoolBuffer = Buffer.from(cachedPoolBinary);
                const marshalledPool = JSON.parse(cachedPoolBuffer.toString());
                return PoolMarshaller.unmarshal(marshalledPool);
            }
            else {
                metric.putMetric('V3_DYNAMO_CACHING_POOL_MISS_NOT_IN_TABLE', 1, MetricLoggerUnit.None);
                return undefined;
            }
        }
        else {
            metric.putMetric('V3_DYNAMO_CACHING_POOL_MISS_NO_BLOCK_NUMBER', 1, MetricLoggerUnit.None);
            return undefined;
        }
    }
    async set(pool, partitionKey, sortKey) {
        if (sortKey) {
            const marshalledPool = PoolMarshaller.marshal(pool);
            const binaryCachedPool = Buffer.from(JSON.stringify(marshalledPool));
            // TTL is minutes from now. multiply ttlMinutes times 60 to convert to seconds, since ttl is in seconds.
            const ttl = Math.floor(Date.now() / 1000) + 60 * this.ttlMinutes;
            const putParams = {
                TableName: this.tableName,
                Item: {
                    poolAddress: partitionKey,
                    blockNumber: sortKey,
                    item: binaryCachedPool,
                    ttl: ttl,
                },
            };
            await this.ddbClient
                .put(putParams)
                .promise()
                .catch((error) => {
                log.error({ error, putParams }, `[DynamoCachingV3Pool] Cached pool failed to insert`);
                return false;
            });
            return true;
        }
        else {
            return false;
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FjaGUtZHluYW1vLXBvb2wuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9saWIvaGFuZGxlcnMvcG9vbHMvcG9vbC1jYWNoaW5nL3YzL2NhY2hlLWR5bmFtby1wb29sLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxhQUFhLEVBQXNCLE1BQU0saUJBQWlCLENBQUE7QUFFbkUsT0FBTyxFQUFFLEdBQUcsRUFBRSxNQUFNLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQTtBQUMzRSxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sc0NBQXNDLENBQUE7QUFJckUsTUFBTSxPQUFPLG1CQUFvQixTQUFRLGFBQW1DO0lBQzFFLFlBQVksRUFBRSxTQUFTLEVBQUUsVUFBVSxFQUE0QjtRQUM3RCxLQUFLLENBQUMsRUFBRSxTQUFTLEVBQUUsVUFBVSxFQUFFLENBQUMsQ0FBQTtJQUNsQyxDQUFDO0lBRVEsS0FBSyxDQUFDLEdBQUcsQ0FBQyxZQUFvQixFQUFFLE9BQWdCOztRQUN2RCxJQUFJLE9BQU8sRUFBRTtZQUNYLE1BQU0sU0FBUyxHQUFHO2dCQUNoQixTQUFTLEVBQUUsSUFBSSxDQUFDLFNBQVM7Z0JBQ3pCLEdBQUcsRUFBRTtvQkFDSCxXQUFXLEVBQUUsWUFBWTtvQkFDekIsV0FBVyxFQUFFLE9BQU87aUJBQ3JCO2FBQ0YsQ0FBQTtZQUVELE1BQU0sZ0JBQWdCLEdBQXVCLE1BQUEsTUFBQSxDQUMzQyxNQUFNLElBQUksQ0FBQyxTQUFTO2lCQUNqQixHQUFHLENBQUMsU0FBUyxDQUFDO2lCQUNkLE9BQU8sRUFBRTtpQkFDVCxLQUFLLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRTtnQkFDZixHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsS0FBSyxFQUFFLFNBQVMsRUFBRSxFQUFFLGlEQUFpRCxDQUFDLENBQUE7Z0JBQ2xGLE9BQU8sU0FBUyxDQUFBO1lBQ2xCLENBQUMsQ0FBQyxDQUNMLDBDQUFFLElBQUksMENBQUUsSUFBSSxDQUFBO1lBRWIsSUFBSSxnQkFBZ0IsRUFBRTtnQkFDcEIsTUFBTSxDQUFDLFNBQVMsQ0FBQyxxQ0FBcUMsRUFBRSxDQUFDLEVBQUUsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLENBQUE7Z0JBQ2pGLE1BQU0sZ0JBQWdCLEdBQVcsTUFBTSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFBO2dCQUM5RCxNQUFNLGNBQWMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLGdCQUFnQixDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUE7Z0JBQzlELE9BQU8sY0FBYyxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsQ0FBQTthQUNoRDtpQkFBTTtnQkFDTCxNQUFNLENBQUMsU0FBUyxDQUFDLDBDQUEwQyxFQUFFLENBQUMsRUFBRSxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsQ0FBQTtnQkFDdEYsT0FBTyxTQUFTLENBQUE7YUFDakI7U0FDRjthQUFNO1lBQ0wsTUFBTSxDQUFDLFNBQVMsQ0FBQyw2Q0FBNkMsRUFBRSxDQUFDLEVBQUUsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLENBQUE7WUFDekYsT0FBTyxTQUFTLENBQUE7U0FDakI7SUFDSCxDQUFDO0lBRVEsS0FBSyxDQUFDLEdBQUcsQ0FBQyxJQUFVLEVBQUUsWUFBb0IsRUFBRSxPQUFnQjtRQUNuRSxJQUFJLE9BQU8sRUFBRTtZQUNYLE1BQU0sY0FBYyxHQUFHLGNBQWMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUE7WUFDbkQsTUFBTSxnQkFBZ0IsR0FBVyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQTtZQUM1RSx3R0FBd0c7WUFDeEcsTUFBTSxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUE7WUFFaEUsTUFBTSxTQUFTLEdBQUc7Z0JBQ2hCLFNBQVMsRUFBRSxJQUFJLENBQUMsU0FBUztnQkFDekIsSUFBSSxFQUFFO29CQUNKLFdBQVcsRUFBRSxZQUFZO29CQUN6QixXQUFXLEVBQUUsT0FBTztvQkFDcEIsSUFBSSxFQUFFLGdCQUFnQjtvQkFDdEIsR0FBRyxFQUFFLEdBQUc7aUJBQ1Q7YUFDRixDQUFBO1lBRUQsTUFBTSxJQUFJLENBQUMsU0FBUztpQkFDakIsR0FBRyxDQUFDLFNBQVMsQ0FBQztpQkFDZCxPQUFPLEVBQUU7aUJBQ1QsS0FBSyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7Z0JBQ2YsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLEtBQUssRUFBRSxTQUFTLEVBQUUsRUFBRSxvREFBb0QsQ0FBQyxDQUFBO2dCQUNyRixPQUFPLEtBQUssQ0FBQTtZQUNkLENBQUMsQ0FBQyxDQUFBO1lBRUosT0FBTyxJQUFJLENBQUE7U0FDWjthQUFNO1lBQ0wsT0FBTyxLQUFLLENBQUE7U0FDYjtJQUNILENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER5bmFtb0NhY2hpbmcsIER5bmFtb0NhY2hpbmdQcm9wcyB9IGZyb20gJy4uL2NhY2hlLWR5bmFtbydcbmltcG9ydCB7IFBvb2wgfSBmcm9tICdAdW5pc3dhcC92My1zZGsnXG5pbXBvcnQgeyBsb2csIG1ldHJpYywgTWV0cmljTG9nZ2VyVW5pdCB9IGZyb20gJ0B1bmlzd2FwL3NtYXJ0LW9yZGVyLXJvdXRlcidcbmltcG9ydCB7IFBvb2xNYXJzaGFsbGVyIH0gZnJvbSAnLi4vLi4vLi4vbWFyc2hhbGxpbmcvcG9vbC1tYXJzaGFsbGVyJ1xuXG5pbnRlcmZhY2UgRHluYW1vQ2FjaGluZ1YzUG9vbFByb3BzIGV4dGVuZHMgRHluYW1vQ2FjaGluZ1Byb3BzIHt9XG5cbmV4cG9ydCBjbGFzcyBEeW5hbW9DYWNoaW5nVjNQb29sIGV4dGVuZHMgRHluYW1vQ2FjaGluZzxzdHJpbmcsIG51bWJlciwgUG9vbD4ge1xuICBjb25zdHJ1Y3Rvcih7IHRhYmxlTmFtZSwgdHRsTWludXRlcyB9OiBEeW5hbW9DYWNoaW5nVjNQb29sUHJvcHMpIHtcbiAgICBzdXBlcih7IHRhYmxlTmFtZSwgdHRsTWludXRlcyB9KVxuICB9XG5cbiAgb3ZlcnJpZGUgYXN5bmMgZ2V0KHBhcnRpdGlvbktleTogc3RyaW5nLCBzb3J0S2V5PzogbnVtYmVyKTogUHJvbWlzZTxQb29sIHwgdW5kZWZpbmVkPiB7XG4gICAgaWYgKHNvcnRLZXkpIHtcbiAgICAgIGNvbnN0IGdldFBhcmFtcyA9IHtcbiAgICAgICAgVGFibGVOYW1lOiB0aGlzLnRhYmxlTmFtZSxcbiAgICAgICAgS2V5OiB7XG4gICAgICAgICAgcG9vbEFkZHJlc3M6IHBhcnRpdGlvbktleSxcbiAgICAgICAgICBibG9ja051bWJlcjogc29ydEtleSxcbiAgICAgICAgfSxcbiAgICAgIH1cblxuICAgICAgY29uc3QgY2FjaGVkUG9vbEJpbmFyeTogQnVmZmVyIHwgdW5kZWZpbmVkID0gKFxuICAgICAgICBhd2FpdCB0aGlzLmRkYkNsaWVudFxuICAgICAgICAgIC5nZXQoZ2V0UGFyYW1zKVxuICAgICAgICAgIC5wcm9taXNlKClcbiAgICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICBsb2cuZXJyb3IoeyBlcnJvciwgZ2V0UGFyYW1zIH0sIGBbRHluYW1vQ2FjaGluZ1YzUG9vbF0gQ2FjaGVkIHBvb2wgZmFpbGVkIHRvIGdldGApXG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkXG4gICAgICAgICAgfSlcbiAgICAgICk/Lkl0ZW0/Lml0ZW1cblxuICAgICAgaWYgKGNhY2hlZFBvb2xCaW5hcnkpIHtcbiAgICAgICAgbWV0cmljLnB1dE1ldHJpYygnVjNfRFlOQU1PX0NBQ0hJTkdfUE9PTF9ISVRfSU5fVEFCTEUnLCAxLCBNZXRyaWNMb2dnZXJVbml0Lk5vbmUpXG4gICAgICAgIGNvbnN0IGNhY2hlZFBvb2xCdWZmZXI6IEJ1ZmZlciA9IEJ1ZmZlci5mcm9tKGNhY2hlZFBvb2xCaW5hcnkpXG4gICAgICAgIGNvbnN0IG1hcnNoYWxsZWRQb29sID0gSlNPTi5wYXJzZShjYWNoZWRQb29sQnVmZmVyLnRvU3RyaW5nKCkpXG4gICAgICAgIHJldHVybiBQb29sTWFyc2hhbGxlci51bm1hcnNoYWwobWFyc2hhbGxlZFBvb2wpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtZXRyaWMucHV0TWV0cmljKCdWM19EWU5BTU9fQ0FDSElOR19QT09MX01JU1NfTk9UX0lOX1RBQkxFJywgMSwgTWV0cmljTG9nZ2VyVW5pdC5Ob25lKVxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkXG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIG1ldHJpYy5wdXRNZXRyaWMoJ1YzX0RZTkFNT19DQUNISU5HX1BPT0xfTUlTU19OT19CTE9DS19OVU1CRVInLCAxLCBNZXRyaWNMb2dnZXJVbml0Lk5vbmUpXG4gICAgICByZXR1cm4gdW5kZWZpbmVkXG4gICAgfVxuICB9XG5cbiAgb3ZlcnJpZGUgYXN5bmMgc2V0KHBvb2w6IFBvb2wsIHBhcnRpdGlvbktleTogc3RyaW5nLCBzb3J0S2V5PzogbnVtYmVyKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgaWYgKHNvcnRLZXkpIHtcbiAgICAgIGNvbnN0IG1hcnNoYWxsZWRQb29sID0gUG9vbE1hcnNoYWxsZXIubWFyc2hhbChwb29sKVxuICAgICAgY29uc3QgYmluYXJ5Q2FjaGVkUG9vbDogQnVmZmVyID0gQnVmZmVyLmZyb20oSlNPTi5zdHJpbmdpZnkobWFyc2hhbGxlZFBvb2wpKVxuICAgICAgLy8gVFRMIGlzIG1pbnV0ZXMgZnJvbSBub3cuIG11bHRpcGx5IHR0bE1pbnV0ZXMgdGltZXMgNjAgdG8gY29udmVydCB0byBzZWNvbmRzLCBzaW5jZSB0dGwgaXMgaW4gc2Vjb25kcy5cbiAgICAgIGNvbnN0IHR0bCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApICsgNjAgKiB0aGlzLnR0bE1pbnV0ZXNcblxuICAgICAgY29uc3QgcHV0UGFyYW1zID0ge1xuICAgICAgICBUYWJsZU5hbWU6IHRoaXMudGFibGVOYW1lLFxuICAgICAgICBJdGVtOiB7XG4gICAgICAgICAgcG9vbEFkZHJlc3M6IHBhcnRpdGlvbktleSxcbiAgICAgICAgICBibG9ja051bWJlcjogc29ydEtleSxcbiAgICAgICAgICBpdGVtOiBiaW5hcnlDYWNoZWRQb29sLFxuICAgICAgICAgIHR0bDogdHRsLFxuICAgICAgICB9LFxuICAgICAgfVxuXG4gICAgICBhd2FpdCB0aGlzLmRkYkNsaWVudFxuICAgICAgICAucHV0KHB1dFBhcmFtcylcbiAgICAgICAgLnByb21pc2UoKVxuICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgbG9nLmVycm9yKHsgZXJyb3IsIHB1dFBhcmFtcyB9LCBgW0R5bmFtb0NhY2hpbmdWM1Bvb2xdIENhY2hlZCBwb29sIGZhaWxlZCB0byBpbnNlcnRgKVxuICAgICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgICB9KVxuXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gZmFsc2VcbiAgICB9XG4gIH1cbn1cbiJdfQ==