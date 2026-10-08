// Cross-surface integration: load two independent browser modules against the real
// encrypted catalog service without changing either package's TypeScript project.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { LocalConnectionsEnable, LocalConnectionsStatus } from "@t3tools/contracts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@t3tools/client-runtime/platform";
import * as LocalConnections from "../src/connections/LocalConnections.ts";
import * as ServerConfig from "../src/config.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";

const document = Schema.decodeUnknownSync(ConnectionCatalogDocument)({
  ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
  targets: [
    { _tag: "BearerConnectionTarget", environmentId: "remote-a", connectionId: "a", label: "A" },
  ],
  profiles: [
    {
      _tag: "BearerConnectionProfile",
      environmentId: "remote-a",
      connectionId: "a",
      label: "A",
      httpBaseUrl: "https://remote-a.example",
      wsBaseUrl: "wss://remote-a.example",
    },
  ],
  credentials: [
    {
      connectionId: "a",
      credential: { _tag: "BearerConnectionCredential", token: "secret-for-a" },
    },
  ],
});
const decodeEnable = Schema.decodeEffect(Schema.fromJsonString(LocalConnectionsEnable));
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(LocalConnectionsStatus));
const realCatalogLayer = LocalConnections.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-two-tab-catalog-" })),
  Layer.provide(NodeServices.layer),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.effect("rejects a delayed enable after another independent browser tab revokes", () =>
  Effect.gen(function* () {
    const catalog = yield* LocalConnections.LocalConnections;
    const values = new Map();
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        location: { origin: "http://127.0.0.1:3773", href: "http://127.0.0.1:3773/" },
        localStorage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, value),
          removeItem: (key) => values.delete(key),
        },
      }),
    );
    const requests = yield* Queue.unbounded();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((respond) => {
            Queue.offerUnsafe(requests, { init, respond });
          }),
      ),
    );
    vi.resetModules();
    const tabA = yield* Effect.promise(() => import("../../web/src/connection/localSharing.ts"));
    vi.resetModules();
    const tabB = yield* Effect.promise(() => import("../../web/src/connection/localSharing.ts"));
    expect(tabA).not.toBe(tabB);
    tabA.catalogForLocalSharing(document);
    const enabling = tabA.setLocalSharing(true).then(
      () => "enabled",
      () => "rejected",
    );
    const read = yield* Queue.take(requests);
    expect(read.init.method).toBe("GET");
    read.respond(new Response(encodeStatus(yield* catalog.status)));
    const delayedEnable = yield* Queue.take(requests);
    expect(delayedEnable.init.method).toBe("PUT");
    const input = yield* decodeEnable(String(delayedEnable.init.body));
    const revoking = tabB.setLocalSharing(false);
    const revoke = yield* Queue.take(requests);
    expect(revoke.init.method).toBe("DELETE");
    yield* catalog.revoke;
    revoke.respond(new Response(null, { status: 204 }));
    yield* Effect.promise(() => revoking);
    const disabled = yield* catalog.status;
    expect(disabled.enabled).toBe(false);
    expect(disabled.revision).not.toBe(input.expectedRevision);
    // Deliver A's already-submitted PUT only after B's independent queue has
    // completed DELETE, using the real service rather than a mock CAS.
    expect(
      yield* Effect.flip(
        catalog.replace(input.environments, true, undefined, input.expectedRevision),
      ),
    ).toBeDefined();
    delayedEnable.respond(new Response(null, { status: 403 }));
    expect(yield* Effect.promise(() => enabling)).toBe("rejected");
    expect(yield* catalog.status).toEqual(disabled);
    expect(yield* catalog.snapshot).toEqual({ environments: [] });
    expect(yield* Effect.flip(catalog.resolve("remote-a"))).toBeDefined();
    expect(window.localStorage.getItem("t3code:local-sharing:http://127.0.0.1:3773")).toBeNull();
  }).pipe(Effect.provide(realCatalogLayer)),
);
