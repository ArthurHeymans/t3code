// @effect-diagnostics nodeBuiltinImport:off
import { HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { LocalConnectionSecret, LocalConnectionsSnapshot } from "@t3tools/contracts";

export class EnvironmentGatewayError extends Schema.TaggedError<EnvironmentGatewayError>()(
  "EnvironmentGatewayError",
  { message: Schema.String },
) {}
const error = () =>
  new EnvironmentGatewayError({
    message:
      "Cannot attach or send to this environment; refresh the shared catalog and use a newer generation.",
  });
const Json = Schema.fromJsonString(Schema.Unknown);
const encode = Schema.encodeSync(Json);
const decode = Schema.decodeUnknownSync(Json);
const MAX_RECORD = 900_000;
const MAX_CHILDREN = 8;
const MAX_IDENTITIES = 64;
const AttachInput = Schema.Struct({
  environmentId: Schema.String,
  clientEnvironmentId: Schema.String,
  generation: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
});
export const EnvironmentAttachInput = AttachInput;
export const EnvironmentDetachInput = Schema.Struct({ clientEnvironmentId: Schema.String });
export const EnvironmentSendMessage = Schema.Struct({
  kind: Schema.Literal("environment.send"),
  environmentId: Schema.String,
  message: Schema.Unknown,
});

export function environmentBridgeArgv(
  isExecutable: boolean,
  entryPath: string,
  execArgv: ReadonlyArray<string>,
): string[] {
  if (isExecutable) return ["client", "--stdio"];
  const flags: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const flag = execArgv[index]!;
    if (["--watch-path", "--watch-kill-signal", "--inspect-port"].includes(flag)) {
      index += 1;
      continue;
    }
    if (flag.startsWith("--watch") || flag.startsWith("--inspect")) continue;
    flags.push(flag);
  }
  return [...flags, entryPath, "client", "--stdio"];
}

interface Attachment {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly entry: LocalConnectionSecret;
  readonly generation: number;
}

/** Adapter boundary: only the authenticated parent resolves a stored id to a destination. */
export const makeEnvironmentGateway = Effect.fn("EnvironmentGateway.make")(function* (
  resolve: (id: string) => Effect.Effect<LocalConnectionSecret, EnvironmentGatewayError>,
  write: (record: unknown) => Effect.Effect<void, EnvironmentGatewayError>,
) {
  const childArgv = environmentBridgeArgv(
    yield* HostProcessIsExecutable,
    process.argv[1]!,
    process.execArgv,
  );
  const attachments = new Map<string, Attachment>();
  const generations = new Map<string, number>();
  let catalog: LocalConnectionsSnapshot = { environments: [] };
  const scope = yield* Effect.service(Scope.Scope);
  const stop = (id: string) => {
    const attachment = attachments.get(id);
    attachments.delete(id);
    attachment?.child.kill("SIGKILL");
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const id of attachments.keys()) stop(id);
    }),
  );
  const wrapped = (id: string, attachment: Attachment, message: unknown) =>
    write({
      kind: "environment.message",
      environmentId: id,
      generation: attachment.generation,
      message,
    });
  const fatal = (id: string, attachment: Attachment) =>
    wrapped(id, attachment, {
      kind: "fatal",
      code: "environment-disconnected",
      message: "Shared environment disconnected or is no longer available.",
    });
  const attach = Effect.fn("EnvironmentGateway.attach")(function* (input: typeof AttachInput.Type) {
    if (
      process.env.T3_CLIENT_INTERNAL_CHILD === "1" ||
      !input.clientEnvironmentId ||
      input.clientEnvironmentId.length > 200
    )
      return yield* error();
    const previous = attachments.get(input.clientEnvironmentId);
    if (previous?.generation === input.generation && previous.entry.id === input.environmentId)
      return { attached: true };
    if (!generations.has(input.clientEnvironmentId) && generations.size >= MAX_IDENTITIES)
      return yield* error();
    if (
      input.generation <= (generations.get(input.clientEnvironmentId) ?? -1) ||
      (attachments.size >= MAX_CHILDREN && previous === undefined)
    )
      return yield* error();
    const entry = yield* resolve(input.environmentId).pipe(Effect.mapError(error));
    if (
      !catalog.environments.some(
        (candidate) =>
          candidate.id === entry.id &&
          candidate.enabled !== false &&
          candidate.endpoint === entry.endpoint,
      )
    )
      return yield* error();
    // Resolve completes before replacing a healthy existing attachment.
    stop(input.clientEnvironmentId);
    const child = yield* Effect.try({
      try: () =>
        NodeChildProcess.spawn(process.execPath, childArgv, {
          env: {
            ...process.env,
            T3_CLIENT_ACCESS_TOKEN: entry.token,
            T3_CLIENT_PAIRING_TOKEN: "",
            T3_CLIENT_INTERNAL_CHILD: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        }),
      catch: error,
    });
    const attachment: Attachment = { child, entry, generation: input.generation };
    attachments.set(input.clientEnvironmentId, attachment);
    generations.set(input.clientEnvironmentId, input.generation);
    // Never relay stderr: provider/server diagnostics may contain credentials.
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.on("error", () => child.stdout.destroy());
    child.stdin.on("error", () => child.stdout.destroy());
    const relay = Effect.tryPromise({
      try: async (signal) => {
        const onAbort = () => child.kill("SIGKILL");
        signal.addEventListener("abort", onAbort, { once: true });
        let pending = "";
        try {
          for await (const chunk of child.stdout) {
            pending += String(chunk);
            if (Buffer.byteLength(pending) > 2 * MAX_RECORD) throw error();
            let newline: number;
            while ((newline = pending.indexOf("\n")) !== -1) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (Buffer.byteLength(line) > MAX_RECORD - 1024) throw error();
              if (!line.trim()) continue;
              if (line.includes(entry.token)) throw error();
              const record = decode(line);
              if (attachments.get(input.clientEnvironmentId) !== attachment) return;
              await Effect.runPromise(wrapped(input.clientEnvironmentId, attachment, record), {
                signal,
              });
            }
            if (Buffer.byteLength(pending) > MAX_RECORD) throw error();
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
      catch: error,
    }).pipe(
      Effect.ignore,
      Effect.andThen(
        Effect.suspend(() => {
          if (attachments.get(input.clientEnvironmentId) !== attachment) return Effect.void;
          stop(input.clientEnvironmentId);
          return fatal(input.clientEnvironmentId, attachment).pipe(Effect.ignore);
        }),
      ),
    );
    yield* relay.pipe(Effect.forkIn(scope));
    const hello = encode({
      kind: "hello",
      protocolVersion: 1,
      client: { name: "t3-local-gateway", version: "1" },
      environment: {
        id: input.clientEnvironmentId,
        endpoint: entry.endpoint,
        generation: input.generation,
      },
    });
    yield* Effect.try({ try: () => child.stdin.write(`${hello}\n`), catch: error });
    return { attached: true };
  });
  const send = Effect.fn("EnvironmentGateway.send")(function* (id: string, message: unknown) {
    const attachment = attachments.get(id);
    if (
      attachment === undefined ||
      typeof message !== "object" ||
      message === null ||
      !("kind" in message) ||
      !["request", "cancel", "subscribe", "unsubscribe"].includes(String(message.kind))
    )
      return yield* error();
    if ("operation" in message && String(message.operation).startsWith("environment."))
      return yield* error();
    const record = encode(message);
    if (Buffer.byteLength(record) > MAX_RECORD) return yield* error();
    yield* Effect.callback<void, EnvironmentGatewayError>((resume) => {
      attachment.child.stdin.write(`${record}\n`, (cause) =>
        resume(cause ? Effect.fail(error()) : Effect.void),
      );
    });
  });
  const reconcile = Effect.fn("EnvironmentGateway.reconcile")(function* (
    snapshot: LocalConnectionsSnapshot,
  ) {
    catalog = snapshot;
    for (const [id, attachment] of attachments) {
      const entry = snapshot.environments.find(
        (entry) => entry.id === attachment.entry.id && entry.enabled !== false,
      );
      const credential =
        entry === undefined
          ? null
          : yield* resolve(entry.id).pipe(Effect.orElseSucceed(() => null));
      if (attachments.get(id) !== attachment) continue;
      if (
        entry === undefined ||
        entry.endpoint !== attachment.entry.endpoint ||
        credential?.token !== attachment.entry.token
      ) {
        stop(id);
        yield* fatal(id, attachment).pipe(Effect.ignore);
      }
    }
  });
  return {
    attach,
    send,
    reconcile,
    detach: (id: string) =>
      Effect.sync(() => {
        stop(id);
        return { detached: true };
      }),
  };
});
