import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t3tools/contracts";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  ConnectionCatalogDocument,
} from "@t3tools/client-runtime/platform";

const primary = vi.hoisted(() => ({ endpoint: "http://127.0.0.1:3773/api/local-connections" }));
vi.mock("../environments/primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: () => primary.endpoint,
}));
vi.mock("../environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: async () => null,
}));
const decode = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const document = decode({
  ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
  targets: [
    { _tag: "BearerConnectionTarget", environmentId: "remote-a", connectionId: "a", label: "A" },
    { _tag: "BearerConnectionTarget", environmentId: "disabled-b", connectionId: "b", label: "B" },
    {
      _tag: "BearerConnectionTarget",
      environmentId: "primary",
      connectionId: "primary",
      label: "Primary",
    },
    { _tag: "RelayConnectionTarget", environmentId: "relay", label: "Relay" },
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
    {
      _tag: "BearerConnectionProfile",
      environmentId: "disabled-b",
      connectionId: "b",
      label: "B",
      httpBaseUrl: "https://remote-b.example",
      wsBaseUrl: "wss://remote-b.example",
    },
    {
      _tag: "BearerConnectionProfile",
      environmentId: "primary",
      connectionId: "primary",
      label: "Primary",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
    },
  ],
  credentials: [
    { connectionId: "a", credential: { _tag: "BearerConnectionCredential", token: "secret-a" } },
    { connectionId: "b", credential: { _tag: "BearerConnectionCredential", token: "secret-b" } },
    {
      connectionId: "primary",
      credential: { _tag: "BearerConnectionCredential", token: "primary-bootstrap-secret" },
    },
  ],
  disabledEnvironmentIds: ["disabled-b"],
  // Not a bearer target; this deliberately secret-rich value must never be copied.
});
const wire = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resume) => {
    resolve = resume;
  });
  return { promise, resolve };
}
const changed = () =>
  new Promise<void>((resolve) =>
    window.addEventListener("t3code:local-sharing-changed", () => resolve(), { once: true }),
  );

beforeEach(() => {
  vi.resetModules();
  primary.endpoint = "http://127.0.0.1:3773/api/local-connections";
  const values = new Map<string, string>();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      location: { origin: "http://127.0.0.1:3773" },
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser local connection sharing", () => {
  it("requires explicit opt-in, copies only enabled destination-bound bearer entries, syncs updates and revokes", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          init.method === "GET"
            ? '{"enabled":false,"grantId":null,"revision":"initial"}'
            : init.method === "PUT"
              ? '{"grantId":"epoch-1"}'
              : null,
          {
            status: ["GET", "PUT"].includes(init.method!) ? 200 : 204,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sharing = await import("./localSharing");
    // Even unknown extra fields from future catalogs must not be sent wholesale.
    sharing.catalogForLocalSharing({
      ...document,
      remoteDpopTokens: [{ token: "relay-dpop-secret" }],
    } as unknown as ConnectionCatalogDocument);
    await sharing.localSharingStatus();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["GET"]);
    await sharing.setLocalSharing(true);
    const put = fetchMock.mock.calls.find(([, init]) => init.method === "PUT")!;
    expect(wire(put[1].body)).toEqual({
      expectedRevision: "initial",
      environments: [
        {
          id: "remote-a",
          label: "A",
          endpoint: "https://remote-a.example",
          enabled: true,
          token: "secret-a",
        },
      ],
    });
    expect(put[1]).toMatchObject({ credentials: "same-origin", redirect: "error" });
    expect(String(put[1].body)).not.toContain("relay-dpop-secret");
    expect(String(put[1].body)).not.toContain("primary-bootstrap-secret");
    expect(String(put[1].body)).not.toContain("secret-b");
    const synced = changed();
    sharing.catalogForLocalSharing({
      ...document,
      disabledEnvironmentIds: [EnvironmentId.make("remote-a"), EnvironmentId.make("disabled-b")],
    });
    await synced;
    expect(wire(fetchMock.mock.calls.at(-1)![1].body)).toEqual({
      environments: [],
      grantId: "epoch-1",
    });
    await sharing.setLocalSharing(false);
    expect(fetchMock.mock.calls.at(-1)![1].method).toBe("DELETE");
    const count = fetchMock.mock.calls.length;
    sharing.catalogForLocalSharing(document);
    await sharing.localSharingStatus();
    expect(fetchMock.mock.calls.slice(count).map(([, init]) => init.method)).toEqual(["GET"]);
  });

  it("never sends entries to remote or mismatched primary origins", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sharing = await import("./localSharing");
    sharing.catalogForLocalSharing(document);
    for (const endpoint of [
      "https://arbitrary.example/api/local-connections",
      "http://localhost:3774/api/local-connections",
    ]) {
      primary.endpoint = endpoint;
      expect(await sharing.localSharingStatus()).toMatchObject({ available: false });
      await expect(sharing.setLocalSharing(true)).rejects.toThrow("unavailable");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revocation gates queued syncs and sharing failures never fail browser catalog persistence", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          init.method === "GET"
            ? '{"enabled":false,"grantId":null,"revision":"initial"}'
            : init.method === "PUT"
              ? '{"grantId":"epoch-1"}'
              : null,
          {
            status:
              init.method === "POST" ? 403 : ["GET", "PUT"].includes(init.method!) ? 200 : 204,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sharing = await import("./localSharing");
    sharing.catalogForLocalSharing(document);
    await sharing.setLocalSharing(true);
    const sync = changed();
    expect(() => sharing.catalogForLocalSharing(document)).not.toThrow();
    await sync;
    sharing.catalogForLocalSharing(document);
    await sharing.setLocalSharing(false);
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual([
      "GET",
      "PUT",
      "POST",
      "DELETE",
    ]);
    expect(window.localStorage.getItem("t3code:local-sharing:http://127.0.0.1:3773")).toBeNull();
  });
  effectIt.effect(
    "keeps actual catalog writes successful when opted-in synchronization fails",
    () =>
      Effect.gen(function* () {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
        window.localStorage.setItem("t3code:local-sharing:http://127.0.0.1:3773", "old-epoch");
        const { makeCatalogStore } = yield* Effect.promise(() => import("./storage"));
        const writes: string[] = [];
        const store = yield* makeCatalogStore({
          read: Effect.succeed(encodeCatalog(document)),
          write: (raw) =>
            Effect.sync(() => {
              writes.push(raw);
            }),
        });
        yield* store.update((catalog) => ({ ...catalog, targets: [] }));
        expect((yield* store.read).targets).toEqual([]);
        expect(writes).toHaveLength(1);
      }),
  );

  it("does not mistake another browser's server grant for this browser opting in", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"enabled":true,"grantId":"server-epoch","revision":"current"}'),
        ),
    );
    const sharing = await import("./localSharing");
    expect(await sharing.localSharingStatus()).toMatchObject({
      enabled: false,
      serverEnabled: true,
      needsReenable: true,
    });
    window.localStorage.setItem("t3code:local-sharing:http://127.0.0.1:3773", "old-epoch");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"enabled":true,"grantId":"server-epoch","revision":"current"}'),
        ),
    );
    expect(await sharing.localSharingStatus()).toMatchObject({
      enabled: false,
      needsReenable: true,
    });
    window.localStorage.setItem("t3code:local-sharing:http://127.0.0.1:3773", "server-epoch");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"enabled":true,"grantId":"server-epoch","revision":"current"}'),
        ),
    );
    expect(await sharing.localSharingStatus()).toMatchObject({
      enabled: true,
      needsReenable: false,
    });
  });

  it("reconciles removal during an in-flight enable using the newly issued epoch", async () => {
    const put = deferred<Response>();
    const started = deferred<void>();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        started.resolve(undefined);
        return put.promise;
      }
      return new Response(
        init.method === "GET" ? '{"enabled":false,"grantId":null,"revision":"initial"}' : null,
        { status: init.method === "GET" ? 200 : 204 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const sharing = await import("./localSharing");
    sharing.catalogForLocalSharing(document);
    const enabled = sharing.setLocalSharing(true);
    await started.promise;
    sharing.catalogForLocalSharing({ ...document, targets: [] });
    put.resolve(new Response('{"grantId":"new-epoch"}'));
    await enabled;
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "PUT", "POST"]);
    expect(wire(fetchMock.mock.calls.at(-1)![1].body)).toEqual({
      environments: [],
      grantId: "new-epoch",
    });
  });

  it("lets revoke win over an in-flight enable without syncing the pending catalog", async () => {
    const put = deferred<Response>();
    const started = deferred<void>();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        started.resolve(undefined);
        return put.promise;
      }
      return new Response(
        init.method === "GET" ? '{"enabled":false,"grantId":null,"revision":"initial"}' : null,
        { status: init.method === "GET" ? 200 : 204 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const sharing = await import("./localSharing");
    sharing.catalogForLocalSharing(document);
    const enabled = sharing.setLocalSharing(true);
    await started.promise;
    sharing.catalogForLocalSharing({ ...document, targets: [] });
    const revoked = sharing.setLocalSharing(false);
    put.resolve(new Response('{"grantId":"new-epoch"}'));
    await Promise.all([enabled, revoked]);
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "PUT", "DELETE"]);
    expect(window.localStorage.getItem("t3code:local-sharing:http://127.0.0.1:3773")).toBeNull();
  });
});
