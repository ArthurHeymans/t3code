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
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitVcsDriver.GitRemoteStatusOptions,
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
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
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

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
      });
    }
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
  });

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return false;
    }
    if (handle.kind !== "git") {
      return yield* new GitCommandError({
        operation,
        command: "vcs-route",
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      });
    }
    return true;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

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
    return handle?.kind === "git" ? yield* gitManager.remoteStatus(input, options) : null;
  });

  const status: GitWorkflowService["Service"]["status"] = Effect.fn("GitWorkflowService.status")(
    function* (input) {
      const handle = yield* detectForStatus("GitWorkflowService.status", input.cwd);
      if (!handle) {
        return mergeGitStatusParts(nonGitLocalStatus("unknown", false), null);
      }
      if (handle.kind === "git") return yield* gitManager.status(input);
      if (handle.kind === "jj") {
        return mergeGitStatusParts(yield* jjLocalStatus(input.cwd), null);
      }
      return mergeGitStatusParts(nonGitLocalStatus(handle.kind, true), null);
    },
  );

  return GitWorkflowService.of({
    status,
    localStatus,
    remoteStatus,
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: (cwd) =>
      ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      ),
    runStackedAction: (input, options) =>
      ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.andThen(gitManager.runStackedAction(input, options)),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: routeGitManager(
      "GitWorkflowService.preparePullRequestThread",
      gitManager.preparePullRequestThread,
    ),
    listRefs: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    createWorktree: (input) =>
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
            : git.createWorktree(input),
        ),
      ),
    listLocalBranchNames: (cwd) =>
      resolveDriverForCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? Effect.all([jj.listBookmarks(cwd), jj.listWorkspaces(cwd)]).pipe(
                Effect.map(([bookmarks, workspaces]) => [
                  ...bookmarks.map((bookmark) => bookmark.name),
                  ...workspaces.map((workspace) => workspace.name),
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
      ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
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
    pruneWorktrees: (input) =>
      ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.andThen(git.pruneWorktrees(input)),
      ),
    deleteLocalBranch: (input) =>
      resolveDriverForCommand("GitWorkflowService.deleteLocalBranch", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj" ? Effect.void : git.deleteLocalBranch(input),
        ),
      ),
    createRef: (input) =>
      ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.andThen(git.createRef(input)),
      ),
    switchRef: (input) =>
      ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.andThen(Effect.scoped(git.switchRef(input))),
      ),
    renameBranch: (input) =>
      resolveDriverForCommand("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle.kind === "jj"
            ? jj
                .renameWorkspace({ cwd: input.cwd, newName: input.newBranch })
                .pipe(
                  Effect.mapError(
                    mapVcsCommandError(
                      "GitWorkflowService.renameBranch",
                      "jj workspace rename",
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
