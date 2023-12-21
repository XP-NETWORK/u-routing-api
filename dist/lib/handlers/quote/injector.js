import { AlphaRouter, ID_TO_CHAIN_ID, setGlobalLogger, setGlobalMetric, V3HeuristicGasModelFactory, } from '@uniswap/smart-order-router';
import { default as bunyan } from 'bunyan';
import { BigNumber } from 'ethers';
import { InjectorSOR } from '../injector-sor';
import { AWSMetricsLogger } from '../router-entities/aws-metrics-logger';
import { StaticGasPriceProvider } from '../router-entities/static-gas-price-provider';
export class QuoteHandlerInjector extends InjectorSOR {
    async getRequestInjected(containerInjected, _requestBody, requestQueryParams, _event, context, log, metricsLogger) {
        const requestId = context.awsRequestId;
        const quoteId = requestId.substring(0, 5);
        // Sample 10% of all requests at the INFO log level for debugging purposes.
        // All other requests will only log warnings and errors.
        // Note that we use WARN as a default rather than ERROR
        // to capture Tapcompare logs in the smart-order-router.
        const logLevel = Math.random() < 0.1 ? bunyan.INFO : bunyan.WARN;
        const { tokenInAddress, tokenInChainId, tokenOutAddress, amount, type, algorithm, gasPriceWei, quoteSpeed, intent, } = requestQueryParams;
        log = log.child({
            serializers: bunyan.stdSerializers,
            level: logLevel,
            requestId,
            quoteId,
            tokenInAddress,
            chainId: tokenInChainId,
            tokenOutAddress,
            amount,
            type,
            algorithm,
        });
        setGlobalLogger(log);
        metricsLogger.setNamespace('Uniswap');
        metricsLogger.setDimensions({ Service: 'RoutingAPI' });
        const metric = new AWSMetricsLogger(metricsLogger);
        setGlobalMetric(metric);
        // Today API is restricted such that both tokens must be on the same chain.
        const chainId = tokenInChainId;
        const chainIdEnum = ID_TO_CHAIN_ID(chainId);
        const { dependencies } = containerInjected;
        if (!dependencies[chainIdEnum]) {
            // Request validation should prevent reject unsupported chains with 4xx already, so this should not be possible.
            throw new Error(`No container injected dependencies for chain: ${chainIdEnum}`);
        }
        const { provider, v3PoolProvider, multicallProvider, tokenProvider, tokenListProvider, v3SubgraphProvider, blockedTokenListProvider, v2PoolProvider, tokenValidatorProvider, tokenPropertiesProvider, v2QuoteProvider, v2SubgraphProvider, gasPriceProvider: gasPriceProviderOnChain, simulator, routeCachingProvider, } = dependencies[chainIdEnum];
        let onChainQuoteProvider = dependencies[chainIdEnum].onChainQuoteProvider;
        let gasPriceProvider = gasPriceProviderOnChain;
        if (gasPriceWei) {
            const gasPriceWeiBN = BigNumber.from(gasPriceWei);
            gasPriceProvider = new StaticGasPriceProvider(gasPriceWeiBN);
        }
        let router;
        switch (algorithm) {
            case 'alpha':
            default:
                router = new AlphaRouter({
                    chainId,
                    provider,
                    v3SubgraphProvider,
                    multicall2Provider: multicallProvider,
                    v3PoolProvider,
                    onChainQuoteProvider,
                    gasPriceProvider,
                    v3GasModelFactory: new V3HeuristicGasModelFactory(),
                    blockedTokenListProvider,
                    tokenProvider,
                    v2PoolProvider,
                    v2QuoteProvider,
                    v2SubgraphProvider,
                    simulator,
                    routeCachingProvider,
                    tokenValidatorProvider,
                    tokenPropertiesProvider,
                });
                break;
        }
        return {
            chainId: chainIdEnum,
            id: quoteId,
            log,
            metric,
            router,
            v3PoolProvider,
            v2PoolProvider,
            tokenProvider,
            tokenListProvider,
            quoteSpeed,
            intent,
        };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5qZWN0b3IuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9saWIvaGFuZGxlcnMvcXVvdGUvaW5qZWN0b3IudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUNMLFdBQVcsRUFFWCxjQUFjLEVBR2QsZUFBZSxFQUNmLGVBQWUsRUFDZiwwQkFBMEIsR0FDM0IsTUFBTSw2QkFBNkIsQ0FBQTtBQUdwQyxPQUFPLEVBQUUsT0FBTyxJQUFJLE1BQU0sRUFBcUIsTUFBTSxRQUFRLENBQUE7QUFDN0QsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLFFBQVEsQ0FBQTtBQUNsQyxPQUFPLEVBQXFCLFdBQVcsRUFBbUIsTUFBTSxpQkFBaUIsQ0FBQTtBQUNqRixPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSx1Q0FBdUMsQ0FBQTtBQUN4RSxPQUFPLEVBQUUsc0JBQXNCLEVBQUUsTUFBTSw4Q0FBOEMsQ0FBQTtBQUVyRixNQUFNLE9BQU8sb0JBQXFCLFNBQVEsV0FHekM7SUFDUSxLQUFLLENBQUMsa0JBQWtCLENBQzdCLGlCQUFvQyxFQUNwQyxZQUFrQixFQUNsQixrQkFBb0MsRUFDcEMsTUFBNEIsRUFDNUIsT0FBZ0IsRUFDaEIsR0FBVyxFQUNYLGFBQTRCO1FBRTVCLE1BQU0sU0FBUyxHQUFHLE9BQU8sQ0FBQyxZQUFZLENBQUE7UUFDdEMsTUFBTSxPQUFPLEdBQUcsU0FBUyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUE7UUFDekMsMkVBQTJFO1FBQzNFLHdEQUF3RDtRQUN4RCx1REFBdUQ7UUFDdkQsd0RBQXdEO1FBQ3hELE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUE7UUFFaEUsTUFBTSxFQUNKLGNBQWMsRUFDZCxjQUFjLEVBQ2QsZUFBZSxF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Um91dGVyQ29uZmlnLFxuICBJRF9UT19DSEFJTl9JRCxcbiAgSVJvdXRlcixcbiAgTGVnYWN5Um91dGluZ0NvbmZpZyxcbiAgc2V0R2xvYmFsTG9nZ2VyLFxuICBzZXRHbG9iYWxNZXRyaWMsXG4gIFYzSGV1cmlzdGljR2FzTW9kZWxGYWN0b3J5LFxufSBmcm9tICdAdW5pc3dhcC9zbWFydC1vcmRlci1yb3V0ZXInXG5pbXBvcnQgeyBNZXRyaWNzTG9nZ2VyIH0gZnJvbSAnYXdzLWVtYmVkZGVkLW1ldHJpY3MnXG5pbXBvcnQgeyBBUElHYXRld2F5UHJveHlFdmVudCwgQ29udGV4dCB9IGZyb20gJ2F3cy1sYW1iZGEnXG5pbXBvcnQgeyBkZWZhdWx0IGFzIGJ1bnlhbiwgZGVmYXVsdCBhcyBMb2dnZXIgfSBmcm9tICdidW55YW4nXG5pbXBvcnQgeyBCaWdOdW1iZXIgfSBmcm9tICdldGhlcnMnXG5pbXBvcnQgeyBDb250YWluZXJJbmplY3RlZCwgSW5qZWN0b3JTT1IsIFJlcXVlc3RJbmplY3RlZCB9IGZyb20gJy4uL2luamVjdG9yLXNvcidcbmltcG9ydCB7IEFXU01ldHJpY3NMb2dnZXIgfSBmcm9tICcuLi9yb3V0ZXItZW50aXRpZXMvYXdzLW1ldHJpY3MtbG9nZ2VyJ1xuaW1wb3J0IHsgU3RhdGljR2FzUHJpY2VQcm92aWRlciB9IGZyb20gJy4uL3JvdXRlci1lbnRpdGllcy9zdGF0aWMtZ2FzLXByaWNlLXByb3ZpZGVyJ1xuaW1wb3J0IHsgUXVvdGVRdWVyeVBhcmFtcyB9IGZyb20gJy4vc2NoZW1hL3F1b3RlLXNjaGVtYSdcbmV4cG9ydCBjbGFzcyBRdW90ZUhhbmRsZXJJbmplY3RvciBleHRlbmRzIEluamVjdG9yU09SPFxuICBJUm91dGVyPEFscGhhUm91dGVyQ29uZmlnIHwgTGVnYWN5Um91dGluZ0NvbmZpZz4sXG4gIFF1b3RlUXVlcnlQYXJhbXNcbj4ge1xuICBwdWJsaWMgYXN5bmMgZ2V0UmVxdWVzdEluamVjdGVkKFxuICAgIGNvbnRhaW5lckluamVjdGVkOiBDb250YWluZXJJbmplY3RlZCxcbiAgICBfcmVxdWVzdEJvZHk6IHZvaWQsXG4gICAgcmVxdWVzdFF1ZXJ5UGFyYW1zOiBRdW90ZVF1ZXJ5UGFyYW1zLFxuICAgIF9ldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnQsXG4gICAgY29udGV4dDogQ29udGV4dCxcbiAgICBsb2c6IExvZ2dlcixcbiAgICBtZXRyaWNzTG9nZ2VyOiBNZXRyaWNzTG9nZ2VyXG4gICk6IFByb21pc2U8UmVxdWVzdEluamVjdGVkPElSb3V0ZXI8QWxwaGFSb3V0ZXJDb25maWcgfCBMZWdhY3lSb3V0aW5nQ29uZmlnPj4+IHtcbiAgICBjb25zdCByZXF1ZXN0SWQgPSBjb250ZXh0LmF3c1JlcXVlc3RJZFxuICAgIGNvbnN0IHF1b3RlSWQgPSByZXF1ZXN0SWQuc3Vic3RyaW5nKDAsIDUpXG4gICAgLy8gU2FtcGxlIDEwJSBvZiBhbGwgcmVxdWVzdHMgYXQgdGhlIElORk8gbG9nIGxldmVsIGZvciBkZWJ1Z2dpbmcgcHVycG9zZXMuXG4gICAgLy8gQWxsIG90aGVyIHJlcXVlc3RzIHdpbGwgb25seSBsb2cgd2FybmluZ3MgYW5kIGVycm9ycy5cbiAgICAvLyBOb3RlIHRoYXQgd2UgdXNlIFdBUk4gYXMgYSBkZWZhdWx0IHJhdGhlciB0aGFuIEVSUk9SXG4gICAgLy8gdG8gY2FwdHVyZSBUYXBjb21wYXJlIGxvZ3MgaW4gdGhlIHNtYXJ0LW9yZGVyLXJvdXRlci5cbiAgICBjb25zdCBsb2dMZXZlbCA9IE1hdGgucmFuZG9tKCkgPCAwLjEgPyBidW55YW4uSU5GTyA6IGJ1bnlhbi5XQVJOXG5cbiAgICBjb25zdCB7XG4gICAgICB0b2tlbkluQWRkcmVzcyxcbiAgICAgIHRva2VuSW5DaGFpbklkLFxuICAgICAgdG9rZW5PdXRBZGRyZXNzLFxuICAgICAgYW1vdW50LFxuICAgICAgdHlwZSxcbiAgICAgIGFsZ29yaXRobSxcbiAgICAgIGdhc1ByaWNlV2VpLFxuICAgICAgcXVvdGVTcGVlZCxcbiAgICAgIGludGVudCxcbiAgICB9ID0gcmVxdWVzdFF1ZXJ5UGFyYW1zXG5cbiAgICBsb2cgPSBsb2cuY2hpbGQoe1xuICAgICAgc2VyaWFsaXplcnM6IGJ1bnlhbi5zdGRTZXJpYWxpemVycyxcbiAgICAgIGxldmVsOiBsb2dMZXZlbCxcbiAgICAgIHJlcXVlc3RJZCxcbiAgICAgIHF1b3RlSWQsXG4gICAgICB0b2tlbkluQWRkcmVzcyxcbiAgICAgIGNoYWluSWQ6IHRva2VuSW5DaGFpbklkLFxuICAgICAgdG9rZW5PdXRBZGRyZXNzLFxuICAgICAgYW1vdW50LFxuICAgICAgdHlwZSxcbiAgICAgIGFsZ29yaXRobSxcbiAgICB9KVxuICAgIHNldEdsb2JhbExvZ2dlcihsb2cpXG5cbiAgICBtZXRyaWNzTG9nZ2VyLnNldE5hbWVzcGFjZSgnVW5pc3dhcCcpXG4gICAgbWV0cmljc0xvZ2dlci5zZXREaW1lbnNpb25zKHsgU2VydmljZTogJ1JvdXRpbmdBUEknIH0pXG4gICAgY29uc3QgbWV0cmljID0gbmV3IEFXU01ldHJpY3NMb2dnZXIobWV0cmljc0xvZ2dlcilcbiAgICBzZXRHbG9iYWxNZXRyaWMobWV0cmljKVxuXG4gICAgLy8gVG9kYXkgQVBJIGlzIHJlc3RyaWN0ZWQgc3VjaCB0aGF0IGJvdGggdG9rZW5zIG11c3QgYmUgb24gdGhlIHNhbWUgY2hhaW4uXG4gICAgY29uc3QgY2hhaW5JZCA9IHRva2VuSW5DaGFpbklkXG4gICAgY29uc3QgY2hhaW5JZEVudW0gPSBJRF9UT19DSEFJTl9JRChjaGFpbklkKVxuXG4gICAgY29uc3QgeyBkZXBlbmRlbmNpZXMgfSA9IGNvbnRhaW5lckluamVjdGVkXG5cbiAgICBpZiAoIWRlcGVuZGVuY2llc1tjaGFpbklkRW51bV0pIHtcbiAgICAgIC8vIFJlcXVlc3QgdmFsaWRhdGlvbiBzaG91bGQgcHJldmVudCByZWplY3QgdW5zdXBwb3J0ZWQgY2hhaW5zIHdpdGggNHh4IGFscmVhZHksIHNvIHRoaXMgc2hvdWxkIG5vdCBiZSBwb3NzaWJsZS5cbiAgICAgIHRocm93IG5ldyBFcnJvcihgTm8gY29udGFpbmVyIGluamVjdGVkIGRlcGVuZGVuY2llcyBmb3IgY2hhaW46ICR7Y2hhaW5JZEVudW19YClcbiAgICB9XG5cbiAgICBjb25zdCB7XG4gICAgICBwcm92aWRlcixcbiAgICAgIHYzUG9vbFByb3ZpZGVyLFxuICAgICAgbXVsdGljYWxsUHJvdmlkZXIsXG4gICAgICB0b2tlblByb3ZpZGVyLFxuICAgICAgdG9rZW5MaXN0UHJvdmlkZXIsXG4gICAgICB2M1N1YmdyYXBoUHJvdmlkZXIsXG4gICAgICBibG9ja2VkVG9rZW5MaXN0UHJvdmlkZXIsXG4gICAgICB2MlBvb2xQcm92aWRlcixcbiAgICAgIHRva2VuVmFsaWRhdG9yUHJvdmlkZXIsXG4gICAgICB0b2tlblByb3BlcnRpZXNQcm92aWRlcixcbiAgICAgIHYyUXVvdGVQcm92aWRlcixcbiAgICAgIHYyU3ViZ3JhcGhQcm92aWRlcixcbiAgICAgIGdhc1ByaWNlUHJvdmlkZXI6IGdhc1ByaWNlUHJvdmlkZXJPbkNoYWluLFxuICAgICAgc2ltdWxhdG9yLFxuICAgICAgcm91dGVDYWNoaW5nUHJvdmlkZXIsXG4gICAgfSA9IGRlcGVuZGVuY2llc1tjaGFpbklkRW51bV0hXG5cbiAgICBsZXQgb25DaGFpblF1b3RlUHJvdmlkZXIgPSBkZXBlbmRlbmNpZXNbY2hhaW5JZEVudW1dIS5vbkNoYWluUXVvdGVQcm92aWRlclxuICAgIGxldCBnYXNQcmljZVByb3ZpZGVyID0gZ2FzUHJpY2VQcm92aWRlck9uQ2hhaW5cbiAgICBpZiAoZ2FzUHJpY2VXZWkpIHtcbiAgICAgIGNvbnN0IGdhc1ByaWNlV2VpQk4gPSBCaWdOdW1iZXIuZnJvbShnYXNQcmljZVdlaSlcbiAgICAgIGdhc1ByaWNlUHJvdmlkZXIgPSBuZXcgU3RhdGljR2FzUHJpY2VQcm92aWRlcihnYXNQcmljZVdlaUJOKVxuICAgIH1cblxuICAgIGxldCByb3V0ZXJcbiAgICBzd2l0Y2ggKGFsZ29yaXRobSkge1xuICAgICAgY2FzZSAnYWxwaGEnOlxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcm91dGVyID0gbmV3IEFscGhhUm91dGVyKHtcbiAgICAgICAgICBjaGFpbklkLFxuICAgICAgICAgIHByb3ZpZGVyLFxuICAgICAgICAgIHYzU3ViZ3JhcGhQcm92aWRlcixcbiAgICAgICAgICBtdWx0aWNhbGwyUHJvdmlkZXI6IG11bHRpY2FsbFByb3ZpZGVyLFxuICAgICAgICAgIHYzUG9vbFByb3ZpZGVyLFxuICAgICAgICAgIG9uQ2hhaW5RdW90ZVByb3ZpZGVyLFxuICAgICAgICAgIGdhc1ByaWNlUHJvdmlkZXIsXG4gICAgICAgICAgdjNHYXNNb2RlbEZhY3Rvcnk6IG5ldyBWM0hldXJpc3RpY0dhc01vZGVsRmFjdG9yeSgpLFxuICAgICAgICAgIGJsb2NrZWRUb2tlbkxpc3RQcm92aWRlcixcbiAgICAgICAgICB0b2tlblByb3ZpZGVyLFxuICAgICAgICAgIHYyUG9vbFByb3ZpZGVyLFxuICAgICAgICAgIHYyUXVvdGVQcm92aWRlcixcbiAgICAgICAgICB2MlN1YmdyYXBoUHJvdmlkZXIsXG4gICAgICAgICAgc2ltdWxhdG9yLFxuICAgICAgICAgIHJvdXRlQ2FjaGluZ1Byb3ZpZGVyLFxuICAgICAgICAgIHRva2VuVmFsaWRhdG9yUHJvdmlkZXIsXG4gICAgICAgICAgdG9rZW5Qcm9wZXJ0aWVzUHJvdmlkZXIsXG4gICAgICAgIH0pXG4gICAgICAgIGJyZWFrXG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIGNoYWluSWQ6IGNoYWluSWRFbnVtLFxuICAgICAgaWQ6IHF1b3RlSWQsXG4gICAgICBsb2csXG4gICAgICBtZXRyaWMsXG4gICAgICByb3V0ZXIsXG4gICAgICB2M1Bvb2xQcm92aWRlcixcbiAgICAgIHYyUG9vbFByb3ZpZGVyLFxuICAgICAgdG9rZW5Qcm92aWRlcixcbiAgICAgIHRva2VuTGlzdFByb3ZpZGVyLFxuICAgICAgcXVvdGVTcGVlZCxcbiAgICAgIGludGVudCxcbiAgICB9XG4gIH1cbn1cbiJdfQ==