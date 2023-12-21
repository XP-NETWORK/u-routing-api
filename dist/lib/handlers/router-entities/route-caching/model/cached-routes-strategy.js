import { CurrencyAmount, TradeType } from '@uniswap/sdk-core';
import { CacheMode } from '@uniswap/smart-order-router';
/**
 * Models out the strategy for categorizing cached routes into buckets by amount traded
 */
export class CachedRoutesStrategy {
    /**
     * @param pair
     * @param tradeType
     * @param chainId
     * @param buckets
     */
    constructor({ pair, tradeType, chainId, buckets }) {
        this.pair = pair;
        this._tradeType = tradeType;
        this.chainId = chainId;
        // Used for deciding to show metrics in the dashboard related to Tapcompare
        this.willTapcompare = buckets.find((bucket) => bucket.cacheMode == CacheMode.Tapcompare) != undefined;
        // It is important that we sort the buckets in ascendant order for the algorithm to work correctly.
        // For a strange reason the `.sort()` function was comparing the number as strings, so I had to pass a compareFn.
        this.buckets = buckets.map((params) => params.bucket).sort((a, b) => a - b);
        // Create a Map<bucket, CachedRoutesBucket> for easy lookup once we find a bucket.
        this.bucketsMap = new Map(buckets.map((params) => [params.bucket, params]));
    }
    get tradeType() {
        return this._tradeType == TradeType.EXACT_INPUT ? 'ExactIn' : 'ExactOut';
    }
    readablePairTradeTypeChainId() {
        return `${this.pair.toUpperCase()}/${this.tradeType}/${this.chainId}`;
    }
    bucketPairs() {
        if (this.buckets.length > 0) {
            const firstBucket = [[0, this.buckets[0]]];
            const middleBuckets = this.buckets.length > 1
                ? this.buckets.slice(0, -1).map((bucket, i) => [bucket, this.buckets[i + 1]])
                : [];
            const lastBucket = [[this.buckets.slice(-1)[0], -1]];
            return firstBucket.concat(middleBuckets).concat(lastBucket);
        }
        else {
            return [];
        }
    }
    /**
     * Given an amount, we will search the bucket that has a cached route for that amount based on the CachedRoutesBucket array
     * @param amount
     */
    getCachingBucket(amount) {
        // Find the first bucket which is greater or equal than the amount.
        // If no bucket is found it means it's not supposed to be cached.
        // e.g. let buckets = [10, 50, 100, 500, 1000]
        // e.g.1. if amount = 0.10, then bucket = 10
        // e.g.2. if amount = 501, then bucket = 1000
        // e.g.3. If amount = 1001 then bucket = undefined
        const bucket = this.buckets.find((bucket) => {
            // Create a CurrencyAmount object to compare the amount with the bucket.
            const bucketCurrency = CurrencyAmount.fromRawAmount(amount.currency, bucket * 10 ** amount.currency.decimals);
            // Given that the array of buckets is sorted, we want to find the first bucket that makes the amount lessThanOrEqual to the bucket
            // refer to the examples above
            return amount.lessThan(bucketCurrency) || amount.equalTo(bucketCurrency);
        });
        if (bucket) {
            // if a bucket was found, return the CachedRoutesBucket associated to that bucket.
            return this.bucketsMap.get(bucket);
        }
        return undefined;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FjaGVkLXJvdXRlcy1zdHJhdGVneS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uLy4uL2xpYi9oYW5kbGVycy9yb3V0ZXItZW50aXRpZXMvcm91dGUtY2FjaGluZy9tb2RlbC9jYWNoZWQtcm91dGVzLXN0cmF0ZWd5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBcUIsY0FBYyxFQUFFLFNBQVMsRUFBRSxNQUFNLG1CQUFtQixDQUFBO0FBRWhGLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQTtBQVN2RDs7R0FFRztBQUNILE1BQU0sT0FBTyxvQkFBb0I7SUFRL0I7Ozs7O09BS0c7SUFDSCxZQUFZLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUE0QjtRQUN6RSxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQTtRQUNoQixJQUFJLENBQUMsVUFBVSxHQUFHLFNBQVMsQ0FBQTtRQUMzQixJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQTtRQUV0QiwyRUFBMkU7UUFDM0UsSUFBSSxDQUFDLGNBQWMsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsU0FBUyxJQUFJLFNBQVMsQ0FBQyxVQUFVLENBQUMsSUFBSSxTQUFTLENBQUE7UUFFckcsbUdBQW1HO1FBQ25HLGlIQUFpSDtRQUNqSCxJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUE7UUFFM0Usa0ZBQWtGO1FBQ2xGLElBQUksQ0FBQyxVQUFVLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQTtJQUM3RSxDQUFDO0lBRUQsSUFBVyxTQUFTO1FBQ2xCLE9BQU8sSUFBSSxDQUFDLFVBQVUsSUFBSSxTQUFTLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQTtJQUMxRSxDQUFDO0lBRU0sNEJBQTRCO1FBQ2pDLE9BQU8sR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxJQUFJLElBQUksQ0FBQyxTQUFTLElBQUksSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFBO0lBQ3ZFLENBQUM7SUFFTSxXQUFXO1FBQ2hCLElBQUksSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFO1lBQzNCLE1BQU0sV0FBVyxHQUF1QixDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBO1lBQzlELE1BQU0sYUFBYSxHQUNqQixJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sR0FBRyxDQUFDO2dCQUNyQixDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBb0IsRUFBRSxDQUFDLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBRSxDQUFDLENBQUM7Z0JBQ2hHLENBQUMsQ0FBQyxFQUFFLENBQUE7WUFDUixNQUFNLFVBQVUsR0FBdUIsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBO1lBRXhFLE9BQU8sV0FBVyxDQUFDLE1BQU0sQ0FBQyxhQUFhLENBQUMsQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDLENBQUE7U0FDNUQ7YUFBTTtZQUNMLE9BQU8sRUFBRSxDQUFBO1NBQ1Y7SUFDSCxDQUFDO0lBRUQ7OztPQUdHO0lBQ0ksZ0JBQWdCLENBQUMsTUFBZ0M7UUFDdEQsbUVBQW1FO1FBQ25FLGlFQUFpRTtRQUNqRSw4Q0FBOEM7UUFDOUMsNENBQTRDO1FBQzVDLDZDQUE2QztRQUM3QyxrREFBa0Q7UUFDbEQsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFjLEVBQUUsRUFBRTtZQUNsRCx3RUFBd0U7WUFDeEUsTUFBTSxjQUFjLEdBQUcsY0FBYyxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsUUFBUSxFQUFFLE1BQU0sR0FBRyxFQUFFLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsQ0FBQTtZQUU3RyxrSUFBa0k7WUFDbEksOEJBQThCO1lBQzlCLE9BQU8sTUFBTSxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLGNBQWMsQ0FBQyxDQUFBO1FBQzFFLENBQUMsQ0FBQyxDQUFBO1FBRUYsSUFBSSxNQUFNLEVBQUU7WUFDVixrRkFBa0Y7WUFDbEYsT0FBTyxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQTtTQUNuQztRQUVELE9BQU8sU0FBUyxDQUFBO0lBQ2xCLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENoYWluSWQsIEN1cnJlbmN5LCBDdXJyZW5jeUFtb3VudCwgVHJhZGVUeXBlIH0gZnJvbSAnQHVuaXN3YXAvc2RrLWNvcmUnXG5pbXBvcnQgeyBDYWNoZWRSb3V0ZXNCdWNrZXQgfSBmcm9tICcuL2NhY2hlZC1yb3V0ZXMtYnVja2V0J1xuaW1wb3J0IHsgQ2FjaGVNb2RlIH0gZnJvbSAnQHVuaXN3YXAvc21hcnQtb3JkZXItcm91dGVyJ1xuXG5pbnRlcmZhY2UgQ2FjaGVkUm91dGVzU3RyYXRlZ3lBcmdzIHtcbiAgcGFpcjogc3RyaW5nXG4gIHRyYWRlVHlwZTogVHJhZGVUeXBlXG4gIGNoYWluSWQ6IENoYWluSWRcbiAgYnVja2V0czogQ2FjaGVkUm91dGVzQnVja2V0W11cbn1cblxuLyoqXG4gKiBNb2RlbHMgb3V0IHRoZSBzdHJhdGVneSBmb3IgY2F0ZWdvcml6aW5nIGNhY2hlZCByb3V0ZXMgaW50byBidWNrZXRzIGJ5IGFtb3VudCB0cmFkZWRcbiAqL1xuZXhwb3J0IGNsYXNzIENhY2hlZFJvdXRlc1N0cmF0ZWd5IHtcbiAgcmVhZG9ubHkgcGFpcjogc3RyaW5nXG4gIHJlYWRvbmx5IF90cmFkZVR5cGU6IFRyYWRlVHlwZVxuICByZWFkb25seSBjaGFpbklkOiBDaGFpbklkXG4gIHJlYWRvbmx5IHdpbGxUYXBjb21wYXJlOiBib29sZWFuXG4gIHByaXZhdGUgYnVja2V0czogbnVtYmVyW11cbiAgcHJpdmF0ZSBidWNrZXRzTWFwOiBNYXA8bnVtYmVyLCBDYWNoZWRSb3V0ZXNCdWNrZXQ+XG5cbiAgLyoqXG4gICAqIEBwYXJhbSBwYWlyXG4gICAqIEBwYXJhbSB0cmFkZVR5cGVcbiAgICogQHBhcmFtIGNoYWluSWRcbiAgICogQHBhcmFtIGJ1Y2tldHNcbiAgICovXG4gIGNvbnN0cnVjdG9yKHsgcGFpciwgdHJhZGVUeXBlLCBjaGFpbklkLCBidWNrZXRzIH06IENhY2hlZFJvdXRlc1N0cmF0ZWd5QXJncykge1xuICAgIHRoaXMucGFpciA9IHBhaXJcbiAgICB0aGlzLl90cmFkZVR5cGUgPSB0cmFkZVR5cGVcbiAgICB0aGlzLmNoYWluSWQgPSBjaGFpbklkXG5cbiAgICAvLyBVc2VkIGZvciBkZWNpZGluZyB0byBzaG93IG1ldHJpY3MgaW4gdGhlIGRhc2hib2FyZCByZWxhdGVkIHRvIFRhcGNvbXBhcmVcbiAgICB0aGlzLndpbGxUYXBjb21wYXJlID0gYnVja2V0cy5maW5kKChidWNrZXQpID0+IGJ1Y2tldC5jYWNoZU1vZGUgPT0gQ2FjaGVNb2RlLlRhcGNvbXBhcmUpICE9IHVuZGVmaW5lZFxuXG4gICAgLy8gSXQgaXMgaW1wb3J0YW50IHRoYXQgd2Ugc29ydCB0aGUgYnVja2V0cyBpbiBhc2NlbmRhbnQgb3JkZXIgZm9yIHRoZSBhbGdvcml0aG0gdG8gd29yayBjb3JyZWN0bHkuXG4gICAgLy8gRm9yIGEgc3RyYW5nZSByZWFzb24gdGhlIGAuc29ydCgpYCBmdW5jdGlvbiB3YXMgY29tcGFyaW5nIHRoZSBudW1iZXIgYXMgc3RyaW5ncywgc28gSSBoYWQgdG8gcGFzcyBhIGNvbXBhcmVGbi5cbiAgICB0aGlzLmJ1Y2tldHMgPSBidWNrZXRzLm1hcCgocGFyYW1zKSA9PiBwYXJhbXMuYnVja2V0KS5zb3J0KChhLCBiKSA9PiBhIC0gYilcblxuICAgIC8vIENyZWF0ZSBhIE1hcDxidWNrZXQsIENhY2hlZFJvdXRlc0J1Y2tldD4gZm9yIGVhc3kgbG9va3VwIG9uY2Ugd2UgZmluZCBhIGJ1Y2tldC5cbiAgICB0aGlzLmJ1Y2tldHNNYXAgPSBuZXcgTWFwKGJ1Y2tldHMubWFwKChwYXJhbXMpID0+IFtwYXJhbXMuYnVja2V0LCBwYXJhbXNdKSlcbiAgfVxuXG4gIHB1YmxpYyBnZXQgdHJhZGVUeXBlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHRoaXMuX3RyYWRlVHlwZSA9PSBUcmFkZVR5cGUuRVhBQ1RfSU5QVVQgPyAnRXhhY3RJbicgOiAnRXhhY3RPdXQnXG4gIH1cblxuICBwdWJsaWMgcmVhZGFibGVQYWlyVHJhZGVUeXBlQ2hhaW5JZCgpOiBzdHJpbmcge1xuICAgIHJldHVybiBgJHt0aGlzLnBhaXIudG9VcHBlckNhc2UoKX0vJHt0aGlzLnRyYWRlVHlwZX0vJHt0aGlzLmNoYWluSWR9YFxuICB9XG5cbiAgcHVibGljIGJ1Y2tldFBhaXJzKCk6IFtudW1iZXIsIG51bWJlcl1bXSB7XG4gICAgaWYgKHRoaXMuYnVja2V0cy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBmaXJzdEJ1Y2tldDogW251bWJlciwgbnVtYmVyXVtdID0gW1swLCB0aGlzLmJ1Y2tldHNbMF1dXVxuICAgICAgY29uc3QgbWlkZGxlQnVja2V0czogW251bWJlciwgbnVtYmVyXVtdID1cbiAgICAgICAgdGhpcy5idWNrZXRzLmxlbmd0aCA+IDFcbiAgICAgICAgICA/IHRoaXMuYnVja2V0cy5zbGljZSgwLCAtMSkubWFwKChidWNrZXQsIGkpOiBbbnVtYmVyLCBudW1iZXJdID0+IFtidWNrZXQsIHRoaXMuYnVja2V0c1tpICsgMV0hXSlcbiAgICAgICAgICA6IFtdXG4gICAgICBjb25zdCBsYXN0QnVja2V0OiBbbnVtYmVyLCBudW1iZXJdW10gPSBbW3RoaXMuYnVja2V0cy5zbGljZSgtMSlbMF0sIC0xXV1cblxuICAgICAgcmV0dXJuIGZpcnN0QnVja2V0LmNvbmNhdChtaWRkbGVCdWNrZXRzKS5jb25jYXQobGFzdEJ1Y2tldClcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIFtdXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEdpdmVuIGFuIGFtb3VudCwgd2Ugd2lsbCBzZWFyY2ggdGhlIGJ1Y2tldCB0aGF0IGhhcyBhIGNhY2hlZCByb3V0ZSBmb3IgdGhhdCBhbW91bnQgYmFzZWQgb24gdGhlIENhY2hlZFJvdXRlc0J1Y2tldCBhcnJheVxuICAgKiBAcGFyYW0gYW1vdW50XG4gICAqL1xuICBwdWJsaWMgZ2V0Q2FjaGluZ0J1Y2tldChhbW91bnQ6IEN1cnJlbmN5QW1vdW50PEN1cnJlbmN5Pik6IENhY2hlZFJvdXRlc0J1Y2tldCB8IHVuZGVmaW5lZCB7XG4gICAgLy8gRmluZCB0aGUgZmlyc3QgYnVja2V0IHdoaWNoIGlzIGdyZWF0ZXIgb3IgZXF1YWwgdGhhbiB0aGUgYW1vdW50LlxuICAgIC8vIElmIG5vIGJ1Y2tldCBpcyBmb3VuZCBpdCBtZWFucyBpdCdzIG5vdCBzdXBwb3NlZCB0byBiZSBjYWNoZWQuXG4gICAgLy8gZS5nLiBsZXQgYnVja2V0cyA9IFsxMCwgNTAsIDEwMCwgNTAwLCAxMDAwXVxuICAgIC8vIGUuZy4xLiBpZiBhbW91bnQgPSAwLjEwLCB0aGVuIGJ1Y2tldCA9IDEwXG4gICAgLy8gZS5nLjIuIGlmIGFtb3VudCA9IDUwMSwgdGhlbiBidWNrZXQgPSAxMDAwXG4gICAgLy8gZS5nLjMuIElmIGFtb3VudCA9IDEwMDEgdGhlbiBidWNrZXQgPSB1bmRlZmluZWRcbiAgICBjb25zdCBidWNrZXQgPSB0aGlzLmJ1Y2tldHMuZmluZCgoYnVja2V0OiBudW1iZXIpID0+IHtcbiAgICAgIC8vIENyZWF0ZSBhIEN1cnJlbmN5QW1vdW50IG9iamVjdCB0byBjb21wYXJlIHRoZSBhbW91bnQgd2l0aCB0aGUgYnVja2V0LlxuICAgICAgY29uc3QgYnVja2V0Q3VycmVuY3kgPSBDdXJyZW5jeUFtb3VudC5mcm9tUmF3QW1vdW50KGFtb3VudC5jdXJyZW5jeSwgYnVja2V0ICogMTAgKiogYW1vdW50LmN1cnJlbmN5LmRlY2ltYWxzKVxuXG4gICAgICAvLyBHaXZlbiB0aGF0IHRoZSBhcnJheSBvZiBidWNrZXRzIGlzIHNvcnRlZCwgd2Ugd2FudCB0byBmaW5kIHRoZSBmaXJzdCBidWNrZXQgdGhhdCBtYWtlcyB0aGUgYW1vdW50IGxlc3NUaGFuT3JFcXVhbCB0byB0aGUgYnVja2V0XG4gICAgICAvLyByZWZlciB0byB0aGUgZXhhbXBsZXMgYWJvdmVcbiAgICAgIHJldHVybiBhbW91bnQubGVzc1RoYW4oYnVja2V0Q3VycmVuY3kpIHx8IGFtb3VudC5lcXVhbFRvKGJ1Y2tldEN1cnJlbmN5KVxuICAgIH0pXG5cbiAgICBpZiAoYnVja2V0KSB7XG4gICAgICAvLyBpZiBhIGJ1Y2tldCB3YXMgZm91bmQsIHJldHVybiB0aGUgQ2FjaGVkUm91dGVzQnVja2V0IGFzc29jaWF0ZWQgdG8gdGhhdCBidWNrZXQuXG4gICAgICByZXR1cm4gdGhpcy5idWNrZXRzTWFwLmdldChidWNrZXQpXG4gICAgfVxuXG4gICAgcmV0dXJuIHVuZGVmaW5lZFxuICB9XG59XG4iXX0=