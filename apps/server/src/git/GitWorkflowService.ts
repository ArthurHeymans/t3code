import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import {
  GitCommandError,
  type GitManagerServiceError,
  type VcsPullResult,
} from "@t3tools/contracts";
import * as GitManager from "./GitManager.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type { VcsRefOperations } from "../vcs/VcsWorkflow.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitWorkflow from "../vcs/GitWorkflow.ts";
import { jjRef } from "../vcs/jjExpressions.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  VcsRefOperations &
    Pick<
      GitManager.GitManager["Service"],
      | "invalidateLocalStatus"
      | "invalidateRemoteStatus"
      | "invalidateStatus"
      | "runStackedAction"
      | "resolvePullRequest"
      | "preparePullRequestThread"
      | "status"
      | "localStatus"
      | "remoteStatus"
    > & {
      readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
      readonly hasCommit: (input: {
        readonly cwd: string;
        readonly refName: string;
      }) => Effect.Effect<boolean, GitCommandError>;
      readonly hasRefNamed: (input: {
        readonly cwd: string;
        readonly refName: string;
      }) => Effect.Effect<boolean, GitCommandError>;
      readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
      readonly fetchWorktreeBaseCommit: GitVcsDriver.GitVcsDriver["Service"]["fetchWorktreeBaseCommit"];
      readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    }
>()("t3/git/GitWorkflowService") {}

/** App facade: refs use the selected workflow; status/actions stay with the manager. */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const manager = yield* GitManager.GitManager;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const routeError = (cwd: string) => (cause: unknown) =>
    new GitCommandError({
      cwd,
      operation: "GitWorkflowService.route",
      command: "vcs-route",
      detail: "Could not resolve the repository workflow.",
      cause,
    });
  const detect = (cwd: string) =>
    registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            cwd,
            operation: "GitWorkflowService.listRefs",
            command: "vcs-route",
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
  const workflow = (cwd: string) =>
    registry.resolve({ cwd }).pipe(
      Effect.mapError(routeError(cwd)),
      Effect.flatMap((handle) =>
        handle.kind !== "jj"
          ? Effect.succeed(GitWorkflow.make(git))
          : handle.driver.workflow
            ? Effect.succeed(handle.driver.workflow)
            : Effect.fail(routeError(cwd)("This repository has no source-control workflow.")),
      ),
    );
  const refs = <A, E, R>(
    cwd: string,
    operation: (refs: VcsRefOperations) => Effect.Effect<A, E, R>,
  ) => workflow(cwd).pipe(Effect.flatMap((workflow) => operation(workflow.refs)));
  const withCheckoutLease = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    registry.resolve({ cwd }).pipe(
      Effect.mapError(routeError(cwd)),
      Effect.flatMap((handle) =>
        fileSystem.realPath(handle.repository.rootPath).pipe(
          Effect.orElseSucceed(() => handle.repository.rootPath),
          Effect.flatMap((root) => withWorkspaceLease(root, effect)),
        ),
      ),
    );
  const resolveWorktreeBaseRemote: GitWorkflowService["Service"]["resolveWorktreeBaseRemote"] =
    Effect.fn("GitWorkflowService.resolveWorktreeBaseRemote")(function* (input) {
      const selected = yield* workflow(input.cwd);
      if (selected.kind === "git") return yield* git.resolveWorktreeBaseRemote(input);
      const handle = yield* registry
        .resolve({ cwd: input.cwd })
        .pipe(Effect.mapError(routeError(input.cwd)));
      const remotes = yield* handle.driver
        .listRemotes(input.cwd)
        .pipe(Effect.mapError(routeError(input.cwd)));
      const explicit = remotes.remotes.find((remote) =>
        input.refName.startsWith(`${remote.name}/`),
      );
      if (explicit)
        return {
          remoteName: explicit.name,
          branchName: input.refName.slice(explicit.name.length + 1),
        };
      const at = input.refName.lastIndexOf("@");
      if (at > 0 && remotes.remotes.some((remote) => remote.name === input.refName.slice(at + 1))) {
        return { remoteName: input.refName.slice(at + 1), branchName: input.refName.slice(0, at) };
      }
      const context = yield* selected.refContext(input.cwd, input.refName);
      const remoteName =
        context.publication.remoteName ?? (yield* selected.primaryRemote(input.cwd));
      return { remoteName, branchName: input.refName };
    });
  return GitWorkflowService.of({
    hasCommit: Effect.fn("GitWorkflowService.hasCommit")(function* (input) {
      const handle = yield* registry
        .resolve({ cwd: input.cwd })
        .pipe(Effect.mapError(routeError(input.cwd)));
      const result = yield* handle.driver
        .execute({
          operation: "GitWorkflowService.hasCommit",
          cwd: input.cwd,
          args:
            handle.kind === "jj"
              ? [
                  "log",
                  "--ignore-working-copy",
                  "-r",
                  jjRef(input.refName),
                  "--no-graph",
                  "--limit",
                  "1",
                  "-T",
                  "commit_id",
                ]
              : ["rev-parse", "--verify", `${input.refName}^{commit}`],
          allowNonZeroExit: true,
        })
        .pipe(Effect.mapError(routeError(input.cwd)));
      return result.exitCode === 0 && result.stdout.trim().length > 0;
    }),
    hasRefNamed: Effect.fn("GitWorkflowService.hasRefNamed")(function* (input) {
      const selected = yield* workflow(input.cwd);
      if (selected.kind === "jj")
        return (yield* selected.refContext(input.cwd, input.refName)).exists;
      if (/[*?[\\\\]/.test(input.refName)) return false;
      const result = yield* git.execute({
        operation: "GitWorkflowService.hasRefNamed",
        cwd: input.cwd,
        args: ["for-each-ref", "--count=1", "--format=%(refname)", `refs/**/${input.refName}`],
      });
      return result.stdout.trim().length > 0;
    }),
    resolveWorktreeBaseRemote,
    fetchWorktreeBaseCommit: Effect.fn("GitWorkflowService.fetchWorktreeBaseCommit")(
      function* (input) {
        const selected = yield* workflow(input.cwd);
        if (selected.kind === "git") return yield* git.fetchWorktreeBaseCommit(input);
        const target = yield* resolveWorktreeBaseRemote(input);
        if (target === null) return null;
        yield* selected.refs.fetchRemote({
          cwd: input.cwd,
          remoteName: target.remoteName,
          refName: target.branchName,
        });
        return yield* selected.refs.resolveRemoteTrackingCommit({
          cwd: input.cwd,
          refName: target.branchName,
          fallbackRemoteName: target.remoteName,
        });
      },
    ),
    isRepository: (cwd) => detect(cwd).pipe(Effect.map((handle) => handle !== null)),
    status: manager.status,
    localStatus: manager.localStatus,
    remoteStatus: manager.remoteStatus,
    invalidateLocalStatus: manager.invalidateLocalStatus,
    invalidateRemoteStatus: manager.invalidateRemoteStatus,
    invalidateStatus: manager.invalidateStatus,
    runStackedAction: (input, options) =>
      input.featureBranch
        ? withCheckoutLease(input.cwd, manager.runStackedAction(input, options))
        : manager.runStackedAction(input, options),
    resolvePullRequest: manager.resolvePullRequest,
    preparePullRequestThread: (input) =>
      input.mode === "local"
        ? withCheckoutLease(input.cwd, manager.preparePullRequestThread(input))
        : manager.preparePullRequestThread(input),
    pullCurrentBranch: (cwd) =>
      workflow(cwd).pipe(Effect.flatMap((workflow) => workflow.fetch(cwd))),
    listRefs: (input) =>
      detect(input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle
            ? refs(input.cwd, (refs) => refs.listRefs(input))
            : Effect.succeed({
                refs: [],
                isRepo: false,
                hasPrimaryRemote: false,
                nextCursor: null,
                totalCount: 0,
              }),
        ),
      ),
    validateWorktreePath: (input) => refs(input.cwd, (refs) => refs.validateWorktreePath(input)),
    createWorktree: manager.createWorktree,
    listLocalBranchNames: (cwd) => refs(cwd, (refs) => refs.listLocalBranchNames(cwd)),
    fetchRemote: (input) => refs(input.cwd, (refs) => refs.fetchRemote(input)),
    remoteExists: (input) => refs(input.cwd, (refs) => refs.remoteExists(input)),
    remoteBranchExists: (input) => refs(input.cwd, (refs) => refs.remoteBranchExists(input)),
    resolveRemoteTrackingCommit: (input) =>
      refs(input.cwd, (refs) => refs.resolveRemoteTrackingCommit(input)),
    removeWorktree: (input) => refs(input.cwd, (refs) => refs.removeWorktree(input)),
    pruneWorktrees: (input) => refs(input.cwd, (refs) => refs.pruneWorktrees(input)),
    recoverWorktree: (input) => refs(input.cwd, (refs) => refs.recoverWorktree(input)),
    deleteLocalBranch: (input) => refs(input.cwd, (refs) => refs.deleteLocalBranch(input)),
    createRef: (input) =>
      input.switchRef
        ? withCheckoutLease(
            input.cwd,
            refs(input.cwd, (refs) => refs.createRef(input)),
          )
        : refs(input.cwd, (refs) => refs.createRef(input)),
    switchRef: (input) =>
      withCheckoutLease(
        input.cwd,
        refs(input.cwd, (refs) => refs.switchRef(input)),
      ),
    renameBranch: (input) => refs(input.cwd, (refs) => refs.renameBranch(input)),
  });
});
export const layer = Layer.effect(GitWorkflowService, make);
