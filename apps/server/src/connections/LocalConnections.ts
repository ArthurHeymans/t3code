import * as NodeCrypto from "node:crypto";
import {
  LocalConnectionsError,
  LocalConnectionsWrite,
  type LocalConnectionSecret,
  type LocalConnectionsSnapshot,
  isLocalConnectionsEndpoint,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const Document = Schema.Struct({
  enabled: Schema.Boolean,
  // Old catalogs and a never-written catalog have the same stable initial revision.
  revision: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("initial"))),
  grantId: Schema.optionalKey(Schema.String),
  ...LocalConnectionsWrite.fields,
});
const DocumentJson = Schema.fromJsonString(Document);
const decode = Schema.decodeUnknownSync(DocumentJson);
const encode = Schema.encodeSync(DocumentJson);
const decodeWrite = Schema.decodeUnknownEffect(LocalConnectionsWrite);
const failure = () =>
  new LocalConnectionsError({
    message: "Local connection sharing is unavailable or the entry is no longer shared.",
  });

/** No forwarded headers: a tunnel/proxy's public origin is not a local trust grant. */
export function isLocalConnectionsRequest(
  request: HttpServerRequest.HttpServerRequest,
  devUrl?: URL,
): boolean {
  const url = HttpServerRequest.toURL(request);
  const address = Option.getOrNull(request.remoteAddress);
  const origin = request.headers.origin;
  const allowedOrigin = Option.isSome(url) ? url.value.origin : null;
  return (
    Option.isSome(url) &&
    isLocalConnectionsEndpoint(url.value.toString()) &&
    (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") &&
    (origin === undefined ||
      origin === allowedOrigin ||
      (devUrl !== undefined &&
        isLocalConnectionsEndpoint(devUrl.toString()) &&
        origin === devUrl.origin) ||
      origin === "t3code://app" ||
      origin === "t3code-dev://app")
  );
}

export class LocalConnections extends Context.Service<
  LocalConnections,
  {
    readonly available: boolean;
    readonly status: Effect.Effect<
      { enabled: boolean; grantId: string | null; revision: string },
      LocalConnectionsError
    >;
    readonly snapshot: Effect.Effect<LocalConnectionsSnapshot, LocalConnectionsError>;
    readonly changes: Stream.Stream<LocalConnectionsSnapshot, LocalConnectionsError>;
    readonly replace: (
      entries: ReadonlyArray<LocalConnectionSecret>,
      enable: boolean,
      grantId?: string,
      expectedRevision?: string,
    ) => Effect.Effect<{ grantId: string; revision: string }, LocalConnectionsError>;
    readonly revoke: Effect.Effect<void, LocalConnectionsError>;
    readonly resolve: (id: string) => Effect.Effect<LocalConnectionSecret, LocalConnectionsError>;
  }
>()("t3/connections/LocalConnections") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  // HTTP and RPC authorize the actual connection, not the server's listen address.
  const loaded = yield* Effect.gen(function* () {
    const key = yield* secrets
      .getOrCreateRandom("local-connections-key", 32)
      .pipe(Effect.mapError(failure));
    const raw = yield* secrets.get("local-connections").pipe(Effect.mapError(failure));
    const document = yield* Effect.try({
      try: () => {
        if (Option.isNone(raw)) return { enabled: false, revision: "initial", environments: [] };
        const bytes = Buffer.from(raw.value);
        const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return decode(
          Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
        );
      },
      catch: failure,
    });
    return { key, document };
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning(
        "Local connection sharing is unavailable; the encrypted catalog could not be loaded.",
      ).pipe(
        Effect.as({
          key: undefined,
          document: { enabled: false, revision: "initial", environments: [] },
        }),
      ),
    ),
  );
  const available = loaded.key !== undefined;
  const guard = available ? Effect.void : Effect.fail(failure());
  const state = yield* SubscriptionRef.make<typeof Document.Type>(loaded.document);
  const lock = yield* Semaphore.make(1);
  const metadata = (document: typeof Document.Type): LocalConnectionsSnapshot => ({
    environments:
      document.enabled && document.grantId !== undefined
        ? document.environments.map(({ id, label, endpoint, enabled }) => ({
            id,
            label,
            endpoint,
            ...(enabled === undefined ? {} : { enabled }),
          }))
        : [],
  });
  const save = Effect.fn("LocalConnections.save")(function* (document: typeof Document.Type) {
    const encrypted = yield* Effect.try({
      try: () => {
        const iv = NodeCrypto.randomBytes(12);
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", loaded.key!, iv);
        const body = Buffer.concat([cipher.update(encode(document), "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]);
      },
      catch: failure,
    });
    yield* secrets.set("local-connections", encrypted).pipe(Effect.mapError(failure));
    yield* SubscriptionRef.set(state, document);
  });
  const replace = Effect.fn("LocalConnections.replace")(function* (
    entries: ReadonlyArray<LocalConnectionSecret>,
    enable: boolean,
    grantId?: string,
    expectedRevision?: string,
  ) {
    yield* guard;
    const validated = yield* decodeWrite({ environments: entries }).pipe(Effect.mapError(failure));
    const ids = new Set(validated.environments.map((entry) => entry.id));
    if (ids.size !== validated.environments.length) return yield* failure();
    for (const entry of validated.environments) {
      const valid = yield* Effect.try({
        try: () => {
          const url = new URL(entry.endpoint);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        },
        catch: failure,
      });
      if (!valid || entry.enabled === false) return yield* failure();
    }
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        // Both explicit consent and background sync are conditional. A delayed PUT
        // cannot replace a newer consent or a persisted revocation tombstone.
        if (enable && expectedRevision !== current.revision) return yield* failure();
        if (!enable && (!current.enabled || !grantId || grantId !== current.grantId))
          return yield* failure();
        const nextGrantId = enable ? NodeCrypto.randomUUID() : grantId!;
        const revision = enable ? NodeCrypto.randomUUID() : current.revision;
        yield* save({
          enabled: true,
          grantId: nextGrantId,
          revision,
          environments: validated.environments,
        });
        return { grantId: nextGrantId, revision };
      }),
    );
  });
  return LocalConnections.of({
    available,
    status: guard.pipe(
      Effect.andThen(SubscriptionRef.get(state)),
      Effect.map(({ enabled, grantId, revision }) => ({
        enabled: enabled && grantId !== undefined,
        grantId: grantId ?? null,
        revision,
      })),
    ),
    snapshot: guard.pipe(Effect.andThen(SubscriptionRef.get(state)), Effect.map(metadata)),
    changes: Stream.unwrap(
      guard.pipe(Effect.as(SubscriptionRef.changes(state).pipe(Stream.map(metadata)))),
    ),
    replace,
    revoke: guard.pipe(
      Effect.andThen(
        lock.withPermits(1)(
          Effect.suspend(() =>
            save({ enabled: false, revision: NodeCrypto.randomUUID(), environments: [] }),
          ),
        ),
      ),
    ),
    resolve: (id) =>
      guard.pipe(
        Effect.andThen(SubscriptionRef.get(state)),
        Effect.flatMap((document) => {
          const entry =
            document.enabled && document.grantId !== undefined
              ? document.environments.find((entry) => entry.id === id && entry.enabled !== false)
              : undefined;
          return entry === undefined ? Effect.fail(failure()) : Effect.succeed(entry);
        }),
      ),
  });
});
export const layer = Layer.effect(LocalConnections, make);
