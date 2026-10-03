import { GitCommandError } from "@t3tools/contracts";
import { normalizeGitRemoteUrl, resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { detectPrTemplate } from "../sourceControl/PrTemplateDetection.ts";
import type { JjBookmark, JjVcsDriverShape } from "./JjVcsDriver.ts";
import type { VcsWorkflow } from "./VcsWorkflow.ts";
import { jjCommit, jjFile, jjRef, jjString } from "./jjExpressions.ts";

/** Native JJ operations, without Git configuration or a Git command facade. */
export function make(
  jj: Omit<JjVcsDriverShape, "workflow">,
  defaultWorkspacePath?: (cwd: string, refName: string) => string,
): VcsWorkflow {
  const error = (cwd: string, detail: string) =>
    new GitCommandError({ cwd, operation: "JjWorkflow", command: "jj", detail });
  const mapError = (cwd: string) => (cause: unknown) =>
    error(cwd, cause instanceof Error ? cause.message : String(cause));
  const run = (cwd: string, args: readonly string[]) =>
    jj
      .execute({
        cwd,
        args,
        operation: "JjWorkflow",
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
  const primaryRemote: VcsWorkflow["primaryRemote"] = Effect.fnUntraced(function* (cwd) {
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
  const remoteForRef = Effect.fnUntraced(function* (
    cwd: string,
    refName: string | null,
    bookmarks?: readonly JjBookmark[],
  ) {
    const tracked = (
      bookmarks ?? (yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd))))
    ).filter(
      (bookmark) => bookmark.name === refName && bookmark.remoteName !== null && bookmark.tracked,
    );
    if (tracked.length === 1 && tracked[0]?.remoteName) return tracked[0].remoteName;
    return (
      (yield* run(cwd, ["config", "get", "git.push"]).pipe(Effect.orElseSucceed(() => null))) ??
      (yield* primaryRemote(cwd))
    );
  });
  const defaultRef: VcsWorkflow["defaultRef"] = Effect.fnUntraced(function* (cwd) {
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
  const remoteUrl: VcsWorkflow["remoteUrl"] = (cwd, remoteName) =>
    jj.listRemotes(cwd).pipe(
      Effect.map(
        (result) => result.remotes.find((remote) => remote.name === remoteName)?.url ?? null,
      ),
      Effect.mapError(mapError(cwd)),
    );
  const refContext: VcsWorkflow["refContext"] = Effect.fnUntraced(function* (cwd, name) {
    const bookmarks = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
    const remoteName = yield* remoteForRef(cwd, name, bookmarks).pipe(
      Effect.orElseSucceed(() => null),
    );
    const upstream = bookmarks.find(
      (bookmark) => bookmark.name === name && bookmark.remoteName === remoteName,
    );
    return {
      exists: bookmarks.some((bookmark) => bookmark.name === name && bookmark.remoteName === null),
      publication: { name, remoteName, remoteRef: upstream?.target ? name : null },
    };
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
  const state: VcsWorkflow["state"] = Effect.fnUntraced(function* (cwd, options) {
    const local = yield* jj.localStatus(cwd).pipe(Effect.mapError(mapError(cwd)));
    if (options?.localOnly)
      return {
        local,
        publication: local.refName
          ? { name: local.refName, remoteName: null, remoteRef: null }
          : null,
        defaultRef: null,
        remote: { hasUpstream: false, aheadCount: 0, behindCount: 0, aheadOfDefaultCount: 0 },
      };
    const bookmarks = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
    const name = local.refName;
    const head = bookmarks.find(
      (bookmark) => bookmark.remoteName === null && bookmark.name === name,
    )?.target;
    const remoteName = yield* remoteForRef(cwd, name, bookmarks).pipe(
      Effect.orElseSucceed(() => null),
    );
    const upstream = bookmarks.find(
      (bookmark) => bookmark.name === name && bookmark.remoteName === remoteName,
    )?.target;
    const baseName = yield* defaultRef(cwd, remoteName ?? "");
    const base =
      bookmarks.find((bookmark) => bookmark.name === baseName && bookmark.remoteName === remoteName)
        ?.target ??
      bookmarks.find((bookmark) => bookmark.name === baseName && bookmark.remoteName === null)
        ?.target;
    const historyBase = upstream ?? base;
    return {
      local,
      publication: name ? { name, remoteName, remoteRef: upstream ? name : null } : null,
      defaultRef: baseName,
      remote: {
        hasUpstream: Boolean(upstream),
        aheadCount: head
          ? yield* count(
              cwd,
              `${historyBase ? jjCommit(historyBase) : "root()"}..${jjCommit(head)}`,
            )
          : 0,
        behindCount:
          head && upstream ? yield* count(cwd, `${jjCommit(head)}..${jjCommit(upstream)}`) : 0,
        aheadOfDefaultCount:
          head && base ? yield* count(cwd, `${jjCommit(base)}..${jjCommit(head)}`) : 0,
      },
    };
  });
  const selectedPaths = Effect.fnUntraced(function* (
    cwd: string,
    paths: readonly string[] | undefined,
  ) {
    if (!paths) return undefined;
    const fields = (yield* run(cwd, [
      "log",
      "--ignore-working-copy",
      "-r",
      "@",
      "--no-graph",
      "-T",
      'self.diff().files().map(|f| f.status() ++ "\\0" ++ f.source().path() ++ "\\0" ++ f.target().path() ++ "\\0").join("")',
    ])).split("\0");
    return [
      ...new Set([
        ...paths,
        ...fields.flatMap((status, index) => {
          const from = fields[index + 1],
            to = fields[index + 2];
          return index % 3 === 0 &&
            status === "renamed" &&
            from &&
            to &&
            (paths.includes(from) || paths.includes(to))
            ? [from, to]
            : [];
        }),
      ]),
    ];
  });
  const native = <A, E>(cwd: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(mapError(cwd)));
  return {
    kind: "jj",
    refs: {
      validateWorktreePath: (input) => native(input.cwd, jj.validateWorktreePath(input)),
      listRefs: (input) => native(input.cwd, jj.listRefs(input)),
      createWorktree: (input) => {
        const workspacePath =
          input.path ?? defaultWorkspacePath?.(input.cwd, input.newRefName ?? input.refName);
        return workspacePath
          ? native(input.cwd, jj.createWorktree({ ...input, path: workspacePath }))
          : Effect.fail(error(input.cwd, "Specify a path for the new workspace."));
      },
      listLocalBranchNames: (cwd) =>
        native(
          cwd,
          Effect.all([jj.listBookmarks(cwd), jj.listWorkspaces(cwd)]).pipe(
            Effect.map(([bookmarks, workspaces]) => [
              ...bookmarks
                .filter((bookmark) => bookmark.remoteName === null)
                .map((bookmark) => bookmark.name),
              ...workspaces.map((workspace) => `${workspace.name}@`),
            ]),
          ),
        ),
      fetchRemote: (input) => native(input.cwd, jj.fetchRemote(input)),
      remoteExists: (input) =>
        native(input.cwd, jj.listRemotes(input.cwd)).pipe(
          Effect.map((result) => result.remotes.some((remote) => remote.name === input.remoteName)),
        ),
      remoteBranchExists: (input) =>
        native(input.cwd, jj.listBookmarks(input.cwd)).pipe(
          Effect.map((bookmarks) =>
            bookmarks.some(
              (bookmark) =>
                bookmark.name === input.refName &&
                bookmark.remoteName === input.remoteName &&
                bookmark.target !== null,
            ),
          ),
        ),
      resolveRemoteTrackingCommit: (input) =>
        native(input.cwd, jj.resolveRemoteTrackingCommit(input)),
      removeWorktree: (input) => native(input.cwd, jj.removeWorktree(input)),
      recoverWorktree: (input) => native(input.cwd, jj.recoverWorktree(input)),
      deleteLocalBranch: (input) =>
        run(input.cwd, ["bookmark", "delete", "--", `exact:${input.refName}`]).pipe(Effect.asVoid),
      createRef: (input) => native(input.cwd, jj.createRef(input)),
      switchRef: (input) => native(input.cwd, jj.switchRef(input)),
      renameBranch: (input) => native(input.cwd, jj.renameBookmark(input)),
    },
    template: (cwd, revision) =>
      detectPrTemplate(cwd, revision, ({ timeoutMs, ...input }) =>
        native(
          input.cwd,
          jj.readGitBackend({ ...input, ...(typeof timeoutMs === "number" ? { timeoutMs } : {}) }),
        ),
      ).pipe(Effect.map(Option.getOrNull)),
    reviewWorkspace: Effect.fnUntraced(function* (input) {
      const { cwd, headRef, localRef, destination } = input;
      let remoteName = yield* primaryRemote(cwd);
      const url = input.remoteUrl;
      if (url) {
        const remotes = yield* native(cwd, jj.listRemotes(cwd));
        const existing = remotes.remotes.find(
          (remote) => normalizeGitRemoteUrl(remote.url) === normalizeGitRemoteUrl(url),
        );
        remoteName = existing?.name ?? input.newRemoteName;
        if (!existing) yield* run(cwd, ["git", "remote", "add", "--", remoteName, url]);
      }
      yield* run(cwd, ["git", "fetch", "--remote", remoteName, "--branch", `exact:${headRef}`]);
      const target = (yield* native(
        cwd,
        jj.resolveRemoteTrackingCommit({ cwd, refName: headRef, fallbackRemoteName: remoteName }),
      )).commitSha;
      const bookmark = (yield* native(cwd, jj.listBookmarks(cwd))).find(
        (bookmark) => bookmark.name === localRef && bookmark.remoteName === null,
      );
      // Forward-only moves preserve local review work instead of overwriting it.
      if (bookmark && bookmark.target !== target)
        yield* run(cwd, ["bookmark", "move", "--to", jjCommit(target), "--", `exact:${localRef}`]);
      if (!bookmark)
        yield* run(cwd, ["bookmark", "create", "-r", jjCommit(target), "--", localRef]);
      // A fork's namespaced review ref must not track/repoint our own main.
      if (localRef === headRef)
        yield* run(cwd, ["bookmark", "track", "--", `exact:${headRef}@${remoteName}`]);
      if (destination === null) {
        // Preserve the existing change, including its pending edits.
        yield* run(cwd, ["new", jjCommit(target), "-m", ""]);
        return { branch: localRef, worktreePath: null, isOnPullRequestHead: true };
      }
      if (input.reuse) {
        yield* native(cwd, jj.validateWorktreePath({ cwd, path: destination }));
        const status = yield* native(destination, jj.localStatus(destination));
        const parent = yield* run(destination, [
          "log",
          "--ignore-working-copy",
          "-r",
          "@-",
          "--no-graph",
          "-T",
          "commit_id",
        ]);
        return {
          branch: localRef,
          worktreePath: destination,
          isOnPullRequestHead: !status.hasWorkingTreeChanges && parent === target,
        };
      }
      const created = yield* native(
        cwd,
        jj.createWorktree({ cwd, refName: localRef, path: destination }),
      );
      return { branch: localRef, worktreePath: created.worktree.path, isOnPullRequestHead: true };
    }),
    state,
    refContext,
    publicationRemote: (cwd, name) => remoteForRef(cwd, name),
    probePublication: Effect.fnUntraced(function* (cwd, name, preferredRemote) {
      const bookmarks = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
      const remoteName = preferredRemote ?? (yield* remoteForRef(cwd, name, bookmarks));
      const published = bookmarks.some(
        (bookmark) =>
          bookmark.name === name && bookmark.remoteName === remoteName && bookmark.target !== null,
      );
      return { remoteName: published ? remoteName : null, published };
    }),
    prBaseRef: (cwd, name) =>
      native(
        cwd,
        jj.readGitBackend({
          cwd,
          operation: "JjWorkflow.prBaseRef",
          args: ["config", "--get", `branch.${name}.gh-merge-base`],
          allowNonZeroExit: true,
          outputMode: "error",
        }),
      ).pipe(Effect.map((result) => result.stdout.trim() || null)),
    remoteUrl,
    primaryRemote,
    defaultRef,
    remoteRevision: (cwd, refName, remoteName) =>
      jj.resolveRemoteTrackingCommit({ cwd, refName, fallbackRemoteName: remoteName }).pipe(
        Effect.map((result) => result.commitSha),
        Effect.mapError(mapError(cwd)),
      ),
    recentSubjects: (cwd) =>
      run(cwd, [
        "log",
        "--ignore-working-copy",
        "-r",
        "ancestors(@-) ~ merges()",
        "--limit",
        "20",
        "--no-graph",
        "-T",
        'description.first_line() ++ "\\n"',
      ]).pipe(Effect.map((text) => text.split("\n").filter(Boolean))),
    prepareCommit: Effect.fnUntraced(function* (cwd, selection) {
      yield* jj.currentChange(cwd).pipe(Effect.mapError(mapError(cwd)));
      const paths = (yield* selectedPaths(cwd, selection))?.map(jjFile) ?? [];
      if (
        !(yield* run(cwd, [
          "diff",
          "--ignore-working-copy",
          "--name-only",
          "-r",
          "@",
          "--",
          ...paths,
        ]))
      )
        return null;
      return {
        summary: yield* run(cwd, ["diff", "--stat", "-r", "@", "--", ...paths]),
        patch: yield* run(cwd, ["diff", "--git", "-r", "@", "--", ...paths]),
      };
    }),
    recordCommit: Effect.fnUntraced(function* (input) {
      const { cwd } = input;
      const status = yield* jj.localStatus(cwd).pipe(Effect.mapError(mapError(cwd)));
      const bookmark = input.publicationRef;
      const base = yield* defaultRef(cwd, "");
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
      if (
        !(input.confirmedDefaultRef && bookmark !== null && bookmark === base) &&
        (trunkOwnsChange ||
          (bookmark && (bookmark === base || (bookmark === status.refName && status.isDefaultRef))))
      )
        return yield* error(
          cwd,
          "Create a separate feature change before committing from trunk, or explicitly commit to the default bookmark.",
        );
      yield* run(cwd, [
        "commit",
        "-m",
        input.body ? `${input.subject}\n\n${input.body}` : input.subject,
        "--",
        ...((yield* selectedPaths(cwd, input.paths))?.map(jjFile) ?? []),
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
    }),
    publish: Effect.fnUntraced(function* (cwd, selectedRef, options) {
      const name =
        selectedRef ?? (yield* jj.localStatus(cwd).pipe(Effect.mapError(mapError(cwd)))).refName;
      const change = yield* jj.currentChange(cwd).pipe(Effect.mapError(mapError(cwd)));
      const bookmark = (yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)))).find(
        (bookmark) => bookmark.name === name && bookmark.remoteName === null,
      );
      if (!name || !bookmark?.target || bookmark.conflict)
        return yield* error(
          cwd,
          "Publishing requires one unambiguous local bookmark. Create or select a bookmark first.",
        );
      if (bookmark.target === change?.commitId && change.description === null)
        return yield* error(
          cwd,
          "Commit or describe the working-copy change before publishing it.",
        );
      const remoteName = options?.remoteName ?? (yield* remoteForRef(cwd, name));
      yield* run(cwd, ["git", "push", "--remote", remoteName, "--bookmark", `exact:${name}`]);
      return {
        status: "pushed" as const,
        branch: name,
        upstreamBranch: `${remoteName}/${name}`,
        setUpstream: true,
      };
    }),
    fetch: Effect.fnUntraced(function* (cwd) {
      const local = yield* jj.localStatus(cwd).pipe(Effect.mapError(mapError(cwd)));
      const remoteName = yield* remoteForRef(cwd, local.refName);
      const before = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
      yield* jj.fetchRemote({ cwd, remoteName }).pipe(Effect.mapError(mapError(cwd)));
      const after = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
      const changed =
        before.length !== after.length ||
        after.some(
          (bookmark) =>
            !before.some(
              (old) =>
                old.name === bookmark.name &&
                old.remoteName === bookmark.remoteName &&
                old.target === bookmark.target &&
                old.conflict === bookmark.conflict,
            ),
        );
      return {
        status: changed ? ("pulled" as const) : ("skipped_up_to_date" as const),
        refName: local.refName ?? "@",
        upstreamRef: local.refName ? `${local.refName}@${remoteName}` : null,
      };
    }),
    range: Effect.fnUntraced(function* (cwd, baseRevision) {
      const local = yield* jj.localStatus(cwd).pipe(Effect.mapError(mapError(cwd)));
      if (!local.refName)
        return yield* error(cwd, "Choose an unambiguous bookmark before creating a pull request.");
      const head = (yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)))).find(
        (bookmark) => bookmark.name === local.refName && bookmark.remoteName === null,
      )?.target;
      if (!head) return yield* error(cwd, "Bookmark target is unavailable.");
      const base = /^[a-f0-9]{40,64}$/.test(baseRevision)
        ? jjCommit(baseRevision)
        : jjRef(baseRevision);
      return {
        commitSummary: yield* run(cwd, [
          "log",
          "-r",
          `${base}..${jjCommit(head)}`,
          "--no-graph",
          "-T",
          'description.first_line() ++ "\\n"',
        ]),
        diffSummary: yield* run(cwd, ["diff", "--stat", "--from", base, "--to", jjCommit(head)]),
        diffPatch: yield* run(cwd, ["diff", "--git", "--from", base, "--to", jjCommit(head)]),
      };
    }),
    createFeatureRef: Effect.fnUntraced(function* (cwd, preferredName) {
      const bookmarks = yield* jj.listBookmarks(cwd).pipe(Effect.mapError(mapError(cwd)));
      const name = resolveAutoFeatureBranchName(
        bookmarks
          .filter((bookmark) => bookmark.remoteName === null)
          .map((bookmark) => bookmark.name),
        preferredName,
      );
      yield* jj.createRef({ cwd, refName: name }).pipe(Effect.mapError(mapError(cwd)));
      return name;
    }),
  };
}
