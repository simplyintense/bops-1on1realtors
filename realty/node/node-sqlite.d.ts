// Minimal declarations for the parts of the built-in `node:sqlite` module that realty/node/search-store.ts uses.
// @types/node is v20 and does not declare node:sqlite (available unflagged from Node 22.13 and later). Keep this small.
declare module "node:sqlite" {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;
  export type SQLOutputValue = null | number | bigint | string | Uint8Array;
  export type SQLRow = Record<string, SQLOutputValue>;

  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...params: SQLInputValue[]): StatementResultingChanges;
    get(...params: SQLInputValue[]): SQLRow | undefined;
    all(...params: SQLInputValue[]): SQLRow[];
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
    readonly isOpen: boolean;
  }
}
