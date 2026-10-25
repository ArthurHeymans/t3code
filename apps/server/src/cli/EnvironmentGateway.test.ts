// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { afterEach } from "vite-plus/test";
import {
  EnvironmentGatewayError,
  makeEnvironmentGateway,
  environmentBridgeArgv,
} from "./EnvironmentGateway.ts";
import type { LocalConnectionSecret } from "@t3tools/contracts";

const originalArgv = process.argv[1];
afterEach(() => {
  process.argv[1] = originalArgv!;
});
const entry = (id: string): LocalConnectionSecret => ({
  id,
  label: id,
  endpoint: `https://remote-${id}.example`,
  enabled: true,
  token: `credential-${id}`,
});
const Record = Schema.Struct({
  kind: Schema.Literal("environment.message"),
  environmentId: Schema.String,
  generation: Schema.Number,
  message: Schema.Record(Schema.String, Schema.Unknown),
});
const decode = Schema.decodeUnknownSync(Record);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  process.argv[1] = NodeURL.fileURLToPath(
    new URL("./EnvironmentGateway.fixture.mjs", import.meta.url),
  );
  const entries = new Map(["a", "b"].map((id) => [id, entry(id)]));
  const records: unknown[] = [];
  const queue = yield* Queue.unbounded<unknown>();
  const gateway = yield* makeEnvironmentGateway(
    (id) =>
      entries.has(id)
        ? Effect.succeed(entries.get(id)!)
        : Effect.fail(new EnvironmentGatewayError({ message: "missing" })),
    (record) =>
      Effect.sync(() => {
        records.push(record);
      }).pipe(Effect.andThen(Queue.offer(queue, record)), Effect.asVoid),
  );
  yield* gateway.reconcile({ environments: [...entries.values()] });
  return { gateway, entries, records, take: Queue.take(queue).pipe(Effect.map(decode)) };
});

describe("environment subprocess gateway", () => {
  it("launches the same executable or script without inheriting watchers/debuggers", () => {
    expect(environmentBridgeArgv(true, "not-a-script", ["--inspect"])).toEqual([
      "client",
      "--stdio",
    ]);
    expect(
      environmentBridgeArgv(false, "/source/bin.ts", [
        "--watch",
        "--watch-path",
        "/source",
        "--inspect=9229",
        "--inspect-port",
        "9229",
        "--import",
        "tsx",
        "--conditions=development",
      ]),
    ).toEqual([
      "--import",
      "tsx",
      "--conditions=development",
      "/source/bin.ts",
      "client",
      "--stdio",
    ]);
  });

  it.effect(
    "binds stored credentials to endpoints, wraps original records with identity/generation and rejects stale generations and hello forwarding",
    () =>
      Effect.gen(function* () {
        const { gateway, records, take } = yield* fixture;
        expect(
          yield* gateway.attach({
            environmentId: "a",
            clientEnvironmentId: "emacs-a",
            generation: 7,
          }),
        ).toEqual({ attached: true });
        expect(yield* take).toMatchObject({
          environmentId: "emacs-a",
          generation: 7,
          message: { kind: "ready", environmentId: "emacs-a", generation: 7 },
        });
        yield* gateway.send("emacs-a", {
          kind: "request",
          id: "one",
          operation: "probe",
          input: { endpoint: "https://remote-b.example" },
        });
        expect((yield* take).message.result).toEqual({
          authenticated: true,
          endpoint: "https://remote-a.example",
          secretInArgv: false,
        });
        expect(
          yield* Effect.flip(
            gateway.attach({ environmentId: "b", clientEnvironmentId: "emacs-a", generation: 6 }),
          ),
        ).toBeDefined();
        expect(yield* Effect.flip(gateway.send("emacs-a", { kind: "hello" }))).toBeDefined();
        expect(yield* Effect.flip(gateway.send("unknown", { kind: "request" }))).toBeDefined();
        expect(
          yield* Effect.flip(
            gateway.send("emacs-a", {
              kind: "request",
              operation: "probe",
              input: "x".repeat(900_001),
            }),
          ),
        ).toBeDefined();
        yield* gateway.detach("emacs-a");
        expect(yield* Effect.flip(gateway.send("emacs-a", { kind: "request" }))).toBeDefined();
        expect(
          yield* Effect.flip(
            gateway.attach({ environmentId: "a", clientEnvironmentId: "emacs-a", generation: 7 }),
          ),
        ).toBeDefined();
        yield* gateway.attach({
          environmentId: "b",
          clientEnvironmentId: "emacs-a",
          generation: 8,
        });
        expect((yield* take).generation).toBe(8);
        yield* gateway.send("emacs-a", { kind: "request", id: "two", operation: "probe" });
        expect((yield* take).message.result).toEqual({
          authenticated: true,
          endpoint: "https://remote-b.example",
          secretInArgv: false,
        });
        expect(encodeJson(records)).not.toContain("credential-");
      }),
  );

  it.effect(
    "removal/disable and child crashes disconnect only the affected child, with safe diagnostics",
    () =>
      Effect.gen(function* () {
        const { gateway, entries, records, take } = yield* fixture;
        yield* gateway.attach({ environmentId: "a", clientEnvironmentId: "a", generation: 1 });
        yield* take;
        yield* gateway.attach({ environmentId: "b", clientEnvironmentId: "b", generation: 2 });
        yield* take;
        entries.delete("a");
        yield* gateway.reconcile({ environments: [entry("b")] });
        expect(yield* take).toMatchObject({
          environmentId: "a",
          generation: 1,
          message: { kind: "fatal" },
        });
        expect(yield* Effect.flip(gateway.send("a", { kind: "request" }))).toBeDefined();
        yield* gateway.send("b", { kind: "request", id: "still-live", operation: "probe" });
        expect((yield* take).message.id).toBe("still-live");
        yield* gateway.send("b", { kind: "request", id: "crash", operation: "crash" });
        expect(yield* take).toMatchObject({
          environmentId: "b",
          message: {
            kind: "fatal",
            message: "Shared environment disconnected or is no longer available.",
          },
        });
        yield* gateway.attach({ environmentId: "b", clientEnvironmentId: "b", generation: 3 });
        yield* take;
        yield* gateway.send("b", { kind: "request", id: "leak", operation: "leak" });
        expect((yield* take).message.kind).toBe("fatal");
        expect(encodeJson(records)).not.toContain("credential-");
        yield* gateway.attach({ environmentId: "b", clientEnvironmentId: "b", generation: 4 });
        yield* take;
        yield* gateway.reconcile({ environments: [{ ...entry("b"), enabled: false }] });
        expect((yield* take).message.kind).toBe("fatal");
      }),
  );

  it.effect("checks removal that races credential resolution before spawning", () =>
    Effect.gen(function* () {
      const resolved = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gateway = yield* makeEnvironmentGateway(
        () =>
          Deferred.succeed(resolved, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(entry("a")),
          ),
        () => Effect.void,
      );
      yield* gateway.reconcile({ environments: [entry("a")] });
      const pending = yield* gateway
        .attach({ environmentId: "a", clientEnvironmentId: "a", generation: 1 })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(resolved);
      yield* gateway.reconcile({ environments: [] });
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toBeDefined();
    }),
  );
});
