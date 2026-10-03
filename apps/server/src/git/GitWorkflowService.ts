import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  GitCommandError,
  type GitManagerServiceError,
  type VcsPullResult,
} from "@t3tools/contracts";
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
      | "status"
      | "localStatus"
      | "remoteStatus"
    > & {
      readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
      readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    }
>()("t3/git/GitWorkflowService") {}

/** App facade: refs use the selected workflow; status/actions stay with the manager. */
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
  return GitWorkflowService.of({
    isRepository: (cwd) => detect(cwd).pipe(Effect.map((handle) => handle !== null)),
    status: manager.status,
    localStatus: manager.localStatus,
    remoteStatus: manager.remoteStatus,
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
    deleteLocalBranch: (input) => refs(input.cwd, (refs) => refs.deleteLocalBranch(input)),
    createRef: (input) => refs(input.cwd, (refs) => refs.createRef(input)),
    switchRef: (input) => refs(input.cwd, (refs) => refs.switchRef(input)),
    renameBranch: (input) => refs(input.cwd, (refs) => refs.renameBranch(input)),
  });
});
export const layer = Layer.effect(GitWorkflowService, make);
