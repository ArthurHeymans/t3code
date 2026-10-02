import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import type { JjVcsDriverShape } from "./JjVcsDriver.ts";
import { jjCommit, jjRef, jjFile, jjString } from "./jjExpressions.ts";

/** Reuse hosting/text-generation orchestration, but keep user-history writes native to jj. */
export function make(
  jj: JjVcsDriverShape,
  git: GitVcsDriver.GitVcsDriver["Service"],
  resolveJj?: (cwd: string) => Effect.Effect<boolean, GitCommandError>,
) {
  const error = (cwd: string, detail: string) =>
    new GitCommandError({
      cwd,
      operation: "JjGitWorkflowAdapter",
      command: "jj",
      detail,
    });
  const mapError = (cwd: string) => (cause: unknown) =>
    error(cwd, cause instanceof Error ? cause.message : String(cause));
  const run = (cwd: string, args: readonly string[]) =>
    jj
      .execute({
        cwd,
        args,
        operation: "JjGitWorkflowAdapter",
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
        env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
        allowNonZeroExit: true,
        outputMode: "error",
      })
      .pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(error(cwd, result.stderr.trim() || "Jujutsu command failed.")),
        ),
        Effect.mapError(mapError(cwd)),
      );
  const isJj =
    resolveJj ?? ((cwd: string) => jj.isInsideWorkTree(cwd).pipe(Effect.mapError(mapError(cwd))));
  const primaryRemote = Effect.fnUntraced(function* (cwd: string) {
    const remotes = (yield* jj.listRemotes(cwd).pipe(Effect.mapError(mapError(cwd)))).remotes;
    const remote =
      remotes.find((remote) => remote.isPrimary) ?? (remotes.length === 1 ? remotes[0] : undefined);
    if (!remote)
      return yield* error(
        cwd,
        "Choose an origin remote (or configure one unambiguous remote) before publishing.",
      );
    return remote.name;
  });
  const remoteForBranch = Effect.fnUntraced(function* (cwd: string, branch: string | null) {
    const tracked = (yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)))).filter(
      (bookmark) => bookmark.name === branch && bookmark.remoteName !== null && bookmark.tracked,
    );
    if (tracked.length === 1 && tracked[0]?.remoteName) return tracked[0].remoteName;
    const configured = yield* run(cwd, ["config", "get", "git.push"]).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (configured) return configured;
    return yield* primaryRemote(cwd);
  });
  const defaultBranch = Effect.fnUntraced(function* (cwd: string) {
    const target = yield* run(cwd, ["log", "-r", "trunk()", "--no-graph", "-T", "commit_id"]);
    const bookmarks = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
    const candidates = bookmarks.filter((bookmark) => bookmark.target === target);
    return (
      candidates.find((bookmark) => bookmark.name === "main" || bookmark.name === "master")?.name ??
      candidates.find((bookmark) => bookmark.remoteName !== null)?.name ??
      candidates.find((bookmark) => bookmark.remoteName === null)?.name ??
      bookmarks.find((bookmark) => bookmark.name === "main" || bookmark.name === "master")?.name ??
      null
    );
  });
  const count = (cwd: string, revset: string) =>
    run(cwd, [
      "log",
      "--ignore-working-copy",
      "-r",
      `(${revset}) ~ (@ & empty() & description(exact:""))`,
      "--no-graph",
      "-T",
      '"x\\n"',
    ]).pipe(Effect.map((text) => (text ? text.split("\n").length : 0)));
  const details = Effect.fnUntraced(function* (cwd: string) {
    const local = yield* jj.localStatus(cwd).pipe(Effect.mapError(mapError(cwd)));
    const bookmarks = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
    const branch = local.refName;
    const head = bookmarks.find(
      (bookmark) => bookmark.remoteName === null && bookmark.name === branch,
    )?.target;
    const remoteName = yield* remoteForBranch(cwd, branch).pipe(Effect.orElseSucceed(() => null));
    const upstream = bookmarks.find(
      (bookmark) => bookmark.name === branch && bookmark.remoteName === remoteName,
    )?.target;
    const baseBranch = yield* defaultBranch(cwd);
    const base =
      bookmarks.find(
        (bookmark) => bookmark.name === baseBranch && bookmark.remoteName === remoteName,
      )?.target ??
      bookmarks.find((bookmark) => bookmark.name === baseBranch && bookmark.remoteName === null)
        ?.target;
    const historyBase = upstream ?? base;
    return {
      isRepo: true,
      hasOriginRemote: remoteName !== null,
      branch,
      defaultBranch: baseBranch,
      isDefaultBranch: branch !== null && branch === baseBranch,
      upstreamRef: upstream && remoteName && branch ? `${remoteName}/${branch}` : null,
      hasUpstream: upstream !== undefined && upstream !== null,
      hasWorkingTreeChanges: local.hasWorkingTreeChanges,
      workingTree: local.workingTree,
      aheadCount: head
        ? yield* count(cwd, `${historyBase ? jjCommit(historyBase) : "root()"}..${jjCommit(head)}`)
        : 0,
      behindCount:
        head && upstream ? yield* count(cwd, `${jjCommit(head)}..${jjCommit(upstream)}`) : 0,
      aheadOfDefaultCount:
        head && base ? yield* count(cwd, `${jjCommit(base)}..${jjCommit(head)}`) : 0,
    };
  });
  const selectedPaths = Effect.fnUntraced(function* (
    cwd: string,
    filePaths: readonly string[] | undefined,
  ) {
    if (!filePaths) return undefined;
    const fields = (yield* run(cwd, [
      "log",
      "--ignore-working-copy",
      "-r",
      "@",
      "--no-graph",
      "-T",
      'self.diff().files().map(|f| f.status() ++ "\\0" ++ f.source().path() ++ "\\0" ++ f.target().path() ++ "\\0").join("")',
    ])).split("\0");
    const renamedPaths = fields.flatMap((status, index) => {
      const from = fields[index + 1],
        to = fields[index + 2];
      return index % 3 === 0 &&
        status === "renamed" &&
        from &&
        to &&
        (filePaths.includes(from) || filePaths.includes(to))
        ? [from, to]
        : [];
    });
    return [...new Set([...filePaths, ...renamedPaths])];
  });
  const prepare: GitVcsDriver.GitVcsDriver["Service"]["prepareCommitContext"] = Effect.fnUntraced(
    function* (cwd, filePaths) {
      yield* jj.currentChange(cwd).pipe(Effect.mapError(mapError(cwd)));
      const paths = (yield* selectedPaths(cwd, filePaths))?.map(jjFile) ?? [];
      const names = yield* run(cwd, [
        "diff",
        "--ignore-working-copy",
        "--name-only",
        "-r",
        "@",
        "--",
        ...paths,
      ]);
      if (!names) return null;
      const summary = yield* run(cwd, ["diff", "--stat", "-r", "@", "--", ...paths]);
      return {
        stagedSummary: summary,
        stagedPatch: yield* run(cwd, ["diff", "--git", "-r", "@", "--", ...paths]),
      };
    },
  );
  const commit: GitVcsDriver.GitVcsDriver["Service"]["commit"] = Effect.fnUntraced(
    function* (cwd, subject, body, options) {
      const status = yield* jj.localStatus(cwd).pipe(Effect.mapError(mapError(cwd)));
      const bookmark = options?.refName ?? status.refName;
      const message = body ? `${subject}\n\n${body}` : subject;
      const base = yield* defaultBranch(cwd);
      const bookmarks = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
      if (
        bookmark &&
        (!bookmarks.some(
          (candidate) =>
            candidate.remoteName === null &&
            candidate.name === bookmark &&
            candidate.target !== null &&
            !candidate.conflict,
        ) ||
          (status.refName !== bookmark && !status.jj?.bookmarks.includes(bookmark)))
      )
        return yield* error(
          cwd,
          "The selected bookmark is no longer associated with this working-copy change. Refresh before committing.",
        );
      const trunkOwnsChange =
        base !== null &&
        (yield* run(cwd, [
          "log",
          "--ignore-working-copy",
          "-r",
          `@ & bookmarks(exact:${jjString(base)})`,
          "--no-graph",
          "-T",
          "commit_id",
        ])) !== "";
      const explicitlyOnTrunk =
        options?.allowDefaultRef === true && bookmark !== null && bookmark === base;
      if (
        !explicitlyOnTrunk &&
        (trunkOwnsChange ||
          (bookmark && (bookmark === base || (bookmark === status.refName && status.isDefaultRef))))
      )
        return yield* error(
          cwd,
          "Create a separate feature change before committing from trunk, or explicitly commit to the default bookmark.",
        );
      // jj commit is atomic and leaves selected changes (and their bookmarks)
      // in the first commit; unselected changes stay in the child working copy.
      yield* run(cwd, [
        "commit",
        "-m",
        message,
        "--",
        ...((yield* selectedPaths(cwd, options?.filePaths))?.map(jjFile) ?? []),
      ]);
      const commitSha = yield* run(cwd, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
      if (bookmark)
        yield* run(cwd, [
          "bookmark",
          "move",
          "--to",
          jjCommit(commitSha),
          "--",
          `exact:${bookmark}`,
        ]);
      return { commitSha };
    },
  );
  const push: GitVcsDriver.GitVcsDriver["Service"]["pushCurrentBranch"] = Effect.fnUntraced(
    function* (cwd, fallbackBranch, options) {
      const branch =
        fallbackBranch ?? (yield* jj.localStatus(cwd).pipe(Effect.mapError(mapError(cwd)))).refName;
      const change = yield* jj.currentChange(cwd).pipe(Effect.mapError(mapError(cwd)));
      const bookmark = (yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)))).find(
        (bookmark) => bookmark.name === branch && bookmark.remoteName === null,
      );
      if (!branch || !bookmark?.target || bookmark.conflict)
        return yield* error(
          cwd,
          "Publishing requires one unambiguous local bookmark. Create or select a bookmark first.",
        );
      if (bookmark.target === change?.commitId && change.description === null)
        return yield* error(
          cwd,
          "Commit or describe the working-copy change before publishing it.",
        );
      const remote = options?.remoteName ?? (yield* remoteForBranch(cwd, branch));
      // Never --all/--tracked: a thread action must not publish other users' work.
      yield* run(cwd, ["git", "push", "--remote", remote, "--bookmark", `exact:${branch}`]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${remote}/${branch}`,
        setUpstream: true,
      };
    },
  );
  const pull: GitVcsDriver.GitVcsDriver["Service"]["pullCurrentBranch"] = Effect.fnUntraced(
    function* (cwd) {
      const before = yield* jj.localStatus(cwd).pipe(Effect.mapError(mapError(cwd)));
      const remote = yield* remoteForBranch(cwd, before.refName);
      // Fetch imports remote changes and jj updates tracked bookmarks. Do not
      // secretly rebase or replace the user's current working-copy change.
      const beforeBookmarks = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
      yield* jj.fetchRemote({ cwd, remoteName: remote }).pipe(Effect.mapError(mapError(cwd)));
      const afterBookmarks = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
      const changed =
        beforeBookmarks.length !== afterBookmarks.length ||
        afterBookmarks.some(
          (bookmark) =>
            !beforeBookmarks.some(
              (old) =>
                old.name === bookmark.name &&
                old.remoteName === bookmark.remoteName &&
                old.target === bookmark.target &&
                old.conflict === bookmark.conflict,
            ),
        );
      return {
        status: changed ? ("pulled" as const) : ("skipped_up_to_date" as const),
        refName: before.refName ?? "@",
        upstreamRef: before.refName ? `${before.refName}@${remote}` : null,
      };
    },
  );
  const readConfig: GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"] = Effect.fnUntraced(
    function* (cwd, key) {
      const remoteKey = /^remote\.(.+)\.url$/.exec(key);
      if (remoteKey?.[1])
        return (
          (yield* jj.listRemotes(cwd).pipe(Effect.mapError(mapError(cwd)))).remotes.find(
            (remote) => remote.name === remoteKey[1],
          )?.url ?? null
        );
      const branchRemote = /^branch\.(.+)\.remote$/.exec(key);
      if (branchRemote?.[1])
        return yield* remoteForBranch(cwd, branchRemote[1]).pipe(Effect.orElseSucceed(() => null));
      const branchMerge = /^branch\.(.+)\.merge$/.exec(key);
      if (branchMerge?.[1]) {
        const bookmark = (yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)))).find(
          (bookmark) =>
            bookmark.name === branchMerge[1] && bookmark.remoteName !== null && bookmark.tracked,
        );
        return bookmark ? `refs/heads/${bookmark.name}` : null;
      }
      const result = yield* jj
        .readGitBackend({
          cwd,
          args: ["config", "--get", key],
          operation: "JjGitWorkflowAdapter.config",
          allowNonZeroExit: true,
        })
        .pipe(Effect.mapError(mapError(cwd)));
      return result.exitCode === 0 ? result.stdout.trim() : null;
    },
  );
  const range: GitVcsDriver.GitVcsDriver["Service"]["readRangeContext"] = Effect.fnUntraced(
    function* (cwd, baseRef) {
      const status = yield* jj.localStatus(cwd).pipe(Effect.mapError(mapError(cwd)));
      if (!status.refName)
        return yield* error(cwd, "Choose an unambiguous bookmark before creating a pull request.");
      const head = (yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)))).find(
        (bookmark) => bookmark.name === status.refName && bookmark.remoteName === null,
      )?.target;
      if (!head) return yield* error(cwd, "Bookmark target is unavailable.");
      return {
        commitSummary: yield* run(cwd, [
          "log",
          "-r",
          `${baseRef}..${head}`,
          "--no-graph",
          "-T",
          'description.first_line() ++ "\\n"',
        ]),
        diffSummary: yield* run(cwd, ["diff", "--stat", "--from", baseRef, "--to", head]),
        diffPatch: yield* run(cwd, ["diff", "--git", "--from", baseRef, "--to", head]),
      };
    },
  );
  const route =
    <A extends readonly unknown[], B>(
      cwd: (...args: NoInfer<A>) => string,
      native: (...args: NoInfer<A>) => Effect.Effect<NoInfer<B>, GitCommandError>,
      original: (...args: A) => Effect.Effect<B, GitCommandError>,
    ) =>
    (...args: A) =>
      isJj(cwd(...args)).pipe(Effect.flatMap((yes) => (yes ? native(...args) : original(...args))));
  const denyObject = <I extends { readonly cwd: string }, O>(
    original: (input: I) => Effect.Effect<O, GitCommandError>,
  ) =>
    route(
      (input: I) => input.cwd,
      (input) => Effect.fail(error(input.cwd, "This Git operation has no Jujutsu implementation.")),
      original,
    );
  return {
    status: denyObject(git.status),
    getReviewDiffPreview: denyObject(git.getReviewDiffPreview),
    getReviewDiffFileContents: denyObject(git.getReviewDiffFileContents),
    listRefs: route(
      (input) => input.cwd,
      (input) => jj.listRefs(input).pipe(Effect.mapError(mapError(input.cwd))),
      git.listRefs,
    ),
    createWorktree: denyObject(git.createWorktree),
    fetchPullRequestBranch: denyObject(git.fetchPullRequestBranch),
    fetchPullRequestHeadCommit: denyObject(git.fetchPullRequestHeadCommit),
    refreshCheckedOutBranch: denyObject(git.refreshCheckedOutBranch),
    ensureRemote: denyObject(git.ensureRemote),
    fetchRemote: denyObject(git.fetchRemote),
    remoteExists: denyObject(git.remoteExists),
    remoteBranchExists: denyObject(git.remoteBranchExists),
    fetchRemoteBranch: denyObject(git.fetchRemoteBranch),
    fetchRemoteTrackingBranch: denyObject(git.fetchRemoteTrackingBranch),
    setBranchUpstream: denyObject(git.setBranchUpstream),
    removeWorktree: denyObject(git.removeWorktree),
    pruneWorktrees: denyObject(git.pruneWorktrees),
    deleteLocalBranch: denyObject(git.deleteLocalBranch),
    renameBranch: denyObject(git.renameBranch),
    initRepo: denyObject(git.initRepo),
    execute: route(
      (input) => input.cwd,
      (input) =>
        jj
          .readGitBackend({
            cwd: input.cwd,
            operation: input.operation,
            args: input.args,
            ...(input.timeoutMs != null ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
            ...(input.allowNonZeroExit !== undefined
              ? { allowNonZeroExit: input.allowNonZeroExit }
              : {}),
          })
          .pipe(Effect.mapError(mapError(input.cwd))),
      git.execute,
    ),
    readConfigValue: route((...args) => args[0], readConfig, git.readConfigValue),
    statusDetails: route<[cwd: string], GitVcsDriver.GitStatusDetails>(
      (cwd) => cwd,
      details,
      git.statusDetails,
    ),
    statusDetailsLocal: route<
      [cwd: string, options?: GitVcsDriver.GitLocalStatusOptions],
      GitVcsDriver.GitStatusDetails
    >(
      (...args) => args[0],
      (...args) => details(args[0]),
      git.statusDetailsLocal,
    ),
    statusDetailsRemote: route(
      (...args) => args[0],
      (...args) => details(args[0]),
      git.statusDetailsRemote,
    ),
    prepareCommitContext: route((...args) => args[0], prepare, git.prepareCommitContext),
    commit: route((...args) => args[0], commit, git.commit),
    pushCurrentBranch: route((...args) => args[0], push, git.pushCurrentBranch),
    pullCurrentBranch: route((cwd) => cwd, pull, git.pullCurrentBranch),
    readRangeContext: route((...args) => args[0], range, git.readRangeContext),
    resolvePrimaryRemoteName: route((cwd) => cwd, primaryRemote, git.resolvePrimaryRemoteName),
    resolveDefaultBranchName: route<[cwd: string, remoteName: string], string | null>(
      (...args) => args[0],
      (...args) => defaultBranch(args[0]),
      git.resolveDefaultBranchName,
    ),
    resolveRemoteTrackingCommit: route(
      (input) => input.cwd,
      (input) => jj.resolveRemoteTrackingCommit(input).pipe(Effect.mapError(mapError(input.cwd))),
      git.resolveRemoteTrackingCommit,
    ),
    resolveCommit: route(
      (input) => input.cwd,
      (input) =>
        run(input.cwd, ["log", "-r", jjRef(input.revision), "--no-graph", "-T", "commit_id"]).pipe(
          Effect.map((commitSha) => ({ commitSha })),
        ),
      git.resolveCommit,
    ),
    createRef: route(
      (input) => input.cwd,
      (input) => jj.createRef(input).pipe(Effect.mapError(mapError(input.cwd))),
      git.createRef,
    ),
    switchRef: route(
      (input) => input.cwd,
      (input) => jj.switchRef(input).pipe(Effect.mapError(mapError(input.cwd))),
      git.switchRef,
    ),
    listLocalBranchNames: route(
      (cwd) => cwd,
      (cwd) =>
        jj.listBookmarks(cwd).pipe(
          Effect.map((bookmarks) =>
            bookmarks
              .filter((bookmark) => bookmark.remoteName === null)
              .map((bookmark) => bookmark.name),
          ),
          Effect.mapError(mapError(cwd)),
        ),
      git.listLocalBranchNames,
    ),
  } satisfies GitVcsDriver.GitVcsDriver["Service"];
}
