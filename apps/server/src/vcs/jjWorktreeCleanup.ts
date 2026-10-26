import type { WorktreeKeepWhen } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { JjVcsDriverShape } from "./JjVcsDriver.ts";
import { jjCommit } from "./jjExpressions.ts";

const UNTRACKED_ENTRY_LIMIT = 20_000;

interface WorkspaceScan {
  readonly untracked: ReadonlyArray<string>;
  readonly ignored: ReadonlyArray<string>;
  readonly truncated: boolean;
}

interface JjWorkspaceInspection {
  /** Commit the thread's bookmark names, or the working-copy change when it names none. */
  readonly headSha: string | null;
  readonly workingCopySha: string | null;
  readonly branchChanged: boolean;
  readonly localChanges: string | null;
  /** Files the keep policy allows deleting before removal. */
  readonly localFiles: {
    readonly untracked: ReadonlyArray<string>;
    readonly ignored: ReadonlyArray<string>;
  };
  /** Non-empty commits reachable from `@` that no local or remote bookmark keeps. */
  readonly unbookmarkedWork: boolean;
}

export interface JjTrunk {
  readonly branch: string;
  readonly remoteName: string;
  readonly commitSha: string;
}

const commits = (jj: JjVcsDriverShape, cwd: string, revset: string) =>
  jj
    .execute({
      operation: "JjWorktreeCleanup.log",
      cwd,
      args: [
        "log",
        "--ignore-working-copy",
        "-r",
        revset,
        "--no-graph",
        "-T",
        'commit_id ++ "\\n"',
      ],
      timeoutMs: 20_000,
      maxOutputBytes: 256 * 1024,
    })
    .pipe(Effect.map((result) => result.stdout.split(/\r?\n/).filter((line) => line !== "")));

const untrackedPaths = Effect.fn("JjWorktreeCleanup.untrackedPaths")(function* (
  jj: JjVcsDriverShape,
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listed = yield* jj.listWorkspaceFiles(cwd);
  if (listed.truncated)
    return {
      untracked: [] as ReadonlyArray<string>,
      ignored: [] as ReadonlyArray<string>,
      truncated: true,
    };
  const tracked = new Set(listed.paths);
  // A directory that still holds tracked files is not disposable local output.
  const trackedDirectories = new Set(
    listed.paths.flatMap((file) => {
      const parts = file.split("/");
      return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  );
  const ignored = new Set<string>();
  const candidates: string[] = [];
  let entries = 0;

  // Classify the top level first so build output and dependency folders are
  // not walked file by file.
  const top = (yield* fileSystem.readDirectory(cwd)).filter(
    (name) => name !== ".jj" && name !== ".git",
  );
  const topCandidates = top.filter((name) => !tracked.has(name));
  const notIgnored = new Set(yield* jj.filterIgnoredPaths(cwd, topCandidates));
  const pending: string[] = [];
  for (const relative of topCandidates) {
    if (notIgnored.has(relative) || trackedDirectories.has(relative)) pending.push(relative);
    else ignored.add(relative);
  }

  while (pending.length > 0) {
    const relative = pending.pop()!;
    entries++;
    if (entries > UNTRACKED_ENTRY_LIMIT)
      return {
        untracked: [] as ReadonlyArray<string>,
        ignored: [] as ReadonlyArray<string>,
        truncated: true,
      };
    const absolute = path.join(cwd, relative);
    const link = yield* fileSystem.readLink(absolute).pipe(Effect.option);
    if (Option.isSome(link)) {
      candidates.push(relative);
      continue;
    }
    if (
      (yield* fileSystem.stat(absolute)).type !== "Directory" ||
      (path.basename(relative) === "node_modules" && !trackedDirectories.has(relative))
    ) {
      candidates.push(relative);
      continue;
    }
    for (const name of yield* fileSystem.readDirectory(absolute)) {
      if (name === ".jj" || name === ".git") continue;
      const child = `${relative}/${name}`;
      if (!tracked.has(child)) pending.push(child);
    }
  }

  const untracked = new Set(yield* jj.filterIgnoredPaths(cwd, candidates));
  for (const candidate of candidates) if (!untracked.has(candidate)) ignored.add(candidate);
  return { untracked: [...untracked], ignored: [...ignored], truncated: false };
});

const localChangesReason = (
  keepWhen: WorktreeKeepWhen,
  hasWorkingTreeChanges: boolean,
  changedFiles: number,
  scan: WorkspaceScan | null,
) => {
  if (hasWorkingTreeChanges)
    return `has uncommitted changes (${changedFiles} ${changedFiles === 1 ? "file" : "files"})`;
  if (scan === null) return null;
  if (scan.truncated) return "local files exceed the inspection limit";
  if (keepWhen === "tracked-changes") return null;
  if (scan.untracked.length > 0) return `has untracked files (${scan.untracked[0]})`;
  if (keepWhen === "uncommitted-changes") return null;
  const firstIgnored = scan.ignored.find((entry) => !entry.split("/").includes("node_modules"));
  return firstIgnored === undefined ? null : `has ignored files (${firstIgnored})`;
};

const branchName = (branch: string) => branch.slice(0, -1);

export const inspectJjWorkspace = Effect.fn("JjWorktreeCleanup.inspect")(function* (
  jj: JjVcsDriverShape,
  input: {
    readonly cwd: string;
    readonly repositoryCwd: string;
    readonly branch: string;
    readonly keepWhen: WorktreeKeepWhen;
  },
) {
  const path = yield* Path.Path;
  const status = yield* jj.localStatus(input.cwd);
  const workspaces = input.branch.endsWith("@")
    ? yield* jj.listWorkspaces(input.repositoryCwd)
    : [];
  const branchChanged = input.branch.endsWith("@")
    ? !workspaces.some(
        (workspace) =>
          workspace.name === branchName(input.branch) &&
          path.resolve(workspace.path) === path.resolve(input.cwd),
      )
    : !(status.jj?.bookmarks ?? []).includes(input.branch);
  const change = yield* jj.currentChange(input.cwd);
  const headSha = input.branch.endsWith("@")
    ? (change?.commitId ?? null)
    : ((yield* jj.listBookmarks(input.cwd)).find(
        (bookmark) =>
          bookmark.remoteName === null &&
          bookmark.name === input.branch &&
          bookmark.target !== null &&
          !bookmark.conflict,
      )?.target ?? null);
  // Jujutsu tracks every file it can snapshot, so what remains on disk is an
  // ignored file or one too large to track.
  const scan = status.hasWorkingTreeChanges ? null : yield* untrackedPaths(jj, input.cwd);
  const unbookmarked = yield* commits(
    jj,
    input.cwd,
    "((::@ ~ ::bookmarks()) ~ ::remote_bookmarks()) ~ empty()",
  );
  return {
    headSha,
    workingCopySha: change?.commitId ?? null,
    branchChanged,
    localChanges: localChangesReason(
      input.keepWhen,
      status.hasWorkingTreeChanges,
      status.workingTree.files.length,
      scan,
    ),
    localFiles:
      scan === null || scan.truncated
        ? { untracked: [], ignored: [] }
        : { untracked: scan.untracked, ignored: scan.ignored },
    unbookmarkedWork: unbookmarked.length > 0,
  } satisfies JjWorkspaceInspection;
});

export const resolveJjTrunk = Effect.fn("JjWorktreeCleanup.resolveTrunk")(function* (
  jj: JjVcsDriverShape,
  repositoryCwd: string,
) {
  const remoteName = yield* jj.workflow
    .primaryRemote(repositoryCwd)
    .pipe(Effect.orElseSucceed(() => null));
  if (remoteName === null) return null;
  const branch = yield* jj.workflow
    .defaultRef(repositoryCwd, remoteName)
    .pipe(Effect.orElseSucceed(() => null));
  if (branch === null) return null;
  // The merged and unchanged rules compare against the remote's current
  // default, not a stale tracking bookmark.
  yield* jj.fetchRemote({ cwd: repositoryCwd, remoteName });
  const commitSha = yield* jj
    .resolveRemoteTrackingCommit({
      cwd: repositoryCwd,
      refName: branch,
      fallbackRemoteName: remoteName,
    })
    .pipe(
      Effect.map((resolved) => resolved.commitSha),
      Effect.orElseSucceed(() => null),
    );
  return commitSha === null ? null : ({ branch, remoteName, commitSha } satisfies JjTrunk);
});

/** Whether `headSha` is already history of the remote default branch. */
export const jjHeadIntegrated = (
  jj: JjVcsDriverShape,
  cwd: string,
  headSha: string,
  trunkSha: string,
) =>
  commits(jj, cwd, `${jjCommit(headSha)} & ::(${jjCommit(trunkSha)})`).pipe(
    Effect.map((found) => found.length > 0),
  );

/** Whether nothing reachable from the working copy still has content outside trunk. */
export const jjHeadUnchanged = (jj: JjVcsDriverShape, cwd: string, trunkSha: string) =>
  commits(jj, cwd, `(::@ ~ ::(${jjCommit(trunkSha)})) ~ empty()`).pipe(
    Effect.map((found) => found.length === 0),
  );
