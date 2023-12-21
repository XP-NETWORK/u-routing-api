import { SimulationStatus } from '@uniswap/smart-order-router';
import Logger from 'bunyan';
export declare const simulationStatusToString: (simulationStatus: SimulationStatus | undefined, log: Logger) => "" | "SUCCESS" | "FAILED" | "NOT_APPROVED" | "UNATTEMPTED" | "INSUFFICIENT_BALANCE" | "NOT_SUPPORTED";
