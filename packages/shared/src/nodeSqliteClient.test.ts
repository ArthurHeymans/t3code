import * as NodeSqlite from "node:sqlite";
import * as NodeTimers from "node:timers";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("keeps outside writes out of an open transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE isolated(value TEXT)`;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO isolated VALUES ('inside')`;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return yield* sql`SELECT value FROM isolated`;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const outside = yield* sql`INSERT INTO isolated VALUES ('outside')`.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      assert.deepEqual(yield* Fiber.join(transaction), [{ value: "inside" }]);
      yield* Fiber.join(outside);
      assert.deepEqual(yield* sql`SELECT value FROM isolated ORDER BY value`, [
        { value: "inside" },
        { value: "outside" },
      ]);
    }),
  );

  it.effect("rolls back an interrupted transaction before allowing the next writer", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE interrupted(value TEXT)`;
      const started = yield* Deferred.make<void>();
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO interrupted VALUES ('rolled back')`;
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const outside = yield* sql`INSERT INTO interrupted VALUES ('retained')`.pipe(
        Effect.forkChild,
      );
      yield* Fiber.interrupt(transaction);
      yield* Fiber.join(outside);
      assert.deepEqual(yield* sql`SELECT value FROM interrupted`, [{ value: "retained" }]);
    }),
  );

  it.effect("rolls back a nested transaction without losing its outer writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE nested(value TEXT)`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO nested VALUES ('outer')`;
          const failure = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO nested VALUES ('inner')`;
                return yield* Effect.fail("rollback");
              }),
            )
            .pipe(Effect.flip);
          assert.equal(failure, "rollback");
        }),
      );
      assert.deepEqual(yield* sql`SELECT value FROM nested`, [{ value: "outer" }]);
    }),
  );

  it.effect("preserves bindings, bigint results and cached result modes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE bindings(value INTEGER, bytes BLOB)`;
      const value = 9007199254740993n;
      yield* sql`INSERT INTO bindings VALUES (${value}, ${new Uint8Array([1, 2, 3])})`;
      const query = sql`SELECT value, bytes FROM bindings`;
      const expected = [{ value, bytes: new Uint8Array([1, 2, 3]) }];
      yield* Effect.gen(function* () {
        assert.deepEqual(yield* query, expected);
        assert.deepEqual(yield* query.values, [[value, new Uint8Array([1, 2, 3])]]);
        assert.deepEqual(yield* query, expected);
        assert.deepEqual(yield* query.valuesUnprepared, [[value, new Uint8Array([1, 2, 3])]]);
      }).pipe(Effect.provideService(SqlClient.SafeIntegers, true));
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );
});

it.effect("fails pending and later queries if the database worker exits", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi
          .spyOn(NodeWorkerThreads.Worker.prototype, "postMessage")
          .mockImplementationOnce(function (this: NodeWorkerThreads.Worker) {
            void this.terminate();
          }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const error = yield* sql`SELECT 1`.pipe(Effect.flip);
    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "worker");
    const later = yield* sql`SELECT 2`.pipe(Effect.flip);
    assert.equal(later.reason.operation, "worker");
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect("keeps the main thread responsive while SQLite waits on another writer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-worker-" });
    const filename = path.join(directory, "state.sqlite");
    const blocker = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (database) => Effect.sync(() => database.close()),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(value TEXT)`;
      yield* sql`PRAGMA busy_timeout = 250`;
      yield* Effect.sync(() => blocker.exec("BEGIN IMMEDIATE"));
      // The native callback must run while the write waits, not after SQLite
      // times out. On the old synchronous adapter this write fails SQLITE_BUSY.
      const writer = yield* sql`INSERT INTO entries VALUES ('retained')`.pipe(Effect.forkChild);
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            NodeTimers.setImmediate(() => {
              blocker.exec("ROLLBACK");
              resolve();
            });
          }),
      );
      yield* Fiber.join(writer);
      assert.deepEqual(yield* sql`SELECT value FROM entries`, [{ value: "retained" }]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);
