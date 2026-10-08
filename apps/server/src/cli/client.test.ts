// @effect-diagnostics nodeBuiltinImport:off
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProjectMutationError,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  CommandId,
  ProviderInstanceId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
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
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  bridgeSocketUrl,
  MAX_SHELL_PROJECTS,
  decodePassthroughThreadCommand,
  registerProject,
  normalizeArchivedThreads,
  normalizeModelCatalog,
  normalizeProviderCommands,
  serveThreadHistory,
  normalizeShellSnapshot,
  withWorkspaceStats,
  normalizeThreadProjection,
  reduceThreadProjection,
  safeErrorMessage,
  socketUrlSecrets,
  superviseSubscription,
  superviseBridgeConnection,
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
  it.effect("registers an existing workspace with client-supplied IDs", () =>
    Effect.gen(function* () {
      const result = yield* registerProject(
        {
          commandId: "register-majutsu",
          projectId: "majutsu",
          title: "majutsu",
          workspaceRoot: "/home/me/src/majutsu",
          // Registration never creates a directory, even if requested.
          createWorkspaceRootIfMissing: true,
        },
        (command) => {
          expect(command).toEqual({
            type: "project.create",
            commandId: "register-majutsu",
            projectId: "majutsu",
            title: "majutsu",
            workspaceRoot: "/home/me/src/majutsu",
          });
          return Effect.succeed({
            id: ProjectId.make("majutsu"),
            title: "majutsu",
            workspaceRoot: "/home/me/src/majutsu",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt: null,
          });
        },
      );
      expect(result).toEqual({
        project: { id: "majutsu", name: "majutsu", root: "/home/me/src/majutsu", threads: [] },
      });
    }),
  );

  it.effect("rejects invalid registration and propagates mutation failures without retry", () =>
    Effect.gen(function* () {
      let calls = 0;
      const mutate = () => {
        calls += 1;
        return Effect.fail(
          new ProjectMutationError({
            commandId: CommandId.make("register-majutsu"),
            message: "Permission denied",
          }),
        );
      };
      const invalid = yield* Effect.result(registerProject({ title: "majutsu" }, mutate));
      expect(invalid._tag).toBe("Failure");
      expect(calls).toBe(0);
      const denied = yield* Effect.result(
        registerProject(
          {
            commandId: "register-majutsu",
            projectId: "majutsu",
            title: "majutsu",
            workspaceRoot: "/home/me/src/majutsu",
          },
          mutate,
        ),
      );
      expect(denied._tag).toBe("Failure");
      expect(calls).toBe(1);
    }),
  );

  it("negotiates the orchestration protocol on its websocket URL", () => {
    const url = new URL(bridgeSocketUrl("ws://127.0.0.1:3773/ws?wsTicket=opaque"));
    expect(url.searchParams.get("wsTicket")).toBe("opaque");
    expect(url.searchParams.get("orchestrationProtocol")).toBe("2");
  });

  it("bounds the model catalog and exposes only selectable model options", () => {
    const providers = [
      {
        instanceId: "codex-work",
        displayName: "Work",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        models: [
          {
            slug: "gpt-example",
            name: "Example",
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Effort",
                  type: "select",
                  options: [{ id: "high", label: "High", isDefault: true }],
                },
              ],
            },
          },
        ],
      },
    ] as unknown as ServerConfig["providers"];
    expect(normalizeModelCatalog(providers)).toEqual({
      providers: [
        {
          instanceId: "codex-work",
          name: "Work",
          driver: "codex",
          available: true,
          reason: null,
          requiresNewThreadForModelChange: false,
          models: [
            {
              slug: "gpt-example",
              name: "Example",
              options: [
                {
                  id: "effort",
                  label: "Effort",
                  type: "select",
                  choices: [{ id: "high", label: "High", isDefault: true }],
                },
              ],
            },
          ],
        },
      ],
      truncated: false,
    });
    const manyModels = [
      {
        ...providers[0]!,
        models: [
          ...Array.from({ length: 100 }, () => providers[0]!.models[0]!),
          { ...providers[0]!.models[0]!, slug: "openai-codex/gpt-5.4" },
        ],
      },
    ];
    const complete = normalizeModelCatalog(manyModels);
    expect(complete.truncated).toBe(false);
    expect(complete.providers[0]?.models).toHaveLength(101);
    expect(complete.providers[0]?.models.at(-1)?.slug).toBe("openai-codex/gpt-5.4");

    const oversized = [
      { ...providers[0]!, models: Array.from({ length: 3000 }, () => providers[0]!.models[0]!) },
    ];
    const bounded = normalizeModelCatalog(oversized);
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(400_000);
  });

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
              branch: null,
              updatedAt: "2026-06-20T00:00:00.000Z",
              pinned: false,
              snoozedUntil: null,
              unread: false,
              settled: false,
              parentThreadId: null,
              relationshipToParent: null,
              additions: null,
              deletions: null,
            },
          ],
        },
      ],
      truncated: false,
    });
  });

  it("projects jj workspace stats to every sibling without inventing zeros", () => {
    const payload = normalizeShellSnapshot(
      {
        ...v2ShellSnapshot,
        threads: [
          v2ThreadShell,
          {
            ...v2ThreadShell,
            id: ThreadId.make("sibling"),
            lineage: { ...v2ThreadShell.lineage, rootThreadId: ThreadId.make("sibling") },
          },
          {
            ...v2ThreadShell,
            id: ThreadId.make("other"),
            worktreePath: "/other",
            lineage: { ...v2ThreadShell.lineage, rootThreadId: ThreadId.make("other") },
          },
        ],
      },
      NOW,
    );
    const status = {
      kind: "jj" as const,
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: true,
      workingTree: { files: [], insertions: 7, deletions: 2 },
    };
    const enriched = withWorkspaceStats(payload, new Map([["/workspace/project", status]]));
    expect(
      enriched.projects[0]?.threads.map(({ additions, deletions }) => [additions, deletions]),
    ).toEqual([
      [7, 2],
      [7, 2],
      [null, null],
    ]);
    expect(
      withWorkspaceStats(
        payload,
        new Map([
          [
            "/workspace/project",
            {
              ...status,
              isRepo: false,
            },
          ],
        ]),
      ).projects[0]?.threads[0]?.additions,
    ).toBeNull();
    expect(payload.projects[0]?.threads[0]?.additions).toBeNull();
  });

  it("exposes pin, snooze, branch and unseen-completion state on shell threads", () => {
    const later = DateTime.makeUnsafe("2026-06-20T00:00:30.000Z");
    const normalized = normalizeShellSnapshot(
      {
        ...v2ShellSnapshot,
        threads: [
          {
            ...v2ThreadShell,
            branch: "feature/emacs",
            pinnedAt: v2Now,
            snoozedUntil: later,
            latestRunCompletedAt: later,
            lastVisitedAt: v2Now,
          },
        ],
      },
      NOW,
    );
    expect(normalized.projects[0]?.threads[0]).toMatchObject({
      branch: "feature/emacs",
      pinned: true,
      snoozedUntil: "2026-06-20T00:00:30.000Z",
      unread: true,
    });
  });

  it("marks count-truncated shell projections", () => {
    const projects = Array.from({ length: MAX_SHELL_PROJECTS + 1 }, (_, index) => ({
      ...v2Project,
      id: ProjectId.make(`project-${String(index)}`),
      title: `Project ${String(index)}`,
    }));
    const normalized = normalizeShellSnapshot({ ...v2ShellSnapshot, projects, threads: [] });

    expect(normalized.projects).toHaveLength(MAX_SHELL_PROJECTS);
    expect(normalized.truncated).toBe(true);
  });

  it("keeps a shell with more than 500 ordinary threads complete", () => {
    const threads = Array.from({ length: 600 }, (_, index) => {
      const id = ThreadId.make(`thread-${String(index)}`);
      return {
        ...v2ShellSnapshot.threads[0]!,
        id,
        lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
      };
    });
    const normalized = normalizeShellSnapshot({ ...v2ShellSnapshot, threads });

    expect(normalized.projects[0]?.threads).toHaveLength(600);
    expect(normalized.truncated).toBe(false);
  });

  it("reserves shell capacity for working threads and their parents before old settled threads", () => {
    const base = v2ShellSnapshot.threads[0]!;
    const settled = Array.from({ length: 2_005 }, (_, index) => {
      const id = ThreadId.make(`settled-${String(index)}`);
      return {
        ...base,
        id,
        lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
        settledOverride: "settled" as const,
        settledAt: base.updatedAt,
        updatedAt: DateTime.add(base.updatedAt, { seconds: index }),
      };
    });
    const parentId = ThreadId.make("settled-parent");
    const agentId = ThreadId.make("working-agent");
    const normalized = normalizeShellSnapshot(
      {
        ...v2ShellSnapshot,
        threads: [
          ...settled,
          {
            ...base,
            id: parentId,
            lineage: { rootThreadId: parentId, parentThreadId: null, relationshipToParent: null },
            settledOverride: "settled",
            settledAt: base.updatedAt,
          },
          {
            ...base,
            id: agentId,
            status: "running",
            activeRunId: RunId.make("active-run"),
            lineage: {
              rootThreadId: parentId,
              parentThreadId: parentId,
              relationshipToParent: "subagent",
            },
          },
        ],
      },
      NOW,
    );
    const threads = normalized.projects[0]!.threads;

    expect(threads).toHaveLength(2_000);
    expect(threads.some(({ id }) => id === agentId)).toBe(true);
    expect(threads.some(({ id }) => id === parentId)).toBe(true);
    expect(threads.some(({ id }) => id === "settled-0")).toBe(false);
    expect(threads.some(({ id }) => id === "settled-2004")).toBe(true);
    expect(normalized).toMatchObject({
      truncated: true,
      omittedSettledCount: 7,
      omittedOtherCount: 0,
      omittedProjectCount: 0,
    });
  });

  it("evicts settled threads before working threads at the byte limit", () => {
    const base = v2ShellSnapshot.threads[0]!;
    const threads = Array.from({ length: 220 }, (_, index) => {
      const id = ThreadId.make(`thread-${String(index)}-${"x".repeat(3_500)}`);
      return {
        ...base,
        id,
        lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
        settledOverride: "settled" as const,
        settledAt: base.updatedAt,
      };
    });
    const activeId = ThreadId.make("working-thread");
    const normalized = normalizeShellSnapshot(
      {
        ...v2ShellSnapshot,
        threads: [
          ...threads,
          {
            ...base,
            id: activeId,
            status: "running",
            activeRunId: RunId.make("active-run"),
            lineage: { rootThreadId: activeId, parentThreadId: null, relationshipToParent: null },
          },
        ],
      },
      NOW,
    );

    expect(normalized.projects[0]?.threads.some(({ id }) => id === activeId)).toBe(true);
    expect(normalized.omittedSettledCount).toBeGreaterThan(0);
    expect(normalized.omittedOtherCount).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(normalized), "utf8")).toBeLessThanOrEqual(700_000);
  });

  it("includes working projects beyond the project count cap", () => {
    const base = v2ShellSnapshot.threads[0]!;
    const projects = Array.from({ length: MAX_SHELL_PROJECTS + 1 }, (_, index) => ({
      ...v2Project,
      id: ProjectId.make(`project-${String(index)}`),
    }));
    const threads = projects.map((project, index) => {
      const id = ThreadId.make(`thread-${String(index)}`);
      return {
        ...base,
        id,
        projectId: project.id,
        lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
        ...(index === MAX_SHELL_PROJECTS
          ? { status: "running" as const, activeRunId: RunId.make("active-run") }
          : { settledOverride: "settled" as const, settledAt: base.updatedAt }),
      };
    });
    const normalized = normalizeShellSnapshot({ ...v2ShellSnapshot, projects, threads }, NOW);

    expect(normalized.projects).toHaveLength(MAX_SHELL_PROJECTS);
    expect(normalized.projects.some(({ id }) => id === projects[MAX_SHELL_PROJECTS]!.id)).toBe(
      true,
    );
    expect(normalized).toMatchObject({
      truncated: true,
      omittedSettledCount: 1,
      omittedOtherCount: 0,
      omittedProjectCount: 1,
    });
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
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        activeRunModel: null,
        activeRunProvider: null,
        hasStartedSession: false,
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

  it("groups by authoritative run identity and folds only completed commentary", () => {
    const run: OrchestrationV2Run = {
      id: RunId.make("run-sections"),
      threadId: v2Projection.thread.id,
      ordinal: 1,
      providerInstanceId: v2Projection.thread.providerInstanceId,
      modelSelection: v2Projection.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message-user"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: v2Now,
      startedAt: v2Now,
      completedAt: v2Now,
      checkpointId: null,
      contextHandoffId: null,
    };
    const base = {
      threadId: v2Projection.thread.id,
      runId: run.id,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
    };
    const items: OrchestrationV2TurnItem[] = [
      {
        ...base,
        id: TurnItemId.make("prompt"),
        runId: null,
        type: "user_message",
        messageId: run.userMessageId,
        inputIntent: "turn_start",
        text: "Fix it",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      {
        ...base,
        id: TurnItemId.make("commentary"),
        type: "assistant_message",
        messageId: MessageId.make("commentary"),
        text: "Inspecting",
        streaming: false,
      },
      {
        ...base,
        id: TurnItemId.make("answer"),
        type: "assistant_message",
        messageId: MessageId.make("answer"),
        text: "Done",
        streaming: false,
      },
    ];
    const projection = {
      ...v2Projection,
      runs: [run],
      visibleTurnItems: items.map((item, position) => ({
        item,
        position,
        visibility: "local" as const,
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
      })),
    };
    const completed = normalizeThreadProjection(projection);
    expect(completed.items.map((item) => item.runId)).toEqual([run.id, run.id, run.id]);
    expect(completed.items.map((item) => item.presentation)).toEqual([
      "message",
      "work",
      "message",
    ]);
    expect(completed.items[0]).toMatchObject({ runOrdinal: 1, runStatus: "completed" });
    const active = normalizeThreadProjection({
      ...projection,
      runs: [{ ...run, status: "running", completedAt: null }],
    });
    expect(active.items.every((item) => item.presentation === "message")).toBe(true);
    const interrupted = normalizeThreadProjection({
      ...projection,
      runs: [{ ...run, status: "interrupted" }],
    });
    expect(interrupted.items.every((item) => item.presentation === "message")).toBe(true);
  });

  it("retains pending attention outside the recent history window", () => {
    const requestId = RuntimeRequestId.make("old-approval");
    const base = {
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
    };
    const visibleTurnItems = Array.from({ length: 101 }, (_, position) => {
      const id = TurnItemId.make(`attention-item-${position}`);
      const item: OrchestrationV2TurnItem =
        position === 0
          ? {
              ...base,
              id,
              type: "approval_request",
              requestId,
              requestKind: "command",
              prompt: "Allow the command?",
              status: "waiting",
            }
          : {
              ...base,
              id,
              type: "assistant_message",
              messageId: MessageId.make(`message-${position}`),
              text: "output",
              streaming: false,
            };
      return {
        item,
        position,
        visibility: "local" as const,
        sourceThreadId: item.threadId,
        sourceItemId: id,
      };
    });
    const normalized = normalizeThreadProjection({
      ...v2Projection,
      visibleTurnItems,
      runtimeRequests: [
        {
          id: requestId,
          nodeId: NodeId.make("node-1"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status: "pending",
          responseCapability: { type: "not_resumable", reason: "offline" },
          createdAt: v2Now,
          resolvedAt: null,
        },
      ],
    });
    expect(normalized.items.some((item) => item.actionId === requestId)).toBe(false);
    expect(normalized.attention).toMatchObject([
      { actionId: requestId, text: "Allow the command?" },
    ]);
    expect(normalized.pendingRequestCount).toBe(1);
    expect(normalized.truncated).toBe(true);
  });

  it.effect("pages older history from the bounded window and then server cursors", () =>
    Effect.gen(function* () {
      const base = {
        threadId: v2Projection.thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed" as const,
        title: null,
        startedAt: v2Now,
        completedAt: v2Now,
        updatedAt: v2Now,
      };
      const row = (position: number) => {
        const id = TurnItemId.make(`history-${String(position)}`);
        const item: OrchestrationV2TurnItem = {
          ...base,
          id,
          type: "assistant_message",
          messageId: MessageId.make(`history-message-${String(position)}`),
          text: `line ${String(position)}`,
          streaming: false,
        };
        return {
          item,
          position,
          visibility: "local" as const,
          sourceThreadId: item.threadId,
          sourceItemId: id,
        };
      };
      const range = (from: number, to: number) =>
        Array.from({ length: to - from }, (_, index) => row(from + index));
      // Like the server's bounded snapshot: only rows 200..259 are in the
      // projection; older rows sit behind an opaque cursor.
      const projection = { ...v2Projection, visibleTurnItems: range(200, 260) };
      const pages: Record<string, { items: ReturnType<typeof range>; next: string | null }> = {
        "cursor-a": { items: range(80, 200), next: "cursor-b" },
        "cursor-b": { items: range(0, 80), next: null },
      };
      const requested: string[] = [];
      const fetchPage = (cursor: string) =>
        Effect.sync(() => {
          requested.push(cursor);
          const page = pages[cursor]!;
          return { items: page.items, nextCursor: page.next, hasMoreHistory: page.next !== null };
        });
      const state = { projection, windowCursor: "cursor-a", segments: new Map() };
      const ids = (items: ReadonlyArray<{ readonly id: string }>) => items.map((item) => item.id);

      expect(normalizeThreadProjection(projection, true).hasOlderHistory).toBe(true);
      // Inside the live window, older window rows are served without a fetch.
      const inWindow = yield* serveThreadHistory(state, "history-210", fetchPage);
      expect(ids(inWindow.items)).toEqual(ids(range(200, 210).map((r) => r.item)));
      expect(inWindow.hasMore).toBe(true);
      expect(requested).toEqual([]);
      // At the window's first row the cursor is followed; a 120-row page is
      // served as 100 rows with the remaining 20 kept for the next request.
      const first = yield* serveThreadHistory(state, "history-200", fetchPage);
      expect(ids(first.items)).toEqual(ids(range(100, 200).map((r) => r.item)));
      const second = yield* serveThreadHistory(state, "history-100", fetchPage);
      expect(ids(second.items)).toEqual(ids(range(80, 100).map((r) => r.item)));
      expect(second.hasMore).toBe(true);
      const last = yield* serveThreadHistory(state, "history-80", fetchPage);
      expect(ids(last.items)).toEqual(ids(range(0, 80).map((r) => r.item)));
      expect(last.hasMore).toBe(false);
      expect(requested).toEqual(["cursor-a", "cursor-b"]);
      const unknown = yield* Effect.flip(serveThreadHistory(state, "elsewhere", fetchPage));
      expect(unknown.code).toBe("history-unavailable");
    }),
  );

  it("exposes queued messages, context usage, file paths and input questions", () => {
    const queued: OrchestrationV2Run = {
      id: RunId.make("run-queued"),
      threadId: v2Projection.thread.id,
      ordinal: 2,
      providerInstanceId: v2Projection.thread.providerInstanceId,
      modelSelection: v2Projection.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("queued-message"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "queued",
      queuePosition: 1,
      queueHeld: true,
      requestedAt: v2Now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const base = {
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
    };
    const items: OrchestrationV2TurnItem[] = [
      { ...base, id: TurnItemId.make("edit"), type: "file_change", fileName: "src/main.rs" },
      {
        ...base,
        id: TurnItemId.make("question"),
        type: "user_input_request",
        requestId: RuntimeRequestId.make("input-1"),
        questions: [
          {
            id: "q1",
            header: "Scope",
            question: "Which resolver?",
            options: [
              { label: "UDP", description: "fast path" },
              { label: "DoH", description: "fallback", value: "doh " },
            ],
          },
        ],
      },
    ];
    const queuedMessage = {
      id: queued.userMessageId,
      threadId: v2Projection.thread.id,
      runId: queued.id,
      nodeId: null,
      role: "user" as const,
      text: "afterwards, update docs",
      attachments: [],
      streaming: false,
      createdAt: v2Now,
      updatedAt: v2Now,
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const longQueue = normalizeThreadProjection({
      ...v2Projection,
      runs: [queued],
      messages: [{ ...queuedMessage, text: "x".repeat(5_000) }],
    });
    expect(longQueue.queued?.[0]).toMatchObject({ truncated: true });
    expect(longQueue.queued?.[0]?.text).toHaveLength(4_000);
    const normalized = normalizeThreadProjection({
      ...v2Projection,
      runs: [queued],
      messages: [
        {
          id: queued.userMessageId,
          threadId: v2Projection.thread.id,
          runId: queued.id,
          nodeId: null,
          role: "user",
          text: "afterwards, update docs",
          attachments: [],
          streaming: false,
          createdAt: v2Now,
          updatedAt: v2Now,
          createdBy: "user",
          creationSource: "web",
        },
      ],
      providerTurns: [
        {
          id: "turn-1" as never,
          providerThreadId: "provider-thread" as never,
          nodeId: NodeId.make("node-turn"),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: v2Now,
          completedAt: v2Now,
          tokenUsage: { usedTokens: 1200, maxTokens: 4000, updatedAt: NOW },
        },
      ],
      visibleTurnItems: items.map((item, position) => ({
        item,
        position,
        visibility: "local" as const,
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
      })),
    });
    expect(normalized.queued).toEqual([
      {
        runId: "run-queued",
        position: 1,
        held: true,
        text: "afterwards, update docs",
        truncated: false,
      },
    ]);
    expect(normalized.thread?.tokenUsage).toEqual({ usedTokens: 1200, maxTokens: 4000 });
    expect(normalized.items[0]).toMatchObject({ type: "file_change", path: "src/main.rs" });
    expect(normalized.items[1]?.questions).toEqual([
      {
        id: "q1",
        header: "Scope",
        question: "Which resolver?",
        multiSelect: false,
        allowCustomAnswer: true,
        options: [
          { label: "UDP", description: "fast path", value: "UDP" },
          { label: "DoH", description: "fallback", value: "doh " },
        ],
      },
    ]);
  });

  it.effect("passes through only allowlisted thread commands", () =>
    Effect.gen(function* () {
      const commandId = CommandId.make("command-1");
      const threadId = v2Projection.thread.id;
      const pin = yield* decodePassthroughThreadCommand({
        type: "thread.pin",
        commandId,
        threadId,
      });
      expect(pin.type).toBe("thread.pin");
      const rename = yield* decodePassthroughThreadCommand({
        type: "thread.metadata.update",
        commandId,
        threadId,
        title: "Renamed",
      });
      expect(rename.type).toBe("thread.metadata.update");
      const rebind = yield* Effect.flip(
        decodePassthroughThreadCommand({
          type: "thread.metadata.update",
          commandId,
          threadId,
          worktreePath: "/elsewhere",
        }),
      );
      expect(rebind.code).toBe("unsupported-command");
      const interrupt = yield* Effect.flip(
        decodePassthroughThreadCommand({
          type: "run.interrupt",
          commandId,
          threadId,
          runId: RunId.make("run-1"),
        }),
      );
      expect(interrupt.code).toBe("unsupported-command");
      const malformed = yield* Effect.flip(decodePassthroughThreadCommand({ type: "thread.pin" }));
      expect(malformed.code).toBe("invalid-input");
    }),
  );

  it("normalizes provider commands and archived threads", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const commands = normalizeProviderCommands(
      [
        {
          instanceId,
          slashCommands: [{ name: "review", description: "Review changes" }],
          skills: [
            { name: "deploy", description: "Ship it", path: "/s", enabled: true },
            { name: "off", path: "/o", enabled: false },
          ],
        },
      ] as unknown as ServerConfig["providers"],
      "codex",
    );
    expect(commands).toEqual({
      slashCommands: [{ name: "review", description: "Review changes" }],
      skills: [{ name: "deploy", description: "Ship it", userInvocationOnly: false }],
    });
    const archived = normalizeArchivedThreads({
      schemaVersion: 1,
      snapshotSequence: 0,
      projects: [v2Project],
      threads: [{ ...v2ThreadShell, archivedAt: v2Now }],
    });
    expect(archived.threads).toEqual([
      {
        id: "thread-v2",
        title: "Thread",
        projectId: "project-v2",
        projectName: "Project",
        provider: "codex",
        model: "gpt-5.4",
        updatedAt: "2026-06-20T00:00:00.000Z",
      },
    ]);
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

  it.effect("renews a closed bridge session and watches the replacement", () =>
    Effect.gen(function* () {
      const firstClosed = yield* Deferred.make<never, string>();
      const secondClosed = yield* Deferred.make<never, string>();
      const failedRenewal = yield* Deferred.make<void>();
      const firstRecovered = yield* Deferred.make<void>();
      const secondDisconnected = yield* Deferred.make<void>();
      const attempts = yield* Ref.make(0);
      const transitions = yield* Ref.make<string[]>([]);
      const fiber = yield* superviseBridgeConnection(
        0,
        (session) => (session === 0 ? Deferred.await(firstClosed) : Deferred.await(secondClosed)),
        () =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.succeed(failedRenewal, undefined).pipe(
                    Effect.andThen(Effect.fail("offline")),
                  )
                : count === 2
                  ? Effect.succeed(1)
                  : Effect.never,
            ),
          ),
        (phase, session) =>
          Ref.update(transitions, (items) => [...items, `${phase}:${String(session)}`]).pipe(
            Effect.andThen(
              phase === "ready"
                ? Deferred.succeed(firstRecovered, undefined)
                : session === 1
                  ? Deferred.succeed(secondDisconnected, undefined)
                  : Effect.void,
            ),
          ),
        { retryDelay: () => "1 second" },
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.fail(firstClosed, "closed");
      yield* Deferred.await(failedRenewal);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(firstRecovered);
      yield* Deferred.fail(secondClosed, "closed");
      yield* Deferred.await(secondDisconnected);
      yield* Fiber.interrupt(fiber);
      expect(yield* Ref.get(transitions)).toEqual(["retrying:0", "ready:1", "retrying:1"]);
    }),
  );

  it.effect("backs off reconnect attempts and stops on revoked credentials", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const third = yield* Deferred.make<void>();
      const fiber = yield* superviseBridgeConnection(
        0,
        () => Effect.fail("closed"),
        () =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 1
                ? Deferred.succeed(first, undefined)
                : count === 2
                  ? Deferred.succeed(second, undefined)
                  : Deferred.succeed(third, undefined),
            ),
            Effect.andThen(Effect.fail("offline")),
          ),
        () => Effect.void,
        { retryDelay: (attempt) => Duration.seconds(attempt) },
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(first);
      yield* TestClock.adjust(Duration.millis(999));
      expect(yield* Ref.get(attempts)).toBe(1);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(second);
      yield* TestClock.adjust(Duration.millis(1999));
      expect(yield* Ref.get(attempts)).toBe(2);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(third);
      yield* Fiber.interrupt(fiber);

      const terminalAttempts = yield* Ref.make(0);
      const error = yield* Effect.flip(
        superviseBridgeConnection(
          0,
          () => Effect.fail("closed"),
          () =>
            Ref.update(terminalAttempts, (count) => count + 1).pipe(
              Effect.andThen(Effect.fail("authentication-failed")),
            ),
          () => Effect.void,
          { shouldRetry: (cause) => cause !== "authentication-failed" },
        ),
      );
      expect(error).toBe("authentication-failed");
      expect(yield* Ref.get(terminalAttempts)).toBe(1);
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
