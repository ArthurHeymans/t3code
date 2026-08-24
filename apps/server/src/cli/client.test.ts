// @effect-diagnostics nodeBuiltinImport:off
import { EventId, MessageId, ProjectId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import {
  v2Now,
  v2Project,
  v2Projection,
  v2ShellSnapshot,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  normalizeShellSnapshot,
  normalizeThreadProjection,
  reduceThreadProjection,
  safeErrorMessage,
  socketUrlSecrets,
  superviseSubscription,
  threadResumeInput,
} from "./client.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const NOW = "2026-06-20T00:01:00.000Z";
const binPath = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));

const runBridge = (input: string) =>
  new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>(
    (resolve, reject) => {
      const child = NodeChildProcess.spawn(process.execPath, [binPath, "client", "--stdio"], {
        env: { ...process.env, T3_CLIENT_ACCESS_TOKEN: "", T3_CLIENT_PAIRING_TOKEN: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(input);
    },
  );

describe("stdio client bridge", () => {
  it("normalizes the shell projection without exposing T3 schemas", () => {
    const normalized = normalizeShellSnapshot(v2ShellSnapshot, NOW);

    expect(normalized).toEqual({
      projects: [
        {
          id: "project-v2",
          name: "Project",
          root: "/workspace/project",
          threads: [
            {
              id: "thread-v2",
              title: "Thread",
              status: "idle",
              provider: "codex",
              model: "gpt-5.4",
              worktree: "root",
              path: "/workspace/project",
              settled: false,
              parentThreadId: null,
              relationshipToParent: null,
              additions: 0,
              deletions: 0,
            },
          ],
        },
      ],
      truncated: false,
    });
  });

  it("marks count-truncated shell projections", () => {
    const projects = Array.from({ length: 51 }, (_, index) => ({
      ...v2Project,
      id: ProjectId.make(`project-${String(index)}`),
      title: `Project ${String(index)}`,
    }));
    const normalized = normalizeShellSnapshot({ ...v2ShellSnapshot, projects, threads: [] });

    expect(normalized.projects).toHaveLength(50);
    expect(normalized.truncated).toBe(true);
  });

  it("normalizes a safe, bounded thread timeline", () => {
    const itemId = TurnItemId.make("item-user");
    const normalized = normalizeThreadProjection({
      ...v2Projection,
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: v2Projection.thread.id,
          sourceItemId: itemId,
          item: {
            id: itemId,
            threadId: v2Projection.thread.id,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: null,
            completedAt: v2Now,
            updatedAt: v2Now,
            createdBy: "user",
            creationSource: "web",
            type: "user_message",
            messageId: MessageId.make("message-user"),
            inputIntent: "turn_start",
            text: "Hello from Emacs",
            attachments: [],
          },
        },
      ],
    });

    expect(normalized).toMatchObject({
      thread: {
        id: "thread-v2",
        title: "Thread",
        status: "idle",
        provider: "codex",
        model: "gpt-5.4",
      },
      items: [
        {
          id: "item-user",
          type: "user_message",
          label: "You",
          text: "Hello from Emacs",
        },
      ],
      truncated: false,
    });
  });

  it("does not expose arbitrary dynamic tool payloads", () => {
    const itemId = TurnItemId.make("item-tool");
    const secret = "secret-token-value";
    const normalized = normalizeThreadProjection({
      ...v2Projection,
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: v2Projection.thread.id,
          sourceItemId: itemId,
          item: {
            id: itemId,
            threadId: v2Projection.thread.id,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: null,
            completedAt: v2Now,
            updatedAt: v2Now,
            type: "dynamic_tool",
            toolName: "private-tool",
            input: { token: secret },
            output: { authorization: secret },
          },
        },
      ],
    });

    expect(JSON.stringify(normalized)).not.toContain(secret);
    expect(normalized.items[0]).toMatchObject({ label: "Tool · private-tool" });
  });

  it("resumes thread updates after the bounded snapshot sequence", () => {
    expect(threadResumeInput(v2Projection.thread.id, 42)).toEqual({
      threadId: v2Projection.thread.id,
      afterSequence: 42,
      requestCompletionMarker: true,
      snapshotFallback: "error",
    });
  });

  it("renders deletion as a terminal normalized replacement", () => {
    const reduced = reduceThreadProjection(v2Projection, {
      id: EventId.make("event-delete"),
      threadId: v2Projection.thread.id,
      type: "thread.deleted",
      payload: { ...v2Projection.thread, deletedAt: v2Now },
      occurredAt: v2Now,
    });

    expect(reduced).toEqual({
      projection: null,
      payload: {
        thread: null,
        items: [],
        truncated: false,
        deleted: true,
      },
    });
  });

  it("normalizes hostile display fields to one bounded line", () => {
    const [thread] = v2ShellSnapshot.threads;
    const normalized = normalizeShellSnapshot({
      ...v2ShellSnapshot,
      projects: [{ ...v2Project, title: "Project\nFAKE ROW\tX" }],
      threads: thread === undefined ? [] : [{ ...thread, title: "Thread\r\nFAKE ROW" }],
    });

    expect(normalized.projects[0]?.name).toBe("Project FAKE ROW X");
    expect(normalized.projects[0]?.threads[0]?.title).toBe("Thread FAKE ROW");
  });

  it("keeps worst-case normalized thread output below the Emacs frame limit", () => {
    const text = "🦀".repeat(20_000);
    const visibleTurnItems = Array.from({ length: 100 }, (_, index) => {
      const itemId = TurnItemId.make(`item-${String(index)}-${"x".repeat(3_000)}`);
      return {
        position: index,
        visibility: "local" as const,
        sourceThreadId: v2Projection.thread.id,
        sourceItemId: itemId,
        item: {
          id: itemId,
          threadId: v2Projection.thread.id,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: index,
          status: "completed" as const,
          title: `Title\n${"t".repeat(1_000)}`,
          startedAt: null,
          completedAt: v2Now,
          updatedAt: v2Now,
          type: "assistant_message" as const,
          messageId: MessageId.make(`message-${String(index)}`),
          text,
          streaming: false,
        },
      };
    });
    const normalized = normalizeThreadProjection({ ...v2Projection, visibleTurnItems });

    const record = {
      kind: "snapshot",
      subscriptionId: `thread:${"s".repeat(100_000)}`,
      generation: 1,
      sequence: 1,
      payload: normalized,
    };
    expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeLessThan(900_000);
    expect(normalized.truncated).toBe(true);
    expect(normalized.items.every((item) => !item.title?.includes("\n"))).toBe(true);
  });

  it("omits provider-native compatibility rows that have no thread projection", () => {
    const [thread] = v2ShellSnapshot.threads;
    const normalized = normalizeShellSnapshot({
      ...v2ShellSnapshot,
      threads:
        thread === undefined
          ? []
          : [
              {
                ...thread,
                id: ThreadId.make("thread:provider:pi:native-thread:%2Ftmp%2Fsession.jsonl"),
              },
            ],
    });

    expect(normalized.projects[0]?.threads).toEqual([]);
  });

  it("retains imported provider-prefixed app threads with self-rooted lineage", () => {
    const [thread] = v2ShellSnapshot.threads;
    const importedId = ThreadId.make("thread:provider:pi:native-thread:%2Ftmp%2Fimported.jsonl");
    const normalized = normalizeShellSnapshot({
      ...v2ShellSnapshot,
      threads:
        thread === undefined
          ? []
          : [
              {
                ...thread,
                id: importedId,
                lineage: {
                  ...thread.lineage,
                  rootThreadId: importedId,
                },
              },
            ],
    });

    expect(normalized.projects[0]?.threads[0]?.id).toBe(importedId);
  });

  it("preserves subagent parentage for hierarchical clients", () => {
    const [thread] = v2ShellSnapshot.threads;
    const parentThreadId = ThreadId.make("parent-thread");
    const normalized = normalizeShellSnapshot(
      {
        ...v2ShellSnapshot,
        threads:
          thread === undefined
            ? []
            : [
                {
                  ...thread,
                  lineage: {
                    ...thread.lineage,
                    parentThreadId,
                    relationshipToParent: "subagent",
                  },
                },
              ],
      },
      NOW,
    );

    expect(normalized.projects[0]?.threads[0]).toMatchObject({
      parentThreadId,
      relationshipToParent: "subagent",
    });
  });

  it("marks explicitly settled threads", () => {
    const [thread] = v2ShellSnapshot.threads;
    const normalized = normalizeShellSnapshot(
      {
        ...v2ShellSnapshot,
        threads:
          thread === undefined
            ? []
            : [{ ...thread, settledOverride: "settled", settledAt: thread.updatedAt }],
      },
      NOW,
    );

    expect(normalized.projects[0]?.threads[0]?.settled).toBe(true);
  });

  it("auto-settles inactive threads after the default window", () => {
    const [thread] = v2ShellSnapshot.threads;
    const normalized = normalizeShellSnapshot(
      {
        ...v2ShellSnapshot,
        threads: thread === undefined ? [] : [{ ...thread, latestUserMessageAt: thread.updatedAt }],
      },
      "2026-06-24T00:00:00.000Z",
    );

    expect(normalized.projects[0]?.threads[0]?.settled).toBe(true);
  });

  it("keeps active work visible despite an explicit settled override", () => {
    const [thread] = v2ShellSnapshot.threads;
    const normalized = normalizeShellSnapshot(
      {
        ...v2ShellSnapshot,
        threads:
          thread === undefined
            ? []
            : [
                {
                  ...thread,
                  settledOverride: "settled",
                  settledAt: thread.updatedAt,
                  activeRunId: RunId.make("run-active"),
                  activityRunStatus: "running",
                  status: "running",
                },
              ],
      },
      NOW,
    );

    expect(normalized.projects[0]?.threads[0]?.settled).toBe(false);
  });

  it.effect("retries failed subscriptions and stops after interruption", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const failed = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<void>();
      const attempt = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 1
            ? Deferred.succeed(failed, undefined).pipe(Effect.andThen(Effect.fail("transient")))
            : Deferred.succeed(recovered, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      const fiber = yield* superviseSubscription(attempt, "1 second").pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Deferred.await(failed);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(attempts)).toBe(1);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(recovered);
      yield* Fiber.interrupt(fiber);
      const countAfterInterrupt = yield* Ref.get(attempts);

      expect(countAfterInterrupt).toBe(2);
      expect(yield* Ref.get(attempts)).toBe(2);
    }),
  );

  it.effect("delays retries after normal subscription completion", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const attempt = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 1
            ? Deferred.succeed(first, undefined)
            : Deferred.succeed(second, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      const fiber = yield* superviseSubscription(attempt, "1 second").pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Deferred.await(first);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(attempts)).toBe(1);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(second);
      yield* Fiber.interrupt(fiber);
      expect(yield* Ref.get(attempts)).toBe(2);
    }),
  );

  it("redacts exact credentials even in unstructured dependency errors", () => {
    const pairing = "pairing-secret-123";
    const bearer = "bearer-secret-456";
    const message = safeErrorMessage(new Error(`opaque ${pairing} middle ${bearer} tail`), [
      pairing,
      bearer,
    ]);

    expect(message).toBe("opaque [redacted] middle [redacted] tail");
  });

  it("extracts and redacts bare WebSocket tickets", () => {
    const ticket = "ticket-secret-789";
    const secrets = socketUrlSecrets(`wss://example.test/?wsTicket=${ticket}`);

    expect(safeErrorMessage(new Error(`opaque ${ticket} tail`), secrets)).toBe(
      "opaque [redacted] tail",
    );
  });

  it("keeps protocol mismatch failures as one NDJSON stdout record", async () => {
    const result = await runBridge(
      '{"kind":"hello","protocolVersion":2,"client":{"name":"test","version":"1"},"environment":{"id":"test","endpoint":"http://127.0.0.1:1","generation":1}}\n',
    );
    const lines = result.stdout.trim().split("\n");

    expect(result.code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(decodeJson(lines[0] ?? "")).toMatchObject({
      kind: "fatal",
      code: "protocol-mismatch",
    });
  });

  it("rejects endpoint userinfo without leaking it", async () => {
    const secret = "supersecret";
    const result = await runBridge(
      `{"kind":"hello","protocolVersion":1,"client":{"name":"test","version":"1"},"environment":{"id":"test","endpoint":"http://user:${secret}@127.0.0.1:1","generation":1}}\n`,
    );
    const lines = result.stdout.trim().split("\n");

    expect(result.code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(decodeJson(lines[0] ?? "")).toMatchObject({
      kind: "fatal",
      code: "invalid-endpoint",
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret);
  });
});
