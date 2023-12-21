import { Widget } from './core/model/widget';
import { WidgetsFactory } from './core/widgets-factory';
export declare class CachedRoutesWidgetsFactory implements WidgetsFactory {
    region: string;
    namespace: string;
    lambdaName: string;
    constructor(namespace: string, region: string, lambdaName: string);
    generateWidgets(): Widget[];
    private generateCacheHitMissMetricsWidgets;
}
