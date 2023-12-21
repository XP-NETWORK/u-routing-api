import { WidgetsFactory } from './core/widgets-factory';
import { Widget } from './core/model/widget';
import { ChainId } from '@uniswap/sdk-core';
export declare class RpcProvidersWidgetsFactory implements WidgetsFactory {
    region: string;
    namespace: string;
    chains: Array<ChainId>;
    constructor(namespace: string, region: string, chains: Array<ChainId>);
    generateWidgets(): Widget[];
    private generateWidgetsForMethod;
    private generateSuccessRateForMethod;
    private generateRequestsWidgetForMethod;
}
