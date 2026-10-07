/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`, on a dedicated worker thread.
 *
 * @module SqliteClient
 */
import * as NodeWorkerThreads from "node:worker_threads";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

import { workerMain, type Request, type Response, type Result } from "./nodeSqliteWorker.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const worker = yield* Effect.try({
      try: () =>
        new NodeWorkerThreads.Worker(`(${workerMain.toString()})()`, {
          eval: true,
          workerData: {
            filename: options.filename,
            readOnly: options.readonly ?? false,
            allowExtension: options.allowExtension ?? false,
            cacheSize: options.prepareCacheSize ?? 200,
            cacheTTL: Duration.toMillis(options.prepareCacheTTL ?? "10 minutes"),
          },
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifySqliteError(cause, {
            message: "Failed to start SQLite worker",
            operation: "open",
          }),
        }),
    });
    const pending = new Map<
      number,
      {
        resolve: (result: Result) => void;
        reject: (error: SqlError) => void;
      }
    >();
    let nextId = 0;
    let failure: SqlError | undefined;
    let opened = false;
    const ready = new Promise<Result>((resolve, reject) => pending.set(0, { resolve, reject }));
    const fail = (cause: unknown) => {
      failure = new SqlError({
        reason: classifySqliteError(cause, {
          message: "SQLite worker stopped",
          operation: "worker",
        }),
      });
      for (const callback of pending.values()) callback.reject(failure);
      pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`SQLite worker exited with code ${code}`)));
    worker.on("message", (response: Response) => {
      const callback = pending.get(response.id);
      if (!callback) return;
      pending.delete(response.id);
      if ("error" in response) {
        callback.reject(
          new SqlError({
            reason: classifySqliteError(
              Object.assign(new Error(response.error.message), response.error),
              {
                message: `Failed to ${response.error.operation} SQLite statement`,
                operation: response.error.operation,
              },
            ),
          }),
        );
      } else {
        callback.resolve(response.result);
      }
    });
    const send = (
      request: { readonly type: "close" } | Omit<Extract<Request, { type: "execute" }>, "id">,
    ) =>
      new Promise<Result>((resolve, reject) => {
        if (failure) return reject(failure);
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        try {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers have no targetOrigin.
          worker.postMessage({ ...request, id });
        } catch (cause) {
          pending.delete(id);
          reject(
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Failed to send SQLite request",
                operation: "execute",
              }),
            }),
          );
        }
      });
    yield* Scope.addFinalizer(
      scope,
      Effect.tryPromise({
        try: () =>
          failure || !opened ? Promise.resolve() : send({ type: "close" }).then(() => undefined),
        catch: (cause) => cause as SqlError,
      }).pipe(Effect.ensuring(Effect.promise(() => worker.terminate())), Effect.orDie),
    );
    yield* Effect.tryPromise({ try: () => ready, catch: (cause) => cause as SqlError });
    opened = true;

    const run = (
      sql: string,
      params: ReadonlyArray<unknown>,
      mode: "rows" | "values" | "raw",
      prepared = true,
    ) =>
      Effect.withFiber<Result, SqlError>((fiber) =>
        Effect.tryPromise({
          try: () =>
            send({
              type: "execute",
              sql,
              params,
              mode,
              prepared,
              safeIntegers: Boolean(Context.get(fiber.context, Client.SafeIntegers)),
            }),
          catch: (cause) => cause as SqlError,
        }).pipe(
          // SQLite cannot cancel an in-flight statement. Keep its connection
          // leased until the reply, so interruption cannot release a transaction
          // ahead of its writes or let another caller run inside it.
          Effect.uninterruptible,
        ),
      );
    const rows = (sql: string, params: ReadonlyArray<unknown>, prepared = true) =>
      Effect.map(
        run(sql, params, "rows", prepared),
        (result) => result as ReadonlyArray<Record<string, unknown>>,
      );
    const values = (sql: string, params: ReadonlyArray<unknown>, prepared = true) =>
      Effect.map(
        run(sql, params, "values", prepared),
        (result) => result as ReadonlyArray<ReadonlyArray<unknown>>,
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(rows(sql, params), rowTransform) : rows(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, "raw");
      },
      executeValues(sql, params) {
        return values(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return values(sql, params ?? [], false);
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = rows(sql, params ?? [], false);
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;

  // Statements now suspend, so the lease must cover their execution, not just
  // returning the connection. Transactions keep that same lease until close.
  const acquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
      connection,
    );
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer: acquirer,
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
