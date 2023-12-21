import { Widget } from './core/model/widget';
import { WidgetsFactory } from './core/widgets-factory';
export declare class QuoteAmountsWidgetsFactory implements WidgetsFactory {
    region: string;
    namespace: string;
    constructor(namespace: string, region: string);
    generateWidgets(): Widget[];
    private generateChartWidgetsFromPairsByTradeType;
    private generateChartWidgetsFromPairs;
    private generateChartWidgetsFromPair;
    private tradeTypeToString;
    private generateStatWithLabel;
}
