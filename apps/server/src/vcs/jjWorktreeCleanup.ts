import type { WorktreeKeepWhen } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { JjVcsDriverShape } from "./JjVcsDriver.ts";
import { jjCommit } from "./jjExpressions.ts";

const UNTRACKED_ENTRY_LIMIT = 20_000;

interface JjWorkspaceInspection {
  /** Commit the thread's bookmark names, or the working-copy change for a workspace ref. */
  readonly headSha: string | null;
  readonly branchChanged: boolean;
  readonly localChanges: string | null;
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
  const ignored = new Set<string>();
  const candidates: string[] = [];
  let entries = 0;

  // Classify the top level first so build output and dependency folders are
  // not walked file by file.
  const top = (yield* fileSystem.readDirectory(cwd)).filter(
    (name) => name !== ".jj" && name !== ".git" && name !== "node_modules",
  );
  const topCandidates = top.filter((name) => !tracked.has(name));
  const notIgnored = new Set(yield* jj.filterIgnoredPaths(cwd, topCandidates));
  const pending: string[] = [];
  for (const relative of topCandidates) {
    if (notIgnored.has(relative)) pending.push(relative);
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
    if ((yield* fileSystem.stat(absolute)).type !== "Directory") {
      candidates.push(relative);
      continue;
    }
    for (const name of yield* fileSystem.readDirectory(absolute)) {
      if (name === "node_modules" || name === ".jj" || name === ".git") continue;
      const child = `${relative}/${name}`;
      if (!tracked.has(child)) pending.push(child);
    }
  }

  const untracked = new Set(yield* jj.filterIgnoredPaths(cwd, candidates));
  for (const candidate of candidates) if (!untracked.has(candidate)) ignored.add(candidate);
  return { untracked: [...untracked], ignored: [...ignored], truncated: false };
});

const localChangesReason = Effect.fn("JjWorktreeCleanup.localChangesReason")(function* (
  jj: JjVcsDriverShape,
  cwd: string,
  keepWhen: WorktreeKeepWhen,
  hasWorkingTreeChanges: boolean,
  changedFiles: number,
) {
  if (hasWorkingTreeChanges)
    return `has uncommitted changes (${changedFiles} ${changedFiles === 1 ? "file" : "files"})`;
  if (keepWhen === "tracked-changes") return null;
  // Jujutsu tracks every file it can snapshot, so what remains on disk is an
  // ignored file or one too large to track.
  const scan = yield* untrackedPaths(jj, cwd);
  if (scan.truncated) return "local files exceed the inspection limit";
  if (scan.untracked.length > 0) return `has untracked files (${scan.untracked[0]})`;
  if (keepWhen === "uncommitted-changes") return null;
  const firstIgnored = scan.ignored.find((entry) => !entry.split("/").includes("node_modules"));
  return firstIgnored === undefined ? null : `has ignored files (${firstIgnored})`;
});

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
  const headSha = input.branch.endsWith("@")
    ? ((yield* jj.currentChange(input.cwd))?.commitId ?? null)
    : ((yield* jj.listBookmarks(input.cwd)).find(
        (bookmark) =>
          bookmark.remoteName === null &&
          bookmark.name === input.branch &&
          bookmark.target !== null &&
          !bookmark.conflict,
      )?.target ?? null);
  const unbookmarked = yield* commits(
    jj,
    input.cwd,
    "((::@ ~ ::bookmarks()) ~ ::remote_bookmarks()) ~ empty()",
  );
  return {
    headSha,
    branchChanged,
    localChanges: yield* localChangesReason(
      jj,
      input.cwd,
      input.keepWhen,
      status.hasWorkingTreeChanges,
      status.workingTree.files.length,
    ),
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
  const fetched = yield* jj.fetchRemote({ cwd: repositoryCwd, remoteName }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!fetched) return null;
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
