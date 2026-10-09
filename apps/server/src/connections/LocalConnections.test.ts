import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { AuthAccessReadScope, WS_METHODS } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import * as LocalConnections from "./LocalConnections.ts";

const entry = {
  id: "remote-a",
  label: "Remote A",
  endpoint: "https://remote-a.example",
  enabled: true,
  token: "secret-for-a",
};
const store = () => {
  const bytes = new Map<string, Uint8Array>();
  return {
    bytes,
    service: ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(bytes.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          bytes.set(name, value);
        }),
      create: (name, value) =>
        Effect.sync(() => {
          bytes.set(name, value);
        }),
      getOrCreateRandom: (name, count) =>
        Effect.sync(() => {
          const key = bytes.get(name) ?? new Uint8Array(count).fill(42);
          bytes.set(name, key);
          return key;
        }),
      remove: (name) =>
        Effect.sync(() => {
          bytes.delete(name);
        }),
    }),
  };
};
const fixture = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-local-catalog-" })),
  );
  const secrets = store();
  const layer = LocalConnections.layer.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.service)),
    Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
  );
  return { layer, secrets, config };
});

describe("local shared catalog", () => {
  it.effect(
    "is opt-in, redacts metadata, persists encrypted, resolves only ids and revokes authoritatively",
    () =>
      Effect.gen(function* () {
        const { layer, secrets } = yield* fixture;
        yield* Effect.gen(function* () {
          const catalog = yield* LocalConnections.LocalConnections;
          expect(yield* catalog.snapshot).toEqual({ environments: [] });
          expect((yield* Effect.flip(catalog.replace([entry], false))).message).toContain(
            "unavailable",
          );
          yield* catalog.replace([entry], true, undefined, (yield* catalog.status).revision);
          expect(yield* catalog.resolve(entry.id)).toEqual(entry);
          expect(yield* catalog.snapshot).toEqual({
            environments: [
              { id: entry.id, label: entry.label, endpoint: entry.endpoint, enabled: true },
            ],
          });
          expect(yield* Effect.flip(catalog.resolve("https://substitute.example"))).toBeDefined();
          const encrypted = Buffer.from(secrets.bytes.get("local-connections")!);
          expect(encrypted.toString()).not.toContain(entry.token);
          expect(encrypted.toString()).not.toContain(entry.endpoint);
        }).pipe(Effect.provide(layer));
        // Recreate the actual service over the same secret store, not a mocked catalog.
        yield* Effect.gen(function* () {
          const catalog = yield* LocalConnections.LocalConnections;
          expect(yield* catalog.resolve(entry.id)).toEqual(entry);
          yield* catalog.revoke;
          expect(yield* catalog.snapshot).toEqual({ environments: [] });
          expect(yield* Effect.flip(catalog.resolve(entry.id))).toBeDefined();
          expect(yield* Effect.flip(catalog.replace([entry], false))).toBeDefined();
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects disabled entries, duplicates and endpoint credentials", () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture;
      yield* Effect.gen(function* () {
        const catalog = yield* LocalConnections.LocalConnections;
        for (const entries of [
          [{ ...entry, enabled: false }],
          [entry, entry],
          [{ ...entry, endpoint: "https://user:password@host" }],
          [{ ...entry, endpoint: "https://host?token=secret" }],
        ]) {
          expect(yield* Effect.flip(catalog.replace(entries, true))).toBeDefined();
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps shared connections available when the server also accepts network clients", () =>
    Effect.gen(function* () {
      const { layer, secrets, config } = yield* fixture;
      yield* Effect.gen(function* () {
        const catalog = yield* LocalConnections.LocalConnections;
        yield* catalog.replace([entry], true, undefined, (yield* catalog.status).revision);
      }).pipe(Effect.provide(layer));
      for (const host of ["0.0.0.0", "::", "192.168.1.2"]) {
        yield* Effect.gen(function* () {
          const catalog = yield* LocalConnections.LocalConnections;
          expect(catalog.available).toBe(true);
          expect((yield* catalog.snapshot).environments.map(({ id }) => id)).toEqual([entry.id]);
          expect(yield* catalog.resolve(entry.id)).toEqual(entry);
        }).pipe(
          Effect.provide(
            LocalConnections.layer.pipe(
              Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.service)),
              Layer.provide(Layer.succeed(ServerConfig.ServerConfig, { ...config, host })),
            ),
          ),
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("streams authoritative removal snapshots without credentials", () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture;
      yield* Effect.gen(function* () {
        const catalog = yield* LocalConnections.LocalConnections;
        const grant = yield* catalog.replace(
          [entry],
          true,
          undefined,
          (yield* catalog.status).revision,
        );
        expect(yield* catalog.changes.pipe(Stream.take(1), Stream.runCollect)).toEqual([
          yield* catalog.snapshot,
        ]);
        yield* catalog.replace([], false, grant.grantId);
        expect(yield* catalog.changes.pipe(Stream.take(1), Stream.runCollect)).toEqual([
          { environments: [] },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects delayed syncs from a revoked/replaced consent epoch", () =>
    Effect.gen(function* () {
      const { layer } = yield* fixture;
      yield* Effect.gen(function* () {
        const catalog = yield* LocalConnections.LocalConnections;
        const old = yield* catalog.replace(
          [entry],
          true,
          undefined,
          (yield* catalog.status).revision,
        );
        yield* catalog.revoke;
        const current = yield* catalog.replace(
          [],
          true,
          undefined,
          (yield* catalog.status).revision,
        );
        expect(current.grantId).not.toBe(old.grantId);
        expect(yield* Effect.flip(catalog.replace([entry], false, old.grantId))).toBeDefined();
        expect(yield* catalog.snapshot).toEqual({ environments: [] });
        yield* catalog.replace([entry], false, current.grantId);
        expect((yield* catalog.snapshot).environments).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "compares explicit consent against a persistent revision, including disabled tombstones",
    () =>
      Effect.gen(function* () {
        const { layer } = yield* fixture;
        const revokedRevision = yield* Effect.gen(function* () {
          const catalog = yield* LocalConnections.LocalConnections;
          const initial = (yield* catalog.status).revision;
          expect(yield* Effect.flip(catalog.replace([entry], true))).toBeDefined();
          const enabled = yield* catalog.replace([], true, undefined, initial);
          expect(enabled.revision).not.toBe(initial);
          expect(
            yield* Effect.flip(catalog.replace([entry], true, undefined, initial)),
          ).toBeDefined();
          yield* catalog.revoke;
          const revoked = (yield* catalog.status).revision;
          expect(revoked).not.toBe(enabled.revision);
          expect(
            yield* Effect.flip(catalog.replace([entry], true, undefined, enabled.revision)),
          ).toBeDefined();
          expect(yield* catalog.snapshot).toEqual({ environments: [] });
          yield* catalog.revoke;
          const tombstone = yield* catalog.status;
          expect(tombstone.revision).not.toBe(revoked);
          expect(tombstone.enabled).toBe(false);
          return tombstone.revision;
        }).pipe(Effect.provide(layer));
        yield* Effect.gen(function* () {
          const catalog = yield* LocalConnections.LocalConnections;
          expect(yield* catalog.status).toEqual({
            enabled: false,
            grantId: null,
            revision: revokedRevision,
          });
          expect(
            yield* Effect.flip(catalog.replace([entry], true, undefined, "initial")),
          ).toBeDefined();
          yield* catalog.replace([entry], true, undefined, revokedRevision);
          expect(yield* catalog.resolve(entry.id)).toEqual(entry);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("disables only sharing when ciphertext is damaged, without discarding secrets", () =>
    Effect.gen(function* () {
      const { layer, secrets } = yield* fixture;
      secrets.bytes.set("local-connections", new Uint8Array([1, 2, 3]));
      yield* Effect.gen(function* () {
        const catalog = yield* LocalConnections.LocalConnections;
        expect(catalog.available).toBe(false);
        expect(yield* Effect.flip(catalog.snapshot)).toBeDefined();
        expect(secrets.bytes.get("local-connections")).toEqual(new Uint8Array([1, 2, 3]));
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("requires administrative read permission for every discovery/credential RPC", () => {
    for (const method of [
      WS_METHODS.localConnectionsGet,
      WS_METHODS.localConnectionsResolve,
      WS_METHODS.localConnectionsSubscribe,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthAccessReadScope);
  });

  it("checks actual peer, host and exact browser origin rather than forwarding headers", () => {
    const request = (host: string, peer: string, origin?: string, extraHeaders = {}) =>
      HttpServerRequest.fromWeb(
        new Request(`http://${host}/ws`, {
          headers: { host, ...(origin ? { origin } : {}), ...extraHeaders },
        }),
      ).modify({ remoteAddress: Option.some(peer) });
    expect(LocalConnections.isLocalConnectionsRequest(request("127.0.0.1:3773", "127.0.0.1"))).toBe(
      true,
    );
    expect(
      LocalConnections.isLocalConnectionsRequest(request("127.0.0.1:3773", "192.168.1.2")),
    ).toBe(false);
    expect(LocalConnections.isLocalConnectionsRequest(request("public.example", "127.0.0.1"))).toBe(
      false,
    );
    expect(LocalConnections.isLocalConnectionsRequest(request("[::1]:3773", "::1"))).toBe(true);
    expect(
      LocalConnections.isLocalConnectionsRequest(
        request("127.0.0.1:3773", "192.168.1.2", undefined, {
          "x-forwarded-for": "127.0.0.1",
        }),
      ),
    ).toBe(false);
    expect(
      LocalConnections.isLocalConnectionsRequest(
        request("127.0.0.1:3773", "127.0.0.1", "http://evil.example"),
      ),
    ).toBe(false);
    expect(
      LocalConnections.isLocalConnectionsRequest(
        request("127.0.0.1:3773", "127.0.0.1", "http://127.0.0.1:9999"),
      ),
    ).toBe(false);
    expect(
      LocalConnections.isLocalConnectionsRequest(
        request("127.0.0.1:3773", "127.0.0.1", "http://127.0.0.1:9999"),
        new URL("http://127.0.0.1:9999"),
      ),
    ).toBe(true);
  });
});
