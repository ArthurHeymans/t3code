import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import * as JjWorkflow from "../vcs/JjWorkflow.ts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const jjDriverLayer = (overrides: Partial<JjVcsDriver.JjVcsDriver["Service"]> = {}) =>
  Layer.effect(
    JjVcsDriver.JjVcsDriver,
    JjVcsDriver.makeVcsDriverShape().pipe(
      Effect.map((driver) => JjVcsDriver.JjVcsDriver.of({ ...driver, ...overrides })),
    ),
  ).pipe(Layer.provide(VcsProcess.layer), Layer.provide(NodeServices.layer));
const JjDriverTestLayer = jjDriverLayer();
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
  it.effect("recognizes Jujutsu as a repository for shared workspace workflows", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const isRepository = yield* workflow.isRepository("/jj-repo");

      assert.equal(isRepository, true);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
  );

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
        Layer.effect(
          VcsDriverRegistry.VcsDriverRegistry,
          Effect.gen(function* () {
            const jj = yield* JjVcsDriver.JjVcsDriver;
            const handle = {
              kind: "jj" as const,
              repository: {} as VcsDriverRegistry.VcsDriverHandle["repository"],
              driver: {
                ...jj,
                workflow: JjWorkflow.make(
                  jj,
                  (_cwd, name) => `/worktrees/repo/${name.replaceAll("/", "-")}`,
                ),
              },
            };
            return VcsDriverRegistry.VcsDriverRegistry.of({
              resolve: () => Effect.succeed(handle),
              detect: () => Effect.succeed(handle),
              get: () => Effect.succeed(jj),
            });
          }),
        ),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(jjDriverLayer({ createWorktree })),
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
      Layer.provide(jjDriverLayer({ localStatus })),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          status: () => localStatus().pipe(Effect.map((local) => mergeGitStatusParts(local, null))),
          remoteStatus: () => Effect.succeed(null),
        }),
      ),
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
