import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  GitCommandError,
  GitManagerError,
  type GitManagerServiceError,
  type VcsPullResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import * as GitManager from "./GitManager.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type { VcsRefOperations } from "../vcs/VcsWorkflow.ts";

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
    > & {
      readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
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
      readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    }
>()("t3/git/GitWorkflowService") {}

const nonRepositoryStatus: VcsStatusLocalResult = {
  kind: "unknown",
  isRepo: false,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

/** Routing ends here; backend semantics belong to the selected driver. */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const manager = yield* GitManager.GitManager;
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
  const detectForStatus = (cwd: string, operation: string) =>
    registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            cwd,
            operation,
            detail: "Failed to detect a VCS repository for this Git workflow.",
            cause,
          }),
      ),
    );

  const workflow = (cwd: string) =>
    registry.resolve({ cwd }).pipe(
      Effect.mapError(routeError(cwd)),
      Effect.flatMap((handle) =>
        handle.driver.workflow
          ? Effect.succeed(handle.driver.workflow)
          : Effect.fail(routeError(cwd)("This repository has no source-control workflow.")),
      ),
    );
  const refs = <A, E, R>(
    cwd: string,
    operation: (refs: VcsRefOperations) => Effect.Effect<A, E, R>,
  ) => workflow(cwd).pipe(Effect.flatMap((workflow) => operation(workflow.refs)));
  const localStatus: GitWorkflowService["Service"]["localStatus"] = (input) =>
    detectForStatus(input.cwd, "GitWorkflowService.localStatus").pipe(
      Effect.flatMap((handle) =>
        handle ? manager.localStatus(input) : Effect.succeed(nonRepositoryStatus),
      ),
    );
  const remoteStatus: GitWorkflowService["Service"]["remoteStatus"] = (input, options) =>
    detectForStatus(input.cwd, "GitWorkflowService.remoteStatus").pipe(
      Effect.flatMap((handle) =>
        handle ? manager.remoteStatus(input, options) : Effect.succeed(null),
      ),
    );
  const status: GitWorkflowService["Service"]["status"] = (input) =>
    detectForStatus(input.cwd, "GitWorkflowService.status").pipe(
      Effect.flatMap((handle) =>
        handle
          ? manager.status(input)
          : Effect.succeed(mergeGitStatusParts(nonRepositoryStatus, null)),
      ),
    );
  return GitWorkflowService.of({
    isRepository: (cwd) => detect(cwd).pipe(Effect.map((handle) => handle !== null)),
    status,
    localStatus,
    remoteStatus,
    invalidateLocalStatus: manager.invalidateLocalStatus,
    invalidateRemoteStatus: manager.invalidateRemoteStatus,
    invalidateStatus: manager.invalidateStatus,
    runStackedAction: manager.runStackedAction,
    resolvePullRequest: manager.resolvePullRequest,
    preparePullRequestThread: manager.preparePullRequestThread,
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
    hasCommit: (input) => refs(input.cwd, (refs) => refs.hasCommit(input)),
    createWorktree: (input, options) =>
      refs(input.cwd, (refs) => refs.createWorktree(input, options)),
    listLocalBranchNames: (cwd) => refs(cwd, (refs) => refs.listLocalBranchNames(cwd)),
    fetchRemote: (input) => refs(input.cwd, (refs) => refs.fetchRemote(input)),
    remoteExists: (input) => refs(input.cwd, (refs) => refs.remoteExists(input)),
    remoteBranchExists: (input) => refs(input.cwd, (refs) => refs.remoteBranchExists(input)),
    resolveRemoteTrackingCommit: (input) =>
      refs(input.cwd, (refs) => refs.resolveRemoteTrackingCommit(input)),
    removeWorktree: (input) => refs(input.cwd, (refs) => refs.removeWorktree(input)),
    recoverWorktree: (input) => refs(input.cwd, (refs) => refs.recoverWorktree(input)),
    pruneWorktrees: (input) => refs(input.cwd, (refs) => refs.pruneWorktrees(input)),
    deleteLocalBranch: (input) => refs(input.cwd, (refs) => refs.deleteLocalBranch(input)),
    createRef: (input) => refs(input.cwd, (refs) => refs.createRef(input)),
    switchRef: (input) => refs(input.cwd, (refs) => refs.switchRef(input)),
    renameBranch: (input) => refs(input.cwd, (refs) => refs.renameBranch(input)),
  });
});
export const layer = Layer.effect(GitWorkflowService, make);
