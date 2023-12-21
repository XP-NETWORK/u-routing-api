export type WidgetType = 'text' | 'metric' | 'log';
export type Widget = {
    type: WidgetType;
    width: number;
    height: number;
    properties: any;
};
