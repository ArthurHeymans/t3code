import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as JjVcsDriver from "./vcs/JjVcsDriver.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  storageCleanupActivityAt,
  storageCleanupThreadIdle,
  storageCleanupJjIntegrated,
} from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

effectIt.effect("JJ cleanup checks every parent and retains described empty changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-cleanup-integration-" });
      const jj = yield* JjVcsDriver.makeVcsDriverShape();
      const run = (args: string[]) => jj.execute({ cwd, args, operation: "StorageCleanup.test" });
      const parent = () =>
        run(["log", "-r", "@-", "--no-graph", "-T", "commit_id"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        );
      yield* run(["git", "init", "--no-colocate"]);
      yield* fs.writeFileString(path.join(cwd, "base.txt"), "base\n");
      yield* run(["commit", "-m", "base"]);
      const base = yield* parent();
      expect(yield* storageCleanupJjIntegrated(jj, cwd, base)).toBe(true);
      yield* run(["describe", "-m", "intentional empty change"]);
      expect(yield* storageCleanupJjIntegrated(jj, cwd, base)).toBe(false);
      yield* run(["new", "root()"]);
      yield* fs.writeFileString(path.join(cwd, "side.txt"), "side\n");
      yield* run(["commit", "-m", "side"]);
      const side = yield* parent();
      yield* run(["new", base, side]);
      expect(yield* storageCleanupJjIntegrated(jj, cwd, base)).toBe(false);
      yield* run(["commit", "-m", "merge"]);
      expect(yield* storageCleanupJjIntegrated(jj, cwd, yield* parent())).toBe(true);
    }),
  ).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});
