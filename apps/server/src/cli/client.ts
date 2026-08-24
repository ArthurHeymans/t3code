import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as RpcSession from "@t3tools/client-runtime/rpc";
import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "@t3tools/client-runtime/authorization";
import {
  BearerConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { fetchEnvironmentShellSnapshot } from "@t3tools/client-runtime/state/shell-snapshot-http";
import { fetchEnvironmentBoundedThreadSnapshot } from "@t3tools/client-runtime/state/bounded-thread-snapshot-http";
import {
  applyShellStreamEvent,
  mergeShellSnapshotProjects,
} from "@t3tools/client-runtime/state/shell-reducer";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  ExecutionEnvironmentDescriptor,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  type ServerConfig,
  type OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import * as NodeStream from "node:stream";
import packageJson from "../../package.json" with { type: "json" };

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OUTPUT_LINE_BYTES = 900_000;
const MAX_ERROR_CHARS = 1000;
const MAX_SHELL_PROJECTS = 50;
const MAX_SHELL_THREADS = 500;
const MAX_DISPLAY_CHARS = 500;
const MAX_THREAD_ITEMS = 100;
const MAX_THREAD_TEXT_CHARS = 256_000;
const MAX_ITEM_TEXT_CHARS = 32_000;

const HelloMessage = Schema.Struct({
  kind: Schema.Literal("hello"),
  protocolVersion: Schema.Number,
  client: Schema.Struct({ name: Schema.String, version: Schema.String }),
  environment: Schema.Struct({
    id: Schema.String,
    endpoint: Schema.String,
    generation: NonNegativeInt,
  }),
});

const RequestMessage = Schema.Struct({
  kind: Schema.Literal("request"),
  id: Schema.String,
  operation: Schema.String,
  input: Schema.Unknown,
});

const ThreadMutationBase = {
  threadId: ThreadId,
  commandId: CommandId,
} as const;

const ThreadSendInput = Schema.Struct({
  ...ThreadMutationBase,
  messageId: MessageId,
  text: Schema.String,
  dispatchMode: Schema.Literals(["auto", "queue", "steer", "restart", "start"]),
});

const ThreadInterruptInput = Schema.Struct(ThreadMutationBase);
const ThreadApprovalInput = Schema.Struct({
  ...ThreadMutationBase,
  requestId: RuntimeRequestId,
  decision: ProviderApprovalDecision,
});
const ThreadRuntimeModeInput = Schema.Struct({ ...ThreadMutationBase, runtimeMode: RuntimeMode });
const ThreadInteractionModeInput = Schema.Struct({
  ...ThreadMutationBase,
  interactionMode: ProviderInteractionMode,
});
const ThreadSettledInput = Schema.Struct({ ...ThreadMutationBase, settled: Schema.Boolean });
const ThreadSnoozeInput = Schema.Struct({
  ...ThreadMutationBase,
  snoozedUntil: Schema.NullOr(IsoDateTime),
});

const decodeThreadSendInput = Schema.decodeUnknownEffect(ThreadSendInput);
const decodeThreadInterruptInput = Schema.decodeUnknownEffect(ThreadInterruptInput);
const decodeThreadApprovalInput = Schema.decodeUnknownEffect(ThreadApprovalInput);
const decodeThreadRuntimeModeInput = Schema.decodeUnknownEffect(ThreadRuntimeModeInput);
const decodeThreadInteractionModeInput = Schema.decodeUnknownEffect(ThreadInteractionModeInput);
const decodeThreadSettledInput = Schema.decodeUnknownEffect(ThreadSettledInput);
const decodeThreadSnoozeInput = Schema.decodeUnknownEffect(ThreadSnoozeInput);

const CancelMessage = Schema.Struct({
  kind: Schema.Literal("cancel"),
  id: Schema.String,
});

const SubscribeMessage = Schema.Struct({
  kind: Schema.Literal("subscribe"),
  subscriptionId: Schema.String,
  stream: Schema.String,
  identity: Schema.Unknown,
  resumeSequence: Schema.optionalKey(NonNegativeInt),
});

const UnsubscribeMessage = Schema.Struct({
  kind: Schema.Literal("unsubscribe"),
  subscriptionId: Schema.String,
});

const ClientMessage = Schema.Union([
  HelloMessage,
  RequestMessage,
  CancelMessage,
  SubscribeMessage,
  UnsubscribeMessage,
]);
type ClientMessage = typeof ClientMessage.Type;

const decodeClientMessage = Schema.decodeUnknownEffect(ClientMessage);
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);

class ClientBridgeError extends Schema.TaggedErrorClass<ClientBridgeError>()("ClientBridgeError", {
  code: Schema.String,
  message: Schema.String,
}) {}

interface BridgeConnection {
  readonly clientEnvironmentId: string;
  readonly generation: number;
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
  readonly config: ServerConfig;
}

export const socketUrlSecrets = (socketUrl: string): ReadonlyArray<string> => {
  const ticket = URL.parse(socketUrl)?.searchParams.get("wsTicket");
  return ticket === null || ticket === undefined || ticket.length === 0 ? [] : [ticket];
};

const preparedSecrets = (prepared: PreparedConnection): ReadonlyArray<string> => {
  const authorization = prepared.httpAuthorization;
  const authorizationSecrets: string[] = [];
  if (authorization?._tag === "Bearer") authorizationSecrets.push(authorization.token);
  if (authorization?._tag === "Dpop") authorizationSecrets.push(authorization.accessToken);
  return [...authorizationSecrets, ...socketUrlSecrets(prepared.socketUrl)];
};

interface NormalizedShellThread {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly provider: string;
  readonly model: string;
  readonly worktree: string;
  readonly path: string;
  readonly settled: boolean;
  readonly parentThreadId: string | null;
  readonly relationshipToParent: "fork" | "subagent" | null;
  readonly additions: number;
  readonly deletions: number;
}

interface NormalizedShellProject {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly threads: ReadonlyArray<NormalizedShellThread>;
}

interface NormalizedShellPayload {
  readonly projects: ReadonlyArray<NormalizedShellProject>;
  truncated: boolean;
}

interface NormalizedThreadItem {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly label: string;
  readonly title: string | null;
  readonly text: string | null;
  readonly detail: string | null;
  readonly streaming: boolean;
  readonly actionId: string | null;
}

interface NormalizedThreadPayload {
  readonly thread: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly provider: string;
    readonly model: string;
    readonly worktree: string;
    readonly worktreePath: string | null;
    readonly runtimeMode: string;
    readonly interactionMode: string;
    readonly activeRunId: string | null;
  } | null;
  readonly items: ReadonlyArray<NormalizedThreadItem>;
  truncated: boolean;
  readonly deleted?: boolean;
  readonly error?: string;
}

export const safeErrorMessage = (cause: unknown, secrets: ReadonlyArray<string> = []): string => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((message, secret) => message.replaceAll(secret, "[redacted]"), raw)
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replaceAll(/(authorization:\s*(?:bearer|dpop)\s+)[^\s]+/gi, "$1[redacted]")
    .replaceAll(/([?&]wsTicket=)[^&\s]+/gi, "$1[redacted]")
    .replaceAll(/([?&]token=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, MAX_ERROR_CHARS);
};

const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};

const singleLine = (value: string, limit = MAX_DISPLAY_CHARS): string =>
  Array.from(value, (character) => (isControl(character) ? " " : character))
    .join("")
    .trim()
    .split(/\s+/u)
    .join(" ")
    .slice(0, limit);

const bodyText = (value: string, limit = MAX_ITEM_TEXT_CHARS): string =>
  Array.from(value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), (character) =>
    isControl(character) && character !== "\n" && character !== "\t" ? "" : character,
  )
    .join("")
    .slice(0, limit);

const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const writeRecord = (record: unknown): Effect.Effect<void, ClientBridgeError> => {
  const line = encodeJson(record);
  if (Buffer.byteLength(line, "utf8") > MAX_OUTPUT_LINE_BYTES) {
    return Effect.fail(
      fail("output-too-large", `Normalized output exceeds ${String(MAX_OUTPUT_LINE_BYTES)} bytes.`),
    );
  }
  return Effect.callback<void, ClientBridgeError>((resume) => {
    process.stdout.write(`${line}\n`, (error) => {
      resume(
        error === null || error === undefined
          ? Effect.void
          : Effect.fail(fail("stdout-failed", safeErrorMessage(error))),
      );
    });
  });
};

const fail = (code: string, message: string): ClientBridgeError =>
  new ClientBridgeError({ code, message });

export const superviseSubscription = <A, E, R>(
  attempt: Effect.Effect<A, E, R>,
  retryDelay: Duration.Input = "1 second",
): Effect.Effect<never, never, R> =>
  Effect.forever(
    attempt.pipe(
      Effect.catchCause(() => Effect.void),
      Effect.andThen(Effect.sleep(retryDelay)),
    ),
  );

const parseEndpoint = Effect.fn("clientBridge.parseEndpoint")(function* (endpoint: string) {
  const url = yield* decodeUrl(endpoint).pipe(
    Effect.mapError((cause) => fail("invalid-endpoint", safeErrorMessage(cause))),
  );
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return yield* fail("invalid-endpoint", "The environment endpoint must use HTTP or HTTPS.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return yield* fail("invalid-endpoint", "The environment endpoint must not contain userinfo.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  const httpBaseUrl = url.toString().replace(/\/$/, "");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  return { httpBaseUrl, wsBaseUrl: url.toString() };
});

const fetchEnvironmentDescriptor = Effect.fn("clientBridge.fetchEnvironmentDescriptor")(function* (
  httpBaseUrl: string,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(HttpClientRequest.get(`${httpBaseUrl}/.well-known/t3/environment`))
    .pipe(Effect.mapError((cause) => fail("environment-unreachable", safeErrorMessage(cause))));
  return yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
    Effect.mapError((cause) => fail("invalid-environment-descriptor", safeErrorMessage(cause))),
  );
});

const readAccessToken = Effect.fn("clientBridge.readAccessToken")(function* (httpBaseUrl: string) {
  const accessToken = process.env.T3_CLIENT_ACCESS_TOKEN?.trim();
  if (accessToken !== undefined && accessToken.length > 0) {
    process.env.T3_CLIENT_ACCESS_TOKEN = "";
    return accessToken;
  }
  const pairingToken = process.env.T3_CLIENT_PAIRING_TOKEN?.trim();
  if (pairingToken === undefined || pairingToken.length === 0) {
    return yield* fail(
      "authentication-required",
      "Set T3_CLIENT_PAIRING_TOKEN to a fresh pairing token or T3_CLIENT_ACCESS_TOKEN to a bearer token.",
    );
  }
  process.env.T3_CLIENT_PAIRING_TOKEN = "";
  const platform = yield* HostProcessPlatform;
  const result = yield* bootstrapRemoteBearerSession({
    httpBaseUrl,
    credential: pairingToken,
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    clientMetadata: {
      label: "t3-code.el",
      deviceType: "desktop",
      os: platform,
    },
  }).pipe(
    Effect.mapError((cause) =>
      fail("authentication-failed", safeErrorMessage(cause, [pairingToken])),
    ),
  );
  if (result.token_type !== "Bearer") {
    return yield* fail("authentication-failed", "The server did not issue a bearer token.");
  }
  return result.access_token;
});

const connect = Effect.fn("clientBridge.connect")(function* (message: typeof HelloMessage.Type) {
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    return yield* fail(
      "protocol-mismatch",
      `Expected protocol ${String(PROTOCOL_VERSION)}, received ${String(message.protocolVersion)}.`,
    );
  }
  const { httpBaseUrl, wsBaseUrl } = yield* parseEndpoint(message.environment.endpoint);
  const descriptor = yield* fetchEnvironmentDescriptor(httpBaseUrl);
  const bearerToken = yield* readAccessToken(httpBaseUrl);
  const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
    httpBaseUrl,
    wsBaseUrl,
    bearerToken,
  }).pipe(
    Effect.mapError((cause) =>
      fail("websocket-ticket-failed", safeErrorMessage(cause, [bearerToken])),
    ),
  );
  const target = new BearerConnectionTarget({
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    connectionId: "stdio-client",
  });
  const prepared: PreparedConnection = {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    httpBaseUrl,
    socketUrl,
    httpAuthorization: { _tag: "Bearer", token: bearerToken },
    target,
  };
  const sessions = yield* RpcSession.RpcSessionFactory;
  const session = yield* sessions
    .connect(prepared)
    .pipe(
      Effect.mapError((cause) => fail("connection-failed", safeErrorMessage(cause, [bearerToken]))),
    );
  yield* session.ready.pipe(
    Effect.mapError((cause) => fail("connection-failed", safeErrorMessage(cause, [bearerToken]))),
  );
  const config = yield* session.initialConfig.pipe(
    Effect.mapError((cause) => fail("config-failed", safeErrorMessage(cause, [bearerToken]))),
  );
  return {
    clientEnvironmentId: message.environment.id,
    generation: message.environment.generation,
    prepared,
    session,
    config,
  } satisfies BridgeConnection;
});

const normalizeThreadStatus = (thread: OrchestrationV2ShellSnapshot["threads"][number]): string => {
  if (thread.pendingRuntimeRequest !== null) return "waiting-approval";
  switch (thread.status) {
    case "running":
    case "failed":
    case "idle":
      return thread.status;
    default:
      return thread.activeRunId === null ? "idle" : "running";
  }
};

const optionalIso = (value: DateTime.Utc | null | undefined): string | null =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

const threadIsSettled = (
  thread: OrchestrationV2ShellSnapshot["threads"][number],
  now: string,
): boolean =>
  effectiveSettled(
    {
      createdAt: DateTime.formatIso(thread.createdAt),
      settledOverride: thread.settledOverride,
      settledAt: optionalIso(thread.settledAt),
      hasPendingApprovals: thread.pendingRuntimeRequest !== null,
      hasPendingUserInput: thread.pendingRuntimeRequest !== null,
      latestUserMessageAt: optionalIso(thread.latestUserMessageAt),
      latestRun: {
        requestedAt: optionalIso(thread.latestRunRequestedAt),
        startedAt: optionalIso(thread.latestRunStartedAt),
        completedAt: optionalIso(thread.latestRunCompletedAt),
      },
      session: null,
      runtime:
        thread.activeRunId === null && thread.activityRunStatus == null
          ? null
          : { status: thread.activityRunStatus ?? thread.status },
    },
    {
      now,
      autoSettleAfterDays: DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
      autoSettleOnMerge: true,
      changeRequest: null,
    },
  );

const shellThreadHasProjection = (
  thread: OrchestrationV2ShellSnapshot["threads"][number],
): boolean =>
  thread.lineage.rootThreadId === thread.id || thread.lineage.relationshipToParent !== null;

export const normalizeShellSnapshot = (
  snapshot: OrchestrationV2ShellSnapshot,
  now = DateTime.formatIso(DateTime.nowUnsafe()),
): NormalizedShellPayload => {
  let remainingThreads = MAX_SHELL_THREADS;
  const includedProjects = snapshot.projects.slice(0, MAX_SHELL_PROJECTS);
  const includedProjectIds = new Set(includedProjects.map((project) => project.id));
  const includedThreadCount = snapshot.threads.filter(
    (thread) => includedProjectIds.has(thread.projectId) && shellThreadHasProjection(thread),
  ).length;
  const payload: NormalizedShellPayload = {
    projects: includedProjects.map((project) => {
      const threads = snapshot.threads
        .filter((thread) => thread.projectId === project.id && shellThreadHasProjection(thread))
        .slice(0, remainingThreads)
        .map((thread) => ({
          id: thread.id,
          title: singleLine(thread.title),
          status: normalizeThreadStatus(thread),
          provider: singleLine(thread.providerInstanceId),
          model: singleLine(thread.modelSelection.model),
          worktree: singleLine(thread.worktreePath ?? "root"),
          path: singleLine(thread.worktreePath ?? project.workspaceRoot, 2_000),
          settled: threadIsSettled(thread, now),
          parentThreadId: thread.lineage.parentThreadId,
          relationshipToParent: thread.lineage.relationshipToParent,
          additions: 0,
          deletions: 0,
        }));
      remainingThreads -= threads.length;
      return {
        id: project.id,
        name: singleLine(project.repositoryIdentity?.displayName ?? project.title),
        root: singleLine(project.workspaceRoot, 2_000),
        threads,
      };
    }),
    truncated:
      snapshot.projects.length > includedProjects.length || includedThreadCount > MAX_SHELL_THREADS,
  };
  while (Buffer.byteLength(encodeJson(payload), "utf8") > 700_000) {
    payload.truncated = true;
    const project = payload.projects.findLast((candidate) => candidate.threads.length > 0);
    if (project !== undefined) {
      (project.threads as NormalizedShellThread[]).pop();
      continue;
    }
    (payload.projects as NormalizedShellProject[]).pop();
    if (payload.projects.length === 0) break;
  }
  return payload;
};

const clipText = (value: string | null | undefined, limit = MAX_ITEM_TEXT_CHARS) =>
  value === null || value === undefined ? null : bodyText(value, limit);

const clipUtf8Bytes = (value: string, limit: number): string => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= limit) return value;
  return encoded
    .subarray(0, limit)
    .toString("utf8")
    .replace(/\ufffd$/u, "");
};

const planStepMarker = (status: "pending" | "running" | "completed"): string => {
  switch (status) {
    case "completed":
      return "✓";
    case "running":
      return "●";
    case "pending":
      return "○";
  }
};

const normalizeTurnItem = (item: OrchestrationV2TurnItem): NormalizedThreadItem => {
  const base = (
    label: string,
    text: string | null = null,
    detail: string | null = null,
    title = item.title,
  ): NormalizedThreadItem => ({
    id: singleLine(item.id, 4_000),
    type: item.type,
    status: item.status,
    label: singleLine(label),
    title: title === null ? null : singleLine(title),
    text: clipText(text),
    detail: clipText(detail),
    streaming: "streaming" in item && item.streaming === true,
    actionId: null,
  });

  switch (item.type) {
    case "user_message":
      return base("You", item.text);
    case "assistant_message":
      return base("Assistant", item.text);
    case "reasoning":
      return base("Thinking", item.text);
    case "proposed_plan":
      return base("Plan", item.markdown);
    case "todo_list":
      return base(
        "Todo",
        item.explanation ?? null,
        item.steps.map((step) => `${planStepMarker(step.status)} ${step.text}`).join("\n"),
      );
    case "user_input_request":
      return {
        ...base(
          "Input needed",
          item.questions.map((question) => `${question.header}: ${question.question}`).join("\n"),
        ),
        actionId: item.requestId,
      };
    case "file_change":
      return base(
        "File change",
        item.fileName,
        item.diffStr ??
          (item.oldStr !== undefined || item.newStr !== undefined
            ? `--- before\n${item.oldStr ?? ""}\n+++ after\n${item.newStr ?? ""}`
            : null),
      );
    case "command_execution":
      return base("Command", item.input, item.output ?? null);
    case "file_search":
      return base(
        "File search",
        item.pattern ?? null,
        item.results
          ?.map(
            (result) =>
              `${result.fileName}${result.line === undefined ? "" : `:${String(result.line)}`}${result.preview === undefined ? "" : ` — ${result.preview}`}`,
          )
          .join("\n") ?? null,
      );
    case "web_search":
      return base(
        "Web search",
        item.patterns?.join(" · ") ?? null,
        item.results
          ?.map(
            (result) =>
              `${result.title ?? result.url ?? "Result"}${result.url === undefined ? "" : ` — ${result.url}`}`,
          )
          .join("\n") ?? null,
      );
    case "approval_request":
      return {
        ...base("Approval needed", item.prompt ?? item.requestKind),
        actionId: item.requestId,
      };
    case "checkpoint":
      return base("Checkpoint", null, item.files.map((file) => file.path).join("\n"));
    case "run_interrupt_request":
      return base("Interrupt requested", item.message);
    case "run_interrupt_result":
      return base("Interrupt result", item.message);
    case "error":
      return base("Error", item.failure.message, item.failure.code);
    case "compaction":
      return base("Compaction", item.summary ?? null);
    case "handoff":
      return base("Handoff", item.summary ?? item.strategy);
    case "fork":
      return base("Fork", `Created thread ${item.targetThreadId}`);
    case "thread_created":
      return base("Thread created", `${item.targetModel} · ${item.targetThreadId}`);
    case "subagent":
      return base("Agent", item.prompt, item.result ?? item.progress ?? null);
    case "dynamic_tool":
      // Arbitrary tool payloads may contain credentials. Keep them behind the
      // bridge boundary until a tool-specific safe presentation exists.
      return base(item.toolName === null ? "Tool" : `Tool · ${item.toolName}`);
    default: {
      const futureItem = item as { readonly type: string };
      return base("Activity", null, null, futureItem.type);
    }
  }
};

const normalizeProjectionStatus = (projection: OrchestrationV2ThreadProjection): string => {
  if (projection.runtimeRequests.some((request) => request.status === "pending")) {
    return "waiting-approval";
  }
  const latest = projection.runs.reduce<(typeof projection.runs)[number] | null>(
    (current, run) => (current === null || run.ordinal > current.ordinal ? run : current),
    null,
  );
  if (latest?.status === "failed") return "failed";
  if (
    latest !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(latest.status)
  ) {
    return "running";
  }
  return "idle";
};

export const normalizeThreadProjection = (
  projection: OrchestrationV2ThreadProjection,
): NormalizedThreadPayload => {
  const visible = projection.visibleTurnItems.slice(-MAX_THREAD_ITEMS);
  let remaining = MAX_THREAD_TEXT_CHARS;
  let clipped = projection.visibleTurnItems.length > visible.length;
  const items = visible
    .map((row) => normalizeTurnItem(row.item))
    .toReversed()
    .map((item) => {
      const take = (value: string | null): string | null => {
        if (value === null) return null;
        const encodedLength = Buffer.byteLength(value, "utf8");
        const result = clipUtf8Bytes(value, remaining);
        if (Buffer.byteLength(result, "utf8") < encodedLength) clipped = true;
        remaining -= Buffer.byteLength(result, "utf8");
        return result;
      };
      return { ...item, detail: take(item.detail), text: take(item.text) };
    })
    .toReversed();
  let payload: NormalizedThreadPayload = {
    thread: {
      id: singleLine(projection.thread.id, 4_000),
      title: singleLine(projection.thread.title),
      status: normalizeProjectionStatus(projection),
      provider: singleLine(projection.thread.providerInstanceId),
      model: singleLine(projection.thread.modelSelection.model),
      worktree: singleLine(projection.thread.worktreePath ?? "root"),
      worktreePath:
        projection.thread.worktreePath === null
          ? null
          : singleLine(projection.thread.worktreePath, 2_000),
      runtimeMode: projection.thread.runtimeMode,
      interactionMode: projection.thread.interactionMode,
      activeRunId:
        projection.runs.findLast((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        )?.id ?? null,
    },
    items,
    truncated: clipped,
  };
  while (Buffer.byteLength(encodeJson(payload), "utf8") > 700_000 && items.length > 0) {
    items.shift();
    payload.truncated = true;
  }
  return payload;
};

const deletedThreadPayload: NormalizedThreadPayload = {
  thread: null,
  items: [],
  truncated: false,
  deleted: true,
};

export const threadResumeInput = (threadId: typeof ThreadId.Type, snapshotSequence: number) => ({
  threadId,
  afterSequence: snapshotSequence,
  requestCompletionMarker: true as const,
  snapshotFallback: "error" as const,
});

export const reduceThreadProjection = (
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): {
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly payload: NormalizedThreadPayload | null;
} => {
  if (event.type === "thread.deleted") {
    return { projection: null, payload: deletedThreadPayload };
  }
  const next = applyOrchestrationV2ProjectionEvent(projection, event);
  return {
    projection: next,
    payload: next === null ? null : normalizeThreadProjection(next),
  };
};

const lineLimiter = (): NodeStream.Transform => {
  let pendingBytes = 0;
  return new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let start = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const lineBytes = pendingBytes + index - start;
        if (lineBytes > MAX_LINE_BYTES) {
          callback(new Error(`NDJSON line exceeds ${String(MAX_LINE_BYTES)} bytes.`));
          return;
        }
        pendingBytes = 0;
        start = index + 1;
      }
      pendingBytes += chunk.length - start;
      if (pendingBytes > MAX_LINE_BYTES) {
        callback(new Error(`NDJSON line exceeds ${String(MAX_LINE_BYTES)} bytes.`));
        return;
      }
      callback(null, chunk);
    },
  });
};

const stdioFlag = Flag.boolean("stdio").pipe(
  Flag.withDescription("Run the versioned NDJSON client bridge on stdin/stdout."),
  Flag.withDefault(false),
);

const runClientBridge = Effect.fn("clientBridge.run")(function* () {
  const connection = yield* Ref.make<BridgeConnection | null>(null);
  const subscriptions = yield* Ref.make(new Map<string, Fiber.Fiber<void, unknown>>());

  const stopSubscription = Effect.fn("clientBridge.stopSubscription")(function* (
    subscriptionId: string,
  ) {
    const current = yield* Ref.get(subscriptions);
    const fiber = current.get(subscriptionId);
    if (fiber === undefined) return;
    yield* Fiber.interrupt(fiber);
    yield* Ref.update(subscriptions, (value) => {
      const next = new Map(value);
      next.delete(subscriptionId);
      return next;
    });
  });

  const requireConnection = Effect.fn("clientBridge.requireConnection")(function* () {
    const current = yield* Ref.get(connection);
    if (current === null) {
      return yield* fail("not-ready", "Send hello before requests or subscriptions.");
    }
    return current;
  });

  const threadProjection = Effect.fn("clientBridge.threadProjection")(function* (
    current: BridgeConnection,
    threadId: typeof ThreadId.Type,
  ) {
    const snapshot = yield* fetchEnvironmentBoundedThreadSnapshot({
      prepared: current.prepared,
      threadId,
      signer: Option.none(),
    });
    return snapshot.projection;
  });

  const handleRequest = Effect.fn("clientBridge.handleRequest")(function* (
    current: BridgeConnection,
    message: typeof RequestMessage.Type,
  ) {
    const dispatch = current.session.client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand];
    switch (message.operation) {
      case "server.getConfig":
        return {
          serverVersion: current.config.environment.serverVersion,
          environment: current.config.environment,
          providers: current.config.providers,
          capabilities: {
            shell: true,
            threads: true,
            mutations: true,
            shellResumeCompletionMarker: current.config.shellResumeCompletionMarker === true,
            threadResumeCompletionMarker: current.config.threadResumeCompletionMarker === true,
            threadSnapshotPagination: current.config.threadSnapshotPagination === true,
          },
        };
      case "thread.send": {
        const input = yield* decodeThreadSendInput(message.input).pipe(
          Effect.mapError((cause) => fail("invalid-input", safeErrorMessage(cause))),
        );
        const projection = yield* threadProjection(current, input.threadId);
        const activeRun = projection.runs.findLast((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        );
        const activeProviderThread =
          activeRun === undefined
            ? undefined
            : projection.providerThreads.find((thread) => thread.id === activeRun.providerThreadId);
        const activeProviderSession =
          activeProviderThread?.providerSessionId === null ||
          activeProviderThread?.providerSessionId === undefined
            ? undefined
            : projection.providerSessions.find(
                (session) => session.id === activeProviderThread.providerSessionId,
              );
        const capabilities = activeProviderSession?.capabilities.turns;
        const requestedMode = input.dispatchMode;
        const dispatchMode =
          activeRun === undefined || requestedMode === "start"
            ? ({ type: "start_immediately" } as const)
            : requestedMode === "steer"
              ? ({ type: "steer_active", targetRunId: activeRun.id } as const)
              : requestedMode === "restart"
                ? ({ type: "restart_active", targetRunId: activeRun.id } as const)
                : requestedMode === "queue"
                  ? ({ type: "queue_after_active" } as const)
                  : capabilities?.supportsActiveSteering === true
                    ? ({ type: "steer_active", targetRunId: activeRun.id } as const)
                    : capabilities?.supportsQueuedMessages === true
                      ? ({ type: "queue_after_active" } as const)
                      : capabilities?.supportsSteeringByInterruptRestart === true
                        ? ({ type: "restart_active", targetRunId: activeRun.id } as const)
                        : ({ type: "queue_after_active" } as const);
        return yield* dispatch({
          type: "message.dispatch",
          commandId: input.commandId,
          createdBy: "user",
          creationSource: "server",
          threadId: input.threadId,
          messageId: input.messageId,
          text: input.text,
          attachments: [],
          dispatchMode,
        });
      }
      case "thread.interrupt": {
        const input = yield* decodeThreadInterruptInput(message.input).pipe(
          Effect.mapError((cause) => fail("invalid-input", safeErrorMessage(cause))),
        );
        const projection = yield* threadProjection(current, input.threadId);
        const activeRun = projection.runs.findLast((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        );
        if (activeRun === undefined) return { sequence: 0 };
        return yield* dispatch({
          type: "run.interrupt",
          commandId: input.commandId,
          threadId: input.threadId,
          runId: activeRun.id,
        });
      }
      case "thread.approval.respond": {
        const input = yield* decodeThreadApprovalInput(message.input).pipe(
          Effect.mapError((cause) => fail("invalid-input", safeErrorMessage(cause))),
        );
        return yield* dispatch({
          type: "runtime-request.respond",
          commandId: input.commandId,
          threadId: input.threadId,
          requestId: input.requestId,
          decision: input.decision,
        });
      }
      case "thread.runtimeMode.set": {
        const input = yield* decodeThreadRuntimeModeInput(message.input).pipe(
          Effect.mapError((cause) => fail("invalid-input", safeErrorMessage(cause))),
        );
        return yield* dispatch({
          type: "thread.runtime-mode.set",
          commandId: input.commandId,
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
        });
      }
      case "thread.interactionMode.set": {
        const input = yield* decodeThreadInteractionModeInput(message.input).pipe(
          Effect.mapError((cause) => fail("invalid-input", safeErrorMessage(cause))),
        );
        return yield* dispatch({
          type: "thread.interaction-mode.set",
          commandId: input.commandId,
          threadId: input.threadId,
          interactionMode: input.interactionMode,
        });
      }
      case "thread.settled.set": {
        const input = yield* decodeThreadSettledInput(message.input).pipe(
          Effect.mapError((cause) => fail("invalid-input", safeErrorMessage(cause))),
        );
        return yield* dispatch(
          input.settled
            ? { type: "thread.settle", commandId: input.commandId, threadId: input.threadId }
            : {
                type: "thread.unsettle",
                commandId: input.commandId,
                threadId: input.threadId,
                reason: "user",
              },
        );
      }
      case "thread.snooze.set": {
        const input = yield* decodeThreadSnoozeInput(message.input).pipe(
          Effect.mapError((cause) => fail("invalid-input", safeErrorMessage(cause))),
        );
        return yield* dispatch(
          input.snoozedUntil === null
            ? {
                type: "thread.unsnooze",
                commandId: input.commandId,
                threadId: input.threadId,
                reason: "user",
              }
            : {
                type: "thread.snooze",
                commandId: input.commandId,
                threadId: input.threadId,
                snoozedUntil: input.snoozedUntil,
              },
        );
      }
      default:
        return yield* fail("unsupported-operation", `Unsupported operation: ${message.operation}`);
    }
  });

  const respondToRequest = Effect.fn("clientBridge.respondToRequest")(function* (
    current: BridgeConnection,
    message: typeof RequestMessage.Type,
  ) {
    yield* handleRequest(current, message).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          writeRecord({
            kind: "response",
            id: message.id,
            error: {
              code: "request-failed",
              message: safeErrorMessage(Cause.squash(cause), preparedSecrets(current.prepared)),
            },
          }),
        onSuccess: (result) => writeRecord({ kind: "response", id: message.id, result }),
      }),
    );
  });

  const startShellSubscription = Effect.fn("clientBridge.startShellSubscription")(function* (
    message: typeof SubscribeMessage.Type,
  ) {
    const current = yield* requireConnection();
    yield* stopSubscription(message.subscriptionId);
    let outputSequence = message.resumeSequence ?? 0;
    const method = current.session.client[ORCHESTRATION_V2_WS_METHODS.subscribeShell];
    const runOnce = Effect.gen(function* () {
      const snapshot = yield* fetchEnvironmentShellSnapshot({
        prepared: current.prepared,
        signer: Option.none(),
      }).pipe(
        Effect.mapError((cause) =>
          fail("shell-snapshot-failed", safeErrorMessage(cause, preparedSecrets(current.prepared))),
        ),
      );
      const latest = yield* Ref.make(snapshot);
      let lastPayload = normalizeShellSnapshot(snapshot);
      outputSequence += 1;
      yield* writeRecord({
        kind: "snapshot",
        subscriptionId: message.subscriptionId,
        generation: current.generation,
        sequence: outputSequence,
        payload: lastPayload,
      });
      const subscribeInput =
        current.config.shellResumeCompletionMarker === true
          ? {
              afterSequence: snapshot.snapshotSequence,
              requestCompletionMarker: true as const,
            }
          : { afterSequence: snapshot.snapshotSequence };
      const serverUpdates = method(subscribeInput).pipe(
        Stream.map((item) => ({ _tag: "Server" as const, item })),
      );
      const clockUpdates = Stream.tick("1 minute").pipe(
        Stream.map(() => ({ _tag: "Clock" as const })),
      );
      yield* Stream.merge(serverUpdates, clockUpdates).pipe(
        Stream.runForEach((update) =>
          Effect.gen(function* () {
            if (update._tag === "Clock") {
              const value = yield* Ref.get(latest);
              const payload = normalizeShellSnapshot(value);
              if (encodeJson(payload) === encodeJson(lastPayload)) return;
              lastPayload = payload;
              outputSequence += 1;
              yield* writeRecord({
                kind: "event",
                subscriptionId: message.subscriptionId,
                generation: current.generation,
                sequence: outputSequence,
                payload,
              });
              return;
            }
            const item: OrchestrationV2ShellStreamItem = update.item;
            if (item.kind === "synchronized") {
              outputSequence += 1;
              yield* writeRecord({
                kind: "synchronized",
                subscriptionId: message.subscriptionId,
                generation: current.generation,
                sequence: outputSequence,
              });
              return;
            }
            const previous = yield* Ref.get(latest);
            let next: OrchestrationV2ShellSnapshot;
            if (item.kind === "snapshot") {
              next = mergeShellSnapshotProjects(
                previous,
                item.snapshot,
                item.resolvedRepositoryIdentityRoots === undefined
                  ? undefined
                  : { resolvedRepositoryIdentityRoots: item.resolvedRepositoryIdentityRoots },
              );
            } else {
              next = applyShellStreamEvent(previous, item);
            }
            yield* Ref.set(latest, next);
            lastPayload = normalizeShellSnapshot(next);
            outputSequence += 1;
            yield* writeRecord({
              kind: item.kind === "snapshot" ? "snapshot" : "event",
              subscriptionId: message.subscriptionId,
              generation: current.generation,
              sequence: outputSequence,
              payload: lastPayload,
            });
          }),
        ),
      );
    });
    const run = superviseSubscription(runOnce);
    const fiber = yield* Effect.forkScoped(run);
    yield* Ref.update(subscriptions, (value) => {
      const next = new Map(value);
      next.set(message.subscriptionId, fiber);
      return next;
    });
  });

  const startThreadSubscription = Effect.fn("clientBridge.startThreadSubscription")(function* (
    message: typeof SubscribeMessage.Type,
  ) {
    const current = yield* requireConnection();
    const threadId = yield* decodeThreadId(message.identity).pipe(
      Effect.mapError((cause) => fail("invalid-thread-identity", safeErrorMessage(cause))),
    );
    yield* stopSubscription(message.subscriptionId);
    let outputSequence = message.resumeSequence ?? 0;
    const method = current.session.client[ORCHESTRATION_V2_WS_METHODS.subscribeThread];
    const runOnce = Effect.gen(function* () {
      // Some deployed routers reject provider-derived thread IDs containing encoded
      // path separators even when the ID is escaped as one segment. Fall back to a
      // one-shot RPC snapshot, normalize it immediately, then resume from its sequence.
      const snapshot = yield* fetchEnvironmentBoundedThreadSnapshot({
        prepared: current.prepared,
        threadId,
        signer: Option.none(),
      }).pipe(
        Effect.catchCause(() =>
          method({ threadId, requestCompletionMarker: true }).pipe(
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  fail("thread-snapshot-missing", "Thread stream ended before its snapshot."),
                onSome: (item) =>
                  item.kind === "snapshot"
                    ? Effect.succeed(item)
                    : fail(
                        "thread-snapshot-missing",
                        "Thread stream did not begin with a snapshot.",
                      ),
              }),
            ),
          ),
        ),
      );
      let latest: OrchestrationV2ThreadProjection | null = snapshot.projection;
      outputSequence += 1;
      yield* writeRecord({
        kind: "snapshot",
        subscriptionId: message.subscriptionId,
        generation: current.generation,
        sequence: outputSequence,
        payload: normalizeThreadProjection(snapshot.projection),
      });
      yield* method(threadResumeInput(threadId, snapshot.snapshotSequence)).pipe(
        Stream.runForEach((item: OrchestrationV2ThreadStreamItem) =>
          Effect.gen(function* () {
            if (item.kind === "synchronized") {
              outputSequence += 1;
              yield* writeRecord({
                kind: "synchronized",
                subscriptionId: message.subscriptionId,
                generation: current.generation,
                sequence: outputSequence,
              });
              return;
            }
            if (item.kind === "snapshot") {
              latest = item.projection;
              outputSequence += 1;
              yield* writeRecord({
                kind: "snapshot",
                subscriptionId: message.subscriptionId,
                generation: current.generation,
                sequence: outputSequence,
                payload: normalizeThreadProjection(latest),
              });
              return;
            }
            if (latest === null) return;
            const reduced = reduceThreadProjection(latest, item.event);
            if (reduced.payload === null) return;
            latest = reduced.projection;
            outputSequence += 1;
            yield* writeRecord({
              kind: "event",
              subscriptionId: message.subscriptionId,
              generation: current.generation,
              sequence: outputSequence,
              payload: reduced.payload,
            });
          }),
        ),
      );
    });
    const run = superviseSubscription(
      runOnce.pipe(
        Effect.tapCause((cause) => {
          outputSequence += 1;
          return writeRecord({
            kind: "snapshot",
            subscriptionId: message.subscriptionId,
            generation: current.generation,
            sequence: outputSequence,
            payload: {
              thread: null,
              items: [],
              truncated: false,
              error: safeErrorMessage(Cause.squash(cause), preparedSecrets(current.prepared)),
            } satisfies NormalizedThreadPayload,
          });
        }),
      ),
    );
    const fiber = yield* Effect.forkScoped(run);
    yield* Ref.update(subscriptions, (value) => {
      const next = new Map(value);
      next.set(message.subscriptionId, fiber);
      return next;
    });
  });

  const handleMessage = Effect.fn("clientBridge.handleMessage")(function* (message: ClientMessage) {
    switch (message.kind) {
      case "hello": {
        if ((yield* Ref.get(connection)) !== null) {
          return yield* fail("already-ready", "The bridge accepts one hello per process.");
        }
        const connected = yield* connect(message);
        yield* Ref.set(connection, connected);
        yield* writeRecord({
          kind: "ready",
          protocolVersion: PROTOCOL_VERSION,
          bridgeVersion: packageJson.version,
          pinnedT3Version: packageJson.version,
          serverVersion: connected.config.environment.serverVersion,
          environmentId: connected.clientEnvironmentId,
          capabilities: {
            shell: true,
            threads: true,
            mutations: true,
            terminal: false,
            serverEnvironmentId: connected.config.environment.environmentId,
          },
        });
        return;
      }
      case "request": {
        const current = yield* requireConnection();
        yield* respondToRequest(current, message);
        return;
      }
      case "cancel":
        return;
      case "subscribe":
        if (message.stream === "shell") {
          yield* startShellSubscription(message);
          return;
        }
        if (message.stream === "thread") {
          yield* startThreadSubscription(message);
          return;
        }
        return yield* fail(
          "unsupported-subscription",
          `Unsupported subscription stream: ${message.stream}`,
        );
      case "unsubscribe":
        yield* stopSubscription(message.subscriptionId);
        return;
      default:
        return yield* fail("invalid-message", "Unknown client message kind.");
    }
  });

  const limiter = lineLimiter();
  process.stdin.pipe(limiter);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      process.stdin.unpipe(limiter);
      limiter.destroy();
    }),
  );

  yield* EffectNodeStream.fromReadable<Uint8Array, ClientBridgeError>({
    evaluate: () => limiter,
    closeOnDone: false,
    onError: (cause) => fail("stdin-failed", safeErrorMessage(cause)),
  }).pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.mapError((cause) => fail("invalid-ndjson", safeErrorMessage(cause))),
    Stream.mapEffect((value) =>
      decodeClientMessage(value).pipe(
        Effect.mapError((cause) => fail("invalid-message", safeErrorMessage(cause))),
      ),
    ),
    Stream.runForEach(handleMessage),
  );
});

const ClientBridgeLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  RpcSession.layer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
);

export const clientCommand = Command.make("client", { stdio: stdioFlag }).pipe(
  Command.withDescription("Run a version-matched T3 client bridge."),
  Command.withHandler(({ stdio }) =>
    stdio
      ? runClientBridge().pipe(
          Effect.catch((error) =>
            writeRecord({
              kind: "fatal",
              code: error.code,
              message: error.message,
            }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  process.exitCode = 1;
                }),
              ),
              Effect.catch(() =>
                Effect.sync(() => {
                  process.exitCode = 1;
                }),
              ),
            ),
          ),
          Effect.provide(ClientBridgeLayer),
        )
      : Effect.fail(fail("stdio-required", "Pass --stdio to run the client bridge.")),
  ),
);
