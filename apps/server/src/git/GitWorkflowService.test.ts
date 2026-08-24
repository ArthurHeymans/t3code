import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const jjCapabilities = {
  kind: "jj" as const,
  supportsWorktrees: true as const,
  supportsWorkspaceSelection: true as const,
  supportsBookmarks: true as const,
  supportsAtomicSnapshot: true as const,
  supportsPushDefaultRemote: false as const,
  ignoreClassifier: "git-compatible-fallback" as const,
};
const JjDriverTestLayer = Layer.mock(JjVcsDriver.JjVcsDriver)({
  capabilities: jjCapabilities,
});
const ServerConfigTestLayer = Layer.succeed(
  ServerConfig.ServerConfig,
  ServerConfig.make({ worktreesDir: "/worktrees" } as ServerConfig.ServerConfig["Service"]),
);

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(JjDriverTestLayer),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(ServerConfigTestLayer),
  );
}

describe("GitWorkflowService", () => {
  it.effect("creates jj workspaces in the configured worktree directory", () => {
    const createWorktree = vi.fn((input) =>
      Effect.succeed({
        worktree: {
          path: input.path!,
          refName: input.newRefName ?? input.refName,
        },
      }),
    );
    const layer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () =>
            Effect.succeed({
              kind: "jj",
              repository: {} as VcsDriverRegistry.VcsDriverHandle["repository"],
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(JjVcsDriver.JjVcsDriver)({
          capabilities: jjCapabilities,
          createWorktree,
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(ServerConfigTestLayer),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const result = yield* workflow.createWorktree({
        cwd: "/src/repo",
        refName: "main",
        newRefName: "feature/test",
        path: null,
      });

      assert.deepStrictEqual(result, {
        worktree: { path: "/worktrees/repo/feature-test", refName: "feature/test" },
      });
      expect(createWorktree).toHaveBeenCalledWith({
        cwd: "/src/repo",
        refName: "main",
        newRefName: "feature/test",
        path: "/worktrees/repo/feature-test",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns Jujutsu local status instead of synthetic zero counts", () => {
    const jjStatus = {
      kind: "jj" as const,
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "abcdefghijkl",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "README.md", insertions: 2, deletions: 1 }],
        insertions: 2,
        deletions: 1,
      },
    };
    const localStatus = vi.fn(() => Effect.succeed(jjStatus));
    const layer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {} as VcsDriverRegistry.VcsDriverHandle["repository"],
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(JjVcsDriver.JjVcsDriver)({
          capabilities: jjCapabilities,
          localStatus,
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(ServerConfigTestLayer),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.deepStrictEqual(yield* workflow.localStatus({ cwd: "/repo" }), jjStatus);
      assert.deepStrictEqual(
        (yield* workflow.status({ cwd: "/repo" })).workingTree,
        jjStatus.workingTree,
      );
      expect(localStatus).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        kind: "unknown",
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        kind: "unknown",
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(JjDriverTestLayer),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
      Layer.provide(ServerConfigTestLayer),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });
});
