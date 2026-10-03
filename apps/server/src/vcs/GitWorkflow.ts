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
  const refContext: VcsWorkflow["refContext"] = Effect.fnUntraced(
    function* (cwd, name, remoteOverride) {
      const [mergeBase, remotes, local, tracking] = yield* Effect.all([
        git.readConfigValue(cwd, `branch.${name}.gh-merge-base`),
        git.execute({ cwd, operation: "GitWorkflow.refContext.remotes", args: ["remote"] }),
        git.execute({
          cwd,
          operation: "GitWorkflow.refContext.local",
          args: [
            "for-each-ref",
            "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)",
            `refs/heads/${name}`,
          ],
        }),
        git.execute({
          cwd,
          operation: "GitWorkflow.refContext.tracking",
          args: ["for-each-ref", "--format=%(refname)", "refs/remotes"],
        }),
      ]);
      const saved = local.stdout
        .split("\n")
        .find((row) => row.split("\0")[0] === `refs/heads/${name}`)
        ?.split("\0");
      if (saved?.[1] && (!saved[2] || !saved[3]))
        return yield* new GitCommandError({
          cwd,
          operation: "GitWorkflow.refContext",
          command: "git for-each-ref",
          detail: `Saved upstream for ${name} is incomplete.`,
        });
      const configuredRemote = saved?.[2] || null;
      const merge = saved?.[3] || null;
      const remoteNames = remotes.stdout.trim().split("\n").filter(Boolean);
      const refs = new Set(tracking.stdout.trim().split("\n"));
      const matching = remoteNames.filter((remote) => refs.has(`refs/remotes/${remote}/${name}`));
      if (!saved && remoteOverride === undefined && matching.length > 1)
        return yield* new GitCommandError({
          cwd,
          operation: "GitWorkflow.refContext",
          command: "git for-each-ref",
          detail: `Multiple remotes track ${name}. Its pull request is ambiguous.`,
        });
      const remoteName =
        remoteOverride ??
        (saved?.[2] || configuredRemote) ??
        (matching.includes("origin") ? "origin" : (matching[0] ?? null));
      return {
        exists: saved !== undefined,
        publication: {
          name,
          remoteName,
          remoteRef:
            remoteName === configuredRemote && merge
              ? merge.replace(/^refs\/heads\//, "")
              : matching.includes(remoteName ?? "")
                ? name
                : null,
        },
        mergeBase,
        trackingRemote: matching.includes(remoteOverride ?? configuredRemote ?? "")
          ? (remoteOverride ?? configuredRemote)
          : matching.includes("origin")
            ? "origin"
            : (matching[0] ?? null),
        published:
          (configuredRemote !== null && merge !== null) ||
          matching.length > 0 ||
          tracking.stdout.trim() === "",
      };
    },
  );
  return {
    kind: "git",
    refs: {
      validateWorktreePath: () => Effect.void,
      hasCommit: (input) =>
        git
          .execute({
            cwd: input.cwd,
            operation: "GitWorkflow.hasCommit",
            args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
            allowNonZeroExit: true,
          })
          .pipe(Effect.map((result) => result.exitCode === 0)),
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
      pruneWorktrees: git.pruneWorktrees,
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
