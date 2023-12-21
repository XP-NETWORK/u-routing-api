import { IMetric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import { MetricsLogger as AWSEmbeddedMetricsLogger } from 'aws-embedded-metrics';
export declare class AWSMetricsLogger implements IMetric {
    private awsMetricLogger;
    constructor(awsMetricLogger: AWSEmbeddedMetricsLogger);
    putDimensions(dimensions: Record<string, string>): void;
    putMetric(key: string, value: number, unit?: MetricLoggerUnit): void;
    setProperty(key: string, value: unknown): void;
}
