import { DynamoDB } from 'aws-sdk';
export declare const deleteAllTables: () => Promise<void>;
export declare const setupTables: (...tables: DynamoDB.Types.CreateTableInput[]) => void;
