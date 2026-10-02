// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  GitManagerError,
  GitCommandError,
  type VcsDriverKind,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import * as GitManager from "./GitManager.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import { jjRef } from "../vcs/jjExpressions.ts";
import * as JjGitWorkflowAdapter from "../vcs/JjGitWorkflowAdapter.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
    readonly validateWorktreePath: (input: {
      readonly cwd: string;
      readonly path: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName?: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly recoverWorktree: (input: {
      readonly cwd: string;
      readonly path: string;
      readonly refName: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonGitLocalStatus(kind: VcsDriverKind, isRepo: boolean): VcsStatusLocalResult {
  return {
    kind,
    isRepo,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const jj = yield* JjVcsDriver.JjVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const { worktreesDir } = yield* ServerConfig.ServerConfig;

  const mapVcsCommandError =
    (operation: string, command: string, cwd: string) => (cause: unknown) =>
      new GitCommandError({
        operation,
        command,
        cwd,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

  const resolveDriverForCommand = Effect.fn("GitWorkflowService.resolveDriverForCommand")(
    function* (operation: string, cwd: string) {
      return yield* registry
        .resolve({ cwd })
        .pipe(Effect.mapError(mapVcsCommandError(operation, "vcs-route", cwd)));
    },
  );

  const commands = JjGitWorkflowAdapter.make(jj, git, (cwd) =>
    resolveDriverForCommand("GitWorkflowService.route", cwd).pipe(
      Effect.map((handle) => handle.kind === "jj"),
    ),
  );

  const detectForStatus = Effect.fn("GitWorkflowService.detectForStatus")(function* (
    operation: string,
    cwd: string,
  ) {
    return yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to detect a VCS repository for this Git workflow.",
            cause,
          }),
      ),
    );
  });

  const jjLocalStatus = Effect.fn("GitWorkflowService.jjLocalStatus")(function* (cwd: string) {
    return yield* jj.localStatus(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation: "GitWorkflowService.localStatus",
            cwd,
            detail: "Failed to read Jujutsu working-copy status.",
            cause,
          }),
      ),
    );
  });

  const localStatus: GitWorkflowService["Service"]["localStatus"] = Effect.fn(
    "GitWorkflowService.localStatus",
  )(function* (input) {
    const handle = yield* detectForStatus("GitWorkflowService.localStatus", input.cwd);
    if (!handle) return nonGitLocalStatus("unknown", false);
    if (handle.kind === "jj") return yield* jjLocalStatus(input.cwd);
    if (handle.kind === "git") return yield* gitManager.localStatus(input);
    return nonGitLocalStatus(handle.kind, true);
  });

  const remoteStatus: GitWorkflowService["Service"]["remoteStatus"] = Effect.fn(
    "GitWorkflowService.remoteStatus",
  )(function* (input, options) {
    const handle = yield* detectForStatus("GitWorkflowService.remoteStatus", input.cwd);
    return handle?.kind === "git" || handle?.kind === "jj"
      ? yield* gitManager.remoteStatus(input, options)
      : null;
  });

  const status: GitWorkflowService["Service"]["status"] = Effect.fn("GitWorkflowService.status")(
    function* (input) {
      const handle = yield* detectForStatus("GitWorkflowService.status", input.cwd);
      if (!handle) {
        return mergeGitStatusParts(nonGitLocalStatus("unknown", false), null);
      }
      if (handle.kind === "git") return yield* gitManager.status(input);
      if (handle.kind === "jj") {
        return mergeGitStatusParts(yield* jjLocalStatus(input.cwd), yield* remoteStatus(input));
      }
      return mergeGitStatusParts(nonGitLocalStatus(handle.kind, true), null);
    },
  );

  return GitWorkflowService.of({
    validateWorktreePath: (input) =>
      resolveDriverForCommand("GitWorkflowService.validateWorktreePath", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind !== "jj"
            ? Effect.void
            : jj
                .validateWorktreePath(input)
                .pipe(
                  Effect.mapError(
                    mapVcsCommandError(
                      "GitWorkflowService.validateWorktreePath",
                      "jj workspace list",
                      input.cwd,
                    ),
                  ),
                ),
        ),
      ),
    isRepository: (cwd) =>
      registry.detect({ cwd }).pipe(
        Effect.map((handle) => handle !== null),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.isRepository",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      ),
    hasCommit: (input) =>
      resolveDriverForCommand("GitWorkflowService.hasCommit", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj
                .execute({
                  cwd: input.cwd,
                  operation: "GitWorkflowService.hasCommit",
                  args: ["log", "-r", jjRef(input.refName), "--no-graph", "-T", "commit_id"],
                  allowNonZeroExit: true,
                })
                .pipe(
                  Effect.map(
                    (result) =>
                      result.exitCode === 0 && /^[a-f0-9]{40,64}$/.test(result.stdout.trim()),
                  ),
                  Effect.mapError(
                    mapVcsCommandError("GitWorkflowService.hasCommit", "jj log", input.cwd),
                  ),
                )
            : git
                .execute({
                  operation: "GitWorkflowService.hasCommit",
                  cwd: input.cwd,
                  args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
                  allowNonZeroExit: true,
                })
                .pipe(Effect.map((result) => result.exitCode === 0)),
        ),
      ),

    status,
    localStatus,
    remoteStatus,
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: commands.pullCurrentBranch,
    runStackedAction: gitManager.runStackedAction,
    resolvePullRequest: gitManager.resolvePullRequest,
    preparePullRequestThread: gitManager.preparePullRequestThread,
    listRefs: (input) =>
      registry.detect({ cwd: input.cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              cwd: input.cwd,
              operation: "GitWorkflowService.listRefs",
              command: "vcs-route",
              detail: "Failed to detect a VCS repository for this Git command.",
              cause,
            }),
        ),
        Effect.flatMap((handle) =>
          !handle
            ? Effect.succeed(nonRepositoryListRefs())
            : handle.kind === "jj"
              ? jj
                  .listRefs(input)
                  .pipe(
                    Effect.mapError(
                      mapVcsCommandError(
                        "GitWorkflowService.listRefs",
                        "jj bookmark/workspace list",
                        input.cwd,
                      ),
                    ),
                  )
              : git.listRefs(input),
        ),
      ),
    createWorktree: (input, options) =>
      resolveDriverForCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj
                .createWorktree({
                  ...input,
                  path:
                    input.path ??
                    NodePath.join(
                      worktreesDir,
                      NodePath.basename(input.cwd),
                      (input.newRefName ?? input.refName).replaceAll("/", "-"),
                    ),
                })
                .pipe(
                  Effect.mapError(
                    mapVcsCommandError(
                      "GitWorkflowService.createWorktree",
                      "jj workspace add",
                      input.cwd,
                    ),
                  ),
                )
            : git.createWorktree(input, options),
        ),
      ),
    listLocalBranchNames: (cwd) =>
      resolveDriverForCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? Effect.all([jj.listBookmarks(cwd), jj.listWorkspaces(cwd)]).pipe(
                Effect.map(([bookmarks, workspaces]) => [
                  ...bookmarks
                    .filter((bookmark) => bookmark.remoteName === null)
                    .map((bookmark) => bookmark.name),
                  ...workspaces.map((workspace) => `${workspace.name}@`),
                ]),
                Effect.mapError(
                  mapVcsCommandError(
                    "GitWorkflowService.listLocalBranchNames",
                    "jj bookmark/workspace list",
                    cwd,
                  ),
                ),
              )
            : git.listLocalBranchNames(cwd),
        ),
      ),
    fetchRemote: (input) =>
      resolveDriverForCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj
                .fetchRemote(input)
                .pipe(
                  Effect.mapError(
                    mapVcsCommandError("GitWorkflowService.fetchRemote", "jj git fetch", input.cwd),
                  ),
                )
            : git.fetchRemote(input),
        ),
      ),
    remoteExists: (input) =>
      resolveDriverForCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj.listRemotes(input.cwd).pipe(
                Effect.map((result) =>
                  result.remotes.some((remote) => remote.name === input.remoteName),
                ),
                Effect.mapError(
                  mapVcsCommandError(
                    "GitWorkflowService.remoteExists",
                    "jj git remote list",
                    input.cwd,
                  ),
                ),
              )
            : git.remoteExists(input),
        ),
      ),
    remoteBranchExists: (input) =>
      resolveDriverForCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj.listBookmarks(input.cwd).pipe(
                Effect.map((bookmarks) =>
                  bookmarks.some(
                    (bookmark) =>
                      bookmark.name === input.refName &&
                      bookmark.remoteName === input.remoteName &&
                      bookmark.target !== null,
                  ),
                ),
                Effect.mapError(
                  mapVcsCommandError(
                    "GitWorkflowService.remoteBranchExists",
                    "jj bookmark list",
                    input.cwd,
                  ),
                ),
              )
            : git.remoteBranchExists(input),
        ),
      ),
    resolveRemoteTrackingCommit: (input) =>
      resolveDriverForCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj
                .resolveRemoteTrackingCommit(input)
                .pipe(
                  Effect.mapError(
                    mapVcsCommandError(
                      "GitWorkflowService.resolveRemoteTrackingCommit",
                      "jj log",
                      input.cwd,
                    ),
                  ),
                )
            : git.resolveRemoteTrackingCommit(input),
        ),
      ),
    removeWorktree: (input) =>
      resolveDriverForCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj
                .removeWorktree(input)
                .pipe(
                  Effect.mapError(
                    mapVcsCommandError(
                      "GitWorkflowService.removeWorktree",
                      "jj workspace forget",
                      input.cwd,
                    ),
                  ),
                )
            : git.removeWorktree(input),
        ),
      ),
    recoverWorktree: (input) =>
      resolveDriverForCommand("GitWorkflowService.recoverWorktree", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj
                .recoverWorktree(input)
                .pipe(
                  Effect.mapError(
                    mapVcsCommandError(
                      "GitWorkflowService.recoverWorktree",
                      "jj workspace add",
                      input.cwd,
                    ),
                  ),
                )
            : git
                .pruneWorktrees({ cwd: input.cwd })
                .pipe(Effect.andThen(git.createWorktree(input)), Effect.asVoid),
        ),
      ),
    pruneWorktrees: (input) =>
      resolveDriverForCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj
                .pruneWorktrees(input.cwd)
                .pipe(
                  Effect.mapError(
                    mapVcsCommandError(
                      "GitWorkflowService.pruneWorktrees",
                      "jj workspace forget",
                      input.cwd,
                    ),
                  ),
                )
            : git.pruneWorktrees(input),
        ),
      ),
    deleteLocalBranch: (input) =>
      resolveDriverForCommand("GitWorkflowService.deleteLocalBranch", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj
                .execute({
                  cwd: input.cwd,
                  operation: "GitWorkflowService.deleteLocalBranch",
                  args: ["bookmark", "delete", "--", `exact:${input.refName}`],
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    mapVcsCommandError(
                      "GitWorkflowService.deleteLocalBranch",
                      "jj bookmark delete",
                      input.cwd,
                    ),
                  ),
                )
            : git.deleteLocalBranch(input),
        ),
      ),
    createRef: commands.createRef,
    switchRef: (input) => Effect.scoped(commands.switchRef(input)),
    renameBranch: (input) =>
      resolveDriverForCommand("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj
                .renameBookmark(input)
                .pipe(
                  Effect.mapError(
                    mapVcsCommandError(
                      "GitWorkflowService.renameBranch",
                      "jj bookmark rename",
                      input.cwd,
                    ),
                  ),
                )
            : git.renameBranch(input),
        ),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
