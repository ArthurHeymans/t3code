import type * as NodeSqlite from "node:sqlite";

export interface WorkerOptions {
  readonly filename: string;
  readonly readOnly: boolean;
  readonly allowExtension: boolean;
  readonly cacheSize: number;
  readonly cacheTTL: number;
}

export type Request =
  | { readonly id: number; readonly type: "close" }
  | {
      readonly id: number;
      readonly type: "execute";
      readonly sql: string;
      readonly params: ReadonlyArray<unknown>;
      readonly mode: "rows" | "values" | "raw";
      readonly prepared: boolean;
      readonly safeIntegers: boolean;
    };

export type Result =
  | ReadonlyArray<Record<string, unknown>>
  | ReadonlyArray<ReadonlyArray<unknown>>
  | NodeSqlite.StatementResultingChanges;

export type Response =
  | { readonly id: number; readonly result: Result }
  | {
      readonly id: number;
      readonly error: {
        readonly message: string;
        readonly operation: string;
        readonly code?: string | number | undefined;
        readonly errno?: number | undefined;
        readonly errcode?: number | undefined;
        readonly errstr?: string | undefined;
      };
    };

// Self-contained so its compiled source can run from dev, bundles and Node SEA
// without shipping a separate worker entry point or resolving TS imports.
export function workerMain() {
  // Property access keeps bundlers from hoisting these loads out of the body.
  const sqlite: typeof import("node:sqlite") = globalThis.require("node:sqlite");
  const threads: typeof import("node:worker_threads") = globalThis.require("node:worker_threads");
  const port = threads.parentPort;
  if (!port) throw new Error("SQLite worker requires a parent port");
  const options: WorkerOptions = threads.workerData;
  const sendError = (id: number, cause: unknown, operation: string) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const details = error as Error & {
      code?: string | number;
      errno?: number;
      errcode?: number;
      errstr?: string;
    };
    port.postMessage({
      id,
      error: {
        message: error.message,
        operation,
        code: details.code,
        errno: details.errno,
        errcode: details.errcode,
        errstr: details.errstr,
      },
    } satisfies Response);
  };
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new sqlite.DatabaseSync(options.filename, {
      readOnly: options.readOnly,
      allowExtension: options.allowExtension,
    });
    port.postMessage({ id: 0, result: [] } satisfies Response);
  } catch (cause) {
    sendError(0, cause, "open");
    port.close();
    return;
  }

  const cache = new Map<string, { statement: NodeSqlite.StatementSync; expires: number }>();
  port.on("message", (request: Request) => {
    let operation = "prepare";
    try {
      if (request.type === "close") {
        operation = "close";
        cache.clear();
        database.close();
        port.postMessage({ id: request.id, result: [] } satisfies Response);
        port.close();
        return;
      }
      const cached = request.prepared ? cache.get(request.sql) : undefined;
      const statement =
        cached && cached.expires > performance.now()
          ? cached.statement
          : database.prepare(request.sql);
      if (request.prepared && options.cacheSize > 0) {
        cache.delete(request.sql);
        cache.set(request.sql, {
          statement,
          expires:
            cached && cached.statement === statement
              ? cached.expires
              : performance.now() + options.cacheTTL,
        });
        if (cache.size > options.cacheSize) {
          const oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
      }
      operation = "execute";
      statement.setReadBigInts(request.safeIntegers);
      statement.setReturnArrays(request.mode === "values");
      const params = request.params as Array<NodeSqlite.SQLInputValue>;
      let result: Result;
      if (statement.columns().length > 0) {
        result = statement.all(...params);
      } else {
        const changes = statement.run(...params);
        result = request.mode === "raw" ? changes : [];
      }
      port.postMessage({ id: request.id, result } satisfies Response);
    } catch (cause) {
      sendError(request.id, cause, operation);
    }
  });
}
