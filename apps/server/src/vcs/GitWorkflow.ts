import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { detectPrTemplate } from "../sourceControl/PrTemplateDetection.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import type { VcsWorkflow } from "./VcsWorkflow.ts";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import { GitCommandError } from "@t3tools/contracts";

/** Git-specific interpretation of refs/configuration stays at the driver boundary. */
export function make(git: GitVcsDriver.GitVcsDriver["Service"]): VcsWorkflow {
  const remoteUrl: VcsWorkflow["remoteUrl"] = (cwd, name) =>
    git.readConfigValue(cwd, `remote.${name}.url`);
  const refContext: VcsWorkflow["refContext"] = Effect.fnUntraced(function* (cwd, name) {
    const [local, remoteName, merge] = yield* Effect.all(
      [
        git.execute({
          cwd,
          operation: "GitWorkflow.refContext",
          args: ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
          allowNonZeroExit: true,
        }),
        git.readConfigValue(cwd, `branch.${name}.remote`),
        git.readConfigValue(cwd, `branch.${name}.merge`),
      ],
      { concurrency: "unbounded" },
    );
    if (local.exitCode !== 0 && local.exitCode !== 1)
      return yield* new GitCommandError({
        cwd,
        operation: "GitWorkflow.refContext",
        command: "git show-ref",
        detail: "Could not inspect the local ref.",
      });
    return {
      exists: local.exitCode === 0,
      publication: {
        name,
        remoteName: remoteName && merge ? remoteName : null,
        remoteRef: remoteName && merge ? merge.replace(/^refs\/heads\//, "") : null,
      },
    };
  });
  const probePublication: VcsWorkflow["probePublication"] = Effect.fnUntraced(
    function* (cwd, name, preferredRemote) {
      const [remotes, tracking, configuredRemote, configuredMerge] = yield* Effect.all(
        [
          git.execute({ cwd, operation: "GitWorkflow.probePublication.remotes", args: ["remote"] }),
          // Presence is enough; never enumerate a repository's remote history.
          git.execute({
            cwd,
            operation: "GitWorkflow.probePublication.any",
            args: ["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes"],
          }),
          git.readConfigValue(cwd, `branch.${name}.remote`),
          git.readConfigValue(cwd, `branch.${name}.merge`),
        ],
        { concurrency: "unbounded" },
      );
      if (remotes.stdoutTruncated || tracking.stdoutTruncated)
        return yield* new GitCommandError({
          cwd,
          operation: "GitWorkflow.probePublication",
          command: "git for-each-ref",
          detail: "Repository metadata exceeded the output limit.",
        });
      const remoteNames = remotes.stdout.trim().split("\n").filter(Boolean);
      const matching = (yield* Effect.forEach(
        remoteNames,
        (remote) =>
          git
            .execute({
              cwd,
              operation: "GitWorkflow.probePublication.exact",
              args: ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${name}`],
              allowNonZeroExit: true,
            })
            .pipe(
              Effect.flatMap((result) =>
                result.exitCode === 0 || result.exitCode === 1
                  ? Effect.succeed(result.exitCode === 0 ? remote : null)
                  : Effect.fail(
                      new GitCommandError({
                        cwd,
                        operation: "GitWorkflow.probePublication",
                        command: "git show-ref",
                        detail: "Could not inspect the remote ref.",
                      }),
                    ),
              ),
            ),
        { concurrency: "unbounded" },
      )).filter((remote) => remote !== null);
      if (preferredRemote === undefined && matching.length > 1)
        return yield* new GitCommandError({
          cwd,
          operation: "GitWorkflow.probePublication",
          command: "git show-ref",
          detail: `Multiple remotes track ${name}. Its pull request is ambiguous.`,
        });
      const remoteName = matching.includes(preferredRemote ?? "")
        ? (preferredRemote ?? null)
        : matching.includes("origin")
          ? "origin"
          : (matching[0] ?? null);
      return {
        remoteName,
        published:
          (configuredRemote !== null && configuredMerge !== null) || matching.length > 0
            ? true
            : tracking.stdout.trim()
              ? false
              : null,
      };
    },
  );
  return {
    kind: "git",
    refs: {
      validateWorktreePath: () => Effect.void,
      listRefs: git.listRefs,
      createWorktree: git.createWorktree,
      listLocalBranchNames: git.listLocalBranchNames,
      fetchRemote: git.fetchRemote,
      remoteExists: git.remoteExists,
      remoteBranchExists: git.remoteBranchExists,
      resolveRemoteTrackingCommit: git.resolveRemoteTrackingCommit,
      removeWorktree: git.removeWorktree,
      recoverWorktree: (input) =>
        git
          .pruneWorktrees({ cwd: input.cwd })
          .pipe(Effect.andThen(git.createWorktree(input)), Effect.asVoid),
      deleteLocalBranch: git.deleteLocalBranch,
      createRef: git.createRef,
      switchRef: (input) => Effect.scoped(git.switchRef(input)),
      renameBranch: git.renameBranch,
    },
    template: (cwd, revision) =>
      detectPrTemplate(cwd, revision, git.execute).pipe(Effect.map(Option.getOrNull)),
    state: Effect.fnUntraced(function* (cwd, options) {
      const remote = !options?.localOnly ? yield* git.statusDetailsRemote(cwd, options) : null;
      const local =
        options?.remoteOnly && remote
          ? {
              ...remote,
              hasOriginRemote: false,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }
          : yield* git.statusDetailsLocal(cwd, { includeDivergence: false });
      const publication =
        remote?.publication ??
        (local.branch ? { name: local.branch, remoteName: null, remoteRef: null } : null);
      return {
        local: {
          kind: "git",
          isRepo: local.isRepo,
          refName: local.branch,
          isDefaultRef: local.isDefaultBranch,
          hasPrimaryRemote: local.hasOriginRemote,
          hasWorkingTreeChanges: local.hasWorkingTreeChanges,
          workingTree: local.workingTree,
        },
        publication,
        defaultRef: remote?.defaultBranch ?? null,
        remote: {
          hasUpstream: remote?.hasUpstream ?? false,
          aheadCount: remote?.aheadCount ?? 0,
          behindCount: remote?.behindCount ?? 0,
          aheadOfDefaultCount: remote?.aheadOfDefaultCount ?? 0,
        },
      };
    }),
    refContext,
    publicationRemote: (cwd, name) => git.readConfigValue(cwd, `branch.${name}.remote`),
    probePublication,
    prBaseRef: (cwd, name) => git.readConfigValue(cwd, `branch.${name}.gh-merge-base`),
    remoteUrl,
    primaryRemote: git.resolvePrimaryRemoteName,
    defaultRef: git.resolveDefaultBranchName,
    remoteRevision: (cwd, refName, remoteName) =>
      git
        .resolveRemoteTrackingCommit({ cwd, refName, fallbackRemoteName: remoteName })
        .pipe(Effect.map((result) => result.commitSha)),
    recentSubjects: (cwd) =>
      git
        .execute({
          cwd,
          operation: "GitWorkflow.recentSubjects",
          args: ["log", "-n", "20", "--no-merges", "--pretty=format:%s"],
        })
        .pipe(Effect.map((result) => result.stdout.trim().split("\n").filter(Boolean))),
    prepareCommit: (cwd, paths) =>
      git
        .prepareCommitContext(cwd, paths)
        .pipe(
          Effect.map((context) =>
            context ? { summary: context.stagedSummary, patch: context.stagedPatch } : null,
          ),
        ),
    recordCommit: (input) =>
      git.commit(input.cwd, input.subject, input.body, {
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.progress ? { progress: input.progress } : {}),
      }),
    publish: git.pushCurrentBranch,
    fetch: git.pullCurrentBranch,
    range: git.readRangeContext,
    createFeatureRef: Effect.fnUntraced(function* (cwd, preferredName) {
      const name = resolveAutoFeatureBranchName(
        yield* git.listLocalBranchNames(cwd),
        preferredName,
      );
      yield* git.createRef({ cwd, refName: name });
      yield* Effect.scoped(git.switchRef({ cwd, refName: name }));
      return name;
    }),
  };
}
