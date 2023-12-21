export class CachedRoutesWidgetsFactory {
    constructor(namespace, region, lambdaName) {
        this.region = region;
        this.namespace = namespace;
        this.lambdaName = lambdaName;
    }
    generateWidgets() {
        return this.generateCacheHitMissMetricsWidgets();
    }
    generateCacheHitMissMetricsWidgets() {
        return [
            {
                type: 'text',
                width: 24,
                height: 1,
                properties: {
                    markdown: `# Overall Cache Hit/Miss`,
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 7,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: [
                        [{ expression: 'SUM(METRICS())', label: 'Requests', id: 'e1' }],
                        [this.namespace, 'GetCachedRoute_hit_livemode', 'Service', 'RoutingAPI', { label: 'Cache Hit', id: 'm1' }],
                        ['.', 'GetCachedRoute_miss_livemode', '.', '.', { label: 'Cache Miss', id: 'm2' }],
                    ],
                    region: this.region,
                    title: 'Cache Hit, Miss and Total requests of Cachemode.Livemode',
                    period: 300,
                    stat: 'Sum',
                    yAxis: {
                        left: {
                            min: 0,
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 7,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: [
                        [{ expression: 'SUM(METRICS())', label: 'AllRequests', id: 'e1', visible: false }],
                        [{ expression: 'm1/e1 * 100', label: 'Cache Hit Rate', id: 'e2' }],
                        [{ expression: 'm2/e1 * 100', label: 'Cache Miss Rate', id: 'e3' }],
                        [
                            this.namespace,
                            'GetCachedRoute_hit_livemode',
                            'Service',
                            'RoutingAPI',
                            { label: 'Cache Hit', id: 'm1', visible: false },
                        ],
                        ['.', 'GetCachedRoute_miss_livemode', '.', '.', { label: 'Cache Miss', id: 'm2', visible: false }],
                    ],
                    region: this.region,
                    title: 'Cache Hit and Miss Rates of Cachemode.Livemode',
                    period: 300,
                    stat: 'Sum',
                    yAxis: {
                        left: {
                            min: 0,
                            max: 100,
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 7,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: [
                        [{ expression: 'SUM(METRICS())', label: 'Requests', id: 'e1' }],
                        [
                            this.namespace,
                            'GetCachedRoute_hit_tapcompare',
                            'Service',
                            'RoutingAPI',
                            { label: 'Cache Hit', id: 'm1' },
                        ],
                        ['.', 'GetCachedRoute_miss_tapcompare', '.', '.', { label: 'Cache Miss', id: 'm2' }],
                    ],
                    region: this.region,
                    title: 'Cache Hit, Miss and Total requests of Cachemode.Tapcompare',
                    period: 300,
                    stat: 'Sum',
                    yAxis: {
                        left: {
                            min: 0,
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 7,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: [
                        [{ expression: 'SUM(METRICS())', label: 'AllRequests', id: 'e1', visible: false }],
                        [{ expression: 'm1/e1 * 100', label: 'Cache Hit Rate', id: 'e2' }],
                        [{ expression: 'm2/e1 * 100', label: 'Cache Miss Rate', id: 'e3' }],
                        [
                            this.namespace,
                            'GetCachedRoute_hit_tapcompare',
                            'Service',
                            'RoutingAPI',
                            { label: 'Cache Hit', id: 'm1', visible: false },
                        ],
                        ['.', 'GetCachedRoute_miss_tapcompare', '.', '.', { label: 'Cache Miss', id: 'm2', visible: false }],
                    ],
                    region: this.region,
                    title: 'Cache Hit and Miss Rates of cachemode.Tapcompare',
                    period: 300,
                    stat: 'Sum',
                    yAxis: {
                        left: {
                            min: 0,
                            max: 100,
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 7,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: [
                        [
                            this.namespace,
                            'TapcompareCachedRoute_quoteGasAdjustedDiffPercent',
                            'Service',
                            'RoutingAPI',
                            { label: 'Misquote' },
                        ],
                    ],
                    region: this.region,
                    title: 'Total number of Misquotes from Tapcompare',
                    period: 300,
                    stat: 'SampleCount',
                    yAxis: {
                        left: {
                            min: 0,
                        },
                    },
                },
            },
            {
                type: 'metric',
                width: 12,
                height: 7,
                properties: {
                    view: 'timeSeries',
                    stacked: false,
                    metrics: [
                        [{ expression: 'm2/m1 * 100', label: 'Misquote Rate', id: 'e1' }],
                        [
                            this.namespace,
                            'GetCachedRoute_hit_tapcompare',
                            'Service',
                            'RoutingAPI',
                            { label: 'Cache Hit', id: 'm1', visible: false },
                        ],
                        [
                            '.',
                            'TapcompareCachedRoute_quoteGasAdjustedDiffPercent',
                            '.',
                            '.',
                            { label: 'Cache Miss', id: 'm2', stat: 'SampleCount', visible: false },
                        ],
                    ],
                    region: this.region,
                    title: 'Misquote rate from Tapcompare',
                    period: 300,
                    stat: 'Sum',
                    yAxis: {
                        left: {
                            min: 0,
                        },
                    },
                },
            },
        ];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FjaGVkLXJvdXRlcy13aWRnZXRzLWZhY3RvcnkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9saWIvZGFzaGJvYXJkcy9jYWNoZWQtcm91dGVzLXdpZGdldHMtZmFjdG9yeS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFHQSxNQUFNLE9BQU8sMEJBQTBCO0lBS3JDLFlBQVksU0FBaUIsRUFBRSxNQUFjLEVBQUUsVUFBa0I7UUFDL0QsSUFBSSxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUE7UUFDcEIsSUFBSSxDQUFDLFNBQVMsR0FBRyxTQUFTLENBQUE7UUFDMUIsSUFBSSxDQUFDLFVBQVUsR0FBRyxVQUFVLENBQUE7SUFDOUIsQ0FBQztJQUVELGVBQWU7UUFDYixPQUFPLElBQUksQ0FBQyxrQ0FBa0MsRUFBRSxDQUFBO0lBQ2xELENBQUM7SUFFTyxrQ0FBa0M7UUFDeEMsT0FBTztZQUNMO2dCQUNFLElBQUksRUFBRSxNQUFNO2dCQUNaLEtBQUssRUFBRSxFQUFFO2dCQUNULE1BQU0sRUFBRSxDQUFDO2dCQUNULFVBQVUsRUFBRTtvQkFDVixRQUFRLEVBQUUsMEJBQTBCO2lCQUNyQzthQUNGO1lBQ0Q7Z0JBQ0UsSUFBSSxFQUFFLFFBQVE7Z0JBQ2QsS0FBSyxFQUFFLEVBQUU7Z0JBQ1QsTUFBTSxFQUFFLENBQUM7Z0JBQ1QsVUFBVSxFQUFFO29CQUNWLElBQUksRUFBRSxZQUFZO29CQUNsQixPQUFPLEVBQUUsS0FBSztvQkFDZCxPQUFPLEVBQUU7d0JBQ1AsQ0FBQyxFQUFFLFVBQVUsRUFBRSxnQkFBZ0IsRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLEVBQUUsRUFBRSxJQUFJLEVBQUUsQ0FBQzt3QkFDL0QsQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLDZCQUE2QixFQUFFLFNBQVMsRUFBRSxZQUFZLEVBQUUsRUFBRSxLQUFLLEVBQUUsV0FBVyxFQUFFLEVBQUUsRUFBRSxJQUFJLEVBQUUsQ0FBQzt3QkFDMUcsQ0FBQyxHQUFH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QUN2RTtxQkFDRjtvQkFDRCxNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU07b0JBQ25CLEtBQUssRUFBRSwrQkFBK0I7b0JBQ3RDLE1BQU0sRUFBRSxHQUFHO29CQUNYLElBQUksRUFBRSxLQUFLO29CQUNYLEtBQUssRUFBRTt3QkFDTCxJQUFJLEVBQUU7NEJBQ0osR0FBRyxFQUFFLENBQUM7eUJBQ1A7cUJBQ0Y7aUJBQ0Y7YUFDRjtTQUNGLENBQUE7SUFDSCxDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBXaWRnZXQgfSBmcm9tICcuL2NvcmUvbW9kZWwvd2lkZ2V0J1xuaW1wb3J0IHsgV2lkZ2V0c0ZhY3RvcnkgfSBmcm9tICcuL2NvcmUvd2lkZ2V0cy1mYWN0b3J5J1xuXG5leHBvcnQgY2xhc3MgQ2FjaGVkUm91dGVzV2lkZ2V0c0ZhY3RvcnkgaW1wbGVtZW50cyBXaWRnZXRzRmFjdG9yeSB7XG4gIHJlZ2lvbjogc3RyaW5nXG4gIG5hbWVzcGFjZTogc3RyaW5nXG4gIGxhbWJkYU5hbWU6IHN0cmluZ1xuXG4gIGNvbnN0cnVjdG9yKG5hbWVzcGFjZTogc3RyaW5nLCByZWdpb246IHN0cmluZywgbGFtYmRhTmFtZTogc3RyaW5nKSB7XG4gICAgdGhpcy5yZWdpb24gPSByZWdpb25cbiAgICB0aGlzLm5hbWVzcGFjZSA9IG5hbWVzcGFjZVxuICAgIHRoaXMubGFtYmRhTmFtZSA9IGxhbWJkYU5hbWVcbiAgfVxuXG4gIGdlbmVyYXRlV2lkZ2V0cygpOiBXaWRnZXRbXSB7XG4gICAgcmV0dXJuIHRoaXMuZ2VuZXJhdGVDYWNoZUhpdE1pc3NNZXRyaWNzV2lkZ2V0cygpXG4gIH1cblxuICBwcml2YXRlIGdlbmVyYXRlQ2FjaGVIaXRNaXNzTWV0cmljc1dpZGdldHMoKTogV2lkZ2V0W10ge1xuICAgIHJldHVybiBbXG4gICAgICB7XG4gICAgICAgIHR5cGU6ICd0ZXh0JyxcbiAgICAgICAgd2lkdGg6IDI0LFxuICAgICAgICBoZWlnaHQ6IDEsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICBtYXJrZG93bjogYCMgT3ZlcmFsbCBDYWNoZSBIaXQvTWlzc2AsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgd2lkdGg6IDEyLFxuICAgICAgICBoZWlnaHQ6IDcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgbWV0cmljczogW1xuICAgICAgICAgICAgW3sgZXhwcmVzc2lvbjogJ1NVTShNRVRSSUNTKCkpJywgbGFiZWw6ICdSZXF1ZXN0cycsIGlkOiAnZTEnIH1dLFxuICAgICAgICAgICAgW3RoaXMubmFtZXNwYWNlLCAnR2V0Q2FjaGVkUm91dGVfaGl0X2xpdmVtb2RlJywgJ1NlcnZpY2UnLCAnUm91dGluZ0FQSScsIHsgbGFiZWw6ICdDYWNoZSBIaXQnLCBpZDogJ20xJyB9XSxcbiAgICAgICAgICAgIFsnLicsICdHZXRDYWNoZWRSb3V0ZV9taXNzX2xpdmVtb2RlJywgJy4nLCAnLicsIHsgbGFiZWw6ICdDYWNoZSBNaXNzJywgaWQ6ICdtMicgfV0sXG4gICAgICAgICAgXSxcbiAgICAgICAgICByZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgICAgIHRpdGxlOiAnQ2FjaGUgSGl0LCBNaXNzIGFuZCBUb3RhbCByZXF1ZXN0cyBvZiBDYWNoZW1vZGUuTGl2ZW1vZGUnLFxuICAgICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgICAgIHN0YXQ6ICdTdW0nLFxuICAgICAgICAgIHlBeGlzOiB7XG4gICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgIG1pbjogMCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHR5cGU6ICdtZXRyaWMnLFxuICAgICAgICB3aWR0aDogMTIsXG4gICAgICAgIGhlaWdodDogNyxcbiAgICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAgIHZpZXc6ICd0aW1lU2VyaWVzJyxcbiAgICAgICAgICBzdGFja2VkOiBmYWxzZSxcbiAgICAgICAgICBtZXRyaWNzOiBbXG4gICAgICAgICAgICBbeyBleHByZXNzaW9uOiAnU1VNKE1FVFJJQ1MoKSknLCBsYWJlbDogJ0FsbFJlcXVlc3RzJywgaWQ6ICdlMScsIHZpc2libGU6IGZhbHNlIH1dLFxuICAgICAgICAgICAgW3sgZXhwcmVzc2lvbjogJ20xL2UxICogMTAwJywgbGFiZWw6ICdDYWNoZSBIaXQgUmF0ZScsIGlkOiAnZTInIH1dLFxuICAgICAgICAgICAgW3sgZXhwcmVzc2lvbjogJ20yL2UxICogMTAwJywgbGFiZWw6ICdDYWNoZSBNaXNzIFJhdGUnLCBpZDogJ2UzJyB9XSxcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgdGhpcy5uYW1lc3BhY2UsXG4gICAgICAgICAgICAgICdHZXRDYWNoZWRSb3V0ZV9oaXRfbGl2ZW1vZGUnLFxuICAgICAgICAgICAgICAnU2VydmljZScsXG4gICAgICAgICAgICAgICdSb3V0aW5nQVBJJyxcbiAgICAgICAgICAgICAgeyBsYWJlbDogJ0NhY2hlIEhpdCcsIGlkOiAnbTEnLCB2aXNpYmxlOiBmYWxzZSB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFsnLicsICdHZXRDYWNoZWRSb3V0ZV9taXNzX2xpdmVtb2RlJywgJy4nLCAnLicsIHsgbGFiZWw6ICdDYWNoZSBNaXNzJywgaWQ6ICdtMicsIHZpc2libGU6IGZhbHNlIH1dLFxuICAgICAgICAgIF0sXG4gICAgICAgICAgcmVnaW9uOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgICB0aXRsZTogJ0NhY2hlIEhpdCBhbmQgTWlzcyBSYXRlcyBvZiBDYWNoZW1vZGUuTGl2ZW1vZGUnLFxuICAgICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgICAgIHN0YXQ6ICdTdW0nLFxuICAgICAgICAgIHlBeGlzOiB7XG4gICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgIG1pbjogMCxcbiAgICAgICAgICAgICAgbWF4OiAxMDAsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgd2lkdGg6IDEyLFxuICAgICAgICBoZWlnaHQ6IDcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgbWV0cmljczogW1xuICAgICAgICAgICAgW3sgZXhwcmVzc2lvbjogJ1NVTShNRVRSSUNTKCkpJywgbGFiZWw6ICdSZXF1ZXN0cycsIGlkOiAnZTEnIH1dLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICB0aGlzLm5hbWVzcGFjZSxcbiAgICAgICAgICAgICAgJ0dldENhY2hlZFJvdXRlX2hpdF90YXBjb21wYXJlJyxcbiAgICAgICAgICAgICAgJ1NlcnZpY2UnLFxuICAgICAgICAgICAgICAnUm91dGluZ0FQSScsXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdDYWNoZSBIaXQnLCBpZDogJ20xJyB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFsnLicsICdHZXRDYWNoZWRSb3V0ZV9taXNzX3RhcGNvbXBhcmUnLCAnLicsICcuJywgeyBsYWJlbDogJ0NhY2hlIE1pc3MnLCBpZDogJ20yJyB9XSxcbiAgICAgICAgICBdLFxuICAgICAgICAgIHJlZ2lvbjogdGhpcy5yZWdpb24sXG4gICAgICAgICAgdGl0bGU6ICdDYWNoZSBIaXQsIE1pc3MgYW5kIFRvdGFsIHJlcXVlc3RzIG9mIENhY2hlbW9kZS5UYXBjb21wYXJlJyxcbiAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICBzdGF0OiAnU3VtJyxcbiAgICAgICAgICB5QXhpczoge1xuICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICBtaW46IDAsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICB0eXBlOiAnbWV0cmljJyxcbiAgICAgICAgd2lkdGg6IDEyLFxuICAgICAgICBoZWlnaHQ6IDcsXG4gICAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgICB2aWV3OiAndGltZVNlcmllcycsXG4gICAgICAgICAgc3RhY2tlZDogZmFsc2UsXG4gICAgICAgICAgbWV0cmljczogW1xuICAgICAgICAgICAgW3sgZXhwcmVzc2lvbjogJ1NVTShNRVRSSUNTKCkpJywgbGFiZWw6ICdBbGxSZXF1ZXN0cycsIGlkOiAnZTEnLCB2aXNpYmxlOiBmYWxzZSB9XSxcbiAgICAgICAgICAgIFt7IGV4cHJlc3Npb246ICdtMS9lMSAqIDEwMCcsIGxhYmVsOiAnQ2FjaGUgSGl0IFJhdGUnLCBpZDogJ2UyJyB9XSxcbiAgICAgICAgICAgIFt7IGV4cHJlc3Npb246ICdtMi9lMSAqIDEwMCcsIGxhYmVsOiAnQ2FjaGUgTWlzcyBSYXRlJywgaWQ6ICdlMycgfV0sXG4gICAgICAgICAgICBbXG4gICAgICAgICAgICAgIHRoaXMubmFtZXNwYWNlLFxuICAgICAgICAgICAgICAnR2V0Q2FjaGVkUm91dGVfaGl0X3RhcGNvbXBhcmUnLFxuICAgICAgICAgICAgICAnU2VydmljZScsXG4gICAgICAgICAgICAgICdSb3V0aW5nQVBJJyxcbiAgICAgICAgICAgICAgeyBsYWJlbDogJ0NhY2hlIEhpdCcsIGlkOiAnbTEnLCB2aXNpYmxlOiBmYWxzZSB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIFsnLicsICdHZXRDYWNoZWRSb3V0ZV9taXNzX3RhcGNvbXBhcmUnLCAnLicsICcuJywgeyBsYWJlbDogJ0NhY2hlIE1pc3MnLCBpZDogJ20yJywgdmlzaWJsZTogZmFsc2UgfV0sXG4gICAgICAgICAgXSxcbiAgICAgICAgICByZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgICAgIHRpdGxlOiAnQ2FjaGUgSGl0IGFuZCBNaXNzIFJhdGVzIG9mIGNhY2hlbW9kZS5UYXBjb21wYXJlJyxcbiAgICAgICAgICBwZXJpb2Q6IDMwMCxcbiAgICAgICAgICBzdGF0OiAnU3VtJyxcbiAgICAgICAgICB5QXhpczoge1xuICAgICAgICAgICAgbGVmdDoge1xuICAgICAgICAgICAgICBtaW46IDAsXG4gICAgICAgICAgICAgIG1heDogMTAwLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgaGVpZ2h0OiA3LFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgIG1ldHJpY3M6IFtcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgdGhpcy5uYW1lc3BhY2UsXG4gICAgICAgICAgICAgICdUYXBjb21wYXJlQ2FjaGVkUm91dGVfcXVvdGVHYXNBZGp1c3RlZERpZmZQZXJjZW50JyxcbiAgICAgICAgICAgICAgJ1NlcnZpY2UnLFxuICAgICAgICAgICAgICAnUm91dGluZ0FQSScsXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdNaXNxdW90ZScgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgXSxcbiAgICAgICAgICByZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgICAgIHRpdGxlOiAnVG90YWwgbnVtYmVyIG9mIE1pc3F1b3RlcyBmcm9tIFRhcGNvbXBhcmUnLFxuICAgICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgICAgIHN0YXQ6ICdTYW1wbGVDb3VudCcsXG4gICAgICAgICAgeUF4aXM6IHtcbiAgICAgICAgICAgIGxlZnQ6IHtcbiAgICAgICAgICAgICAgbWluOiAwLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgdHlwZTogJ21ldHJpYycsXG4gICAgICAgIHdpZHRoOiAxMixcbiAgICAgICAgaGVpZ2h0OiA3LFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgdmlldzogJ3RpbWVTZXJpZXMnLFxuICAgICAgICAgIHN0YWNrZWQ6IGZhbHNlLFxuICAgICAgICAgIG1ldHJpY3M6IFtcbiAgICAgICAgICAgIFt7IGV4cHJlc3Npb246ICdtMi9tMSAqIDEwMCcsIGxhYmVsOiAnTWlzcXVvdGUgUmF0ZScsIGlkOiAnZTEnIH1dLFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICB0aGlzLm5hbWVzcGFjZSxcbiAgICAgICAgICAgICAgJ0dldENhY2hlZFJvdXRlX2hpdF90YXBjb21wYXJlJyxcbiAgICAgICAgICAgICAgJ1NlcnZpY2UnLFxuICAgICAgICAgICAgICAnUm91dGluZ0FQSScsXG4gICAgICAgICAgICAgIHsgbGFiZWw6ICdDYWNoZSBIaXQnLCBpZDogJ20xJywgdmlzaWJsZTogZmFsc2UgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBbXG4gICAgICAgICAgICAgICcuJyxcbiAgICAgICAgICAgICAgJ1RhcGNvbXBhcmVDYWNoZWRSb3V0ZV9xdW90ZUdhc0FkanVzdGVkRGlmZlBlcmNlbnQnLFxuICAgICAgICAgICAgICAnLicsXG4gICAgICAgICAgICAgICcuJyxcbiAgICAgICAgICAgICAgeyBsYWJlbDogJ0NhY2hlIE1pc3MnLCBpZDogJ20yJywgc3RhdDogJ1NhbXBsZUNvdW50JywgdmlzaWJsZTogZmFsc2UgfSxcbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgXSxcbiAgICAgICAgICByZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgICAgIHRpdGxlOiAnTWlzcXVvdGUgcmF0ZSBmcm9tIFRhcGNvbXBhcmUnLFxuICAgICAgICAgIHBlcmlvZDogMzAwLFxuICAgICAgICAgIHN0YXQ6ICdTdW0nLFxuICAgICAgICAgIHlBeGlzOiB7XG4gICAgICAgICAgICBsZWZ0OiB7XG4gICAgICAgICAgICAgIG1pbjogMCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgXVxuICB9XG59XG4iXX0=