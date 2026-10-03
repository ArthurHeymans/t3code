import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  VcsProcessExitError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsError,
  type VcsRemoveWorktreeInput,
  type VcsStatusLocalResult,
  type VcsWorkspace,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
} from "@t3tools/contracts";

import * as VcsDriver from "./VcsDriver.ts";
import * as JjWorkflow from "./JjWorkflow.ts";
import type { VcsWorkflow } from "./VcsWorkflow.ts";
import * as ServerConfig from "../config.ts";
import { nowFreshness } from "./VcsFreshness.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "./GitVcsDriverCore.ts";
import { jjCommit, jjFile, jjRef, jjString } from "./jjExpressions.ts";

export interface JjVcsDriverShape extends VcsDriver.VcsDriverShape {
  readonly workflow: VcsWorkflow;
  readonly capabilities: VcsDriver.VcsDriverShape["capabilities"] & {
    readonly kind: "jj";
    readonly supportsBookmarks: true;
    readonly supportsAtomicSnapshot: true;
    readonly supportsWorktrees: true;
    readonly supportsWorkspaceSelection: true;
    readonly ignoreClassifier: "git-compatible-fallback";
  };
  readonly currentChange: (cwd: string) => Effect.Effect<JjCurrentChange | null, VcsError>;
  readonly listBookmarks: (cwd: string) => Effect.Effect<ReadonlyArray<JjBookmark>, VcsError>;
  readonly listWorkspaces: (cwd: string) => Effect.Effect<ReadonlyArray<VcsWorkspace>, VcsError>;
  readonly createWorktree: (
    input: VcsCreateWorktreeInput,
  ) => Effect.Effect<VcsCreateWorktreeResult, VcsError>;
  readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, VcsError>;
  readonly renameBookmark: (input: {
    readonly cwd: string;
    readonly oldBranch: string;
    readonly newBranch: string;
  }) => Effect.Effect<{ readonly branch: string }, VcsError>;
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, VcsError>;
  readonly createRef: (input: VcsCreateRefInput) => Effect.Effect<VcsCreateRefResult, VcsError>;
  readonly switchRef: (input: VcsSwitchRefInput) => Effect.Effect<VcsSwitchRefResult, VcsError>;
  readonly pruneWorktrees: (cwd: string) => Effect.Effect<void, VcsError>;
  readonly recoverWorktree: (input: {
    readonly cwd: string;
    readonly path: string;
    readonly refName: string;
  }) => Effect.Effect<void, VcsError>;
  /** Read Git-backend objects/configuration, never mutate user refs or the index. */
  readonly readGitBackend: VcsDriver.VcsDriverShape["execute"];
  readonly fetchRemote: (input: {
    readonly cwd: string;
    readonly remoteName: string;
  }) => Effect.Effect<void, VcsError>;
  readonly resolveRemoteTrackingCommit: (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly fallbackRemoteName: string;
  }) => Effect.Effect<{ readonly commitSha: string; readonly remoteRefName: string }, VcsError>;
  readonly localStatus: (cwd: string) => Effect.Effect<VcsStatusLocalResult, VcsError>;
  readonly hasUntrackedFiles: (cwd: string) => Effect.Effect<boolean, VcsError>;
  readonly validateWorktreePath: (
    input: Pick<VcsRemoveWorktreeInput, "cwd" | "path">,
  ) => Effect.Effect<void, VcsError>;
}

export interface JjCurrentChange {
  readonly changeId: string;
  readonly commitId: string | null;
  readonly description: string | null;
}

export interface JjBookmark {
  readonly name: string;
  readonly target: string | null;
  readonly remoteName: string | null;
  readonly conflict: boolean;
  readonly tracked?: boolean;
}

export class JjVcsDriver extends Context.Service<JjVcsDriver, JjVcsDriverShape>()(
  "t3/vcs/JjVcsDriver",
) {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;
const CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

type VcsProcessShape = VcsProcess.VcsProcess["Service"];

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (truncated && parts[parts.length - 1]?.length) parts.pop();
  return parts.filter((value) => value.length > 0);
}

function splitLineSeparatedPaths(input: string, truncated: boolean): string[] {
  const lines = input.split(/\r?\n/g);
  if (truncated && lines[lines.length - 1]?.length) lines.pop();
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function parseJjRemoteList(output: string): Array<{ name: string; url: string }> {
  return output
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .flatMap((line) => {
      if (line.length === 0) return [];
      const separator = line.search(/\s/);
      const name = line.slice(0, separator);
      const url = separator < 0 ? "" : line.slice(separator).trim();
      return name && url ? [{ name, url }] : [];
    });
}

function parseNullRecord(record: string): string[] {
  return record.split("\0").map((value) => value.trim());
}

function decodeJjCurrentChange(raw: string, cwd: string): JjCurrentChange | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const [changeId, commitId, description] = parseNullRecord(trimmed);
  if (!changeId) {
    throw new VcsRepositoryDetectionError({
      operation: "JjVcsDriver.currentChange",
      cwd,
      detail: "jj current change output did not include a change id",
    });
  }

  return {
    changeId,
    commitId: commitId || null,
    description: description || null,
  };
}

function decodeJjBookmarkList(raw: string): ReadonlyArray<JjBookmark> {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, remoteName, target, tracked] = parseNullRecord(line);
      return {
        name: name ?? line,
        remoteName: remoteName || null,
        target: target && target !== "conflict" ? target : null,
        conflict: target === "conflict",
        tracked: tracked === "true",
      };
    });
}

function decodeJjWorkspaceList(raw: string) {
  const fields = raw.split("\0");
  return fields.flatMap((name, index) =>
    index % 2 === 0 && name.length > 0 ? [{ name, path: fields[index + 1] || null }] : [],
  );
}

function chunkPathsForCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(relativePath);
    chunkBytes += relativePathBytes;
    if (chunkBytes >= CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

const processCommand = (
  process: VcsProcessShape,
  command: string,
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly appendTruncationMarker?: boolean;
    readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
  },
) =>
  process.run({
    operation,
    command,
    args,
    cwd,
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
    ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
  });

const jjCommand = (
  process: VcsProcessShape,
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: Parameters<typeof processCommand>[5],
) => processCommand(process, "jj", operation, cwd, ["--no-pager", ...args], options);

const gitCommand = (
  process: VcsProcessShape,
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: Parameters<typeof processCommand>[5],
) => processCommand(process, "git", operation, cwd, args, options);

const makeScopedTempGitDir = (fileSystem: FileSystem.FileSystem, operation: string, cwd: string) =>
  fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-check-ignore-" }).pipe(
    Effect.mapError(
      (cause) =>
        new VcsRepositoryDetectionError({
          operation,
          cwd,
          detail: "failed to create temporary Git directory for ignore classification",
          cause,
        }),
    ),
  );

export const makeVcsDriverShape = Effect.fn("makeJjVcsDriverShape")(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const capabilities = {
    kind: "jj" as const,
    supportsWorktrees: true as const,
    supportsWorkspaceSelection: true as const,
    supportsBookmarks: true as const,
    supportsAtomicSnapshot: true as const,
    supportsPushDefaultRemote: true as const,
    ignoreClassifier: "git-compatible-fallback" as const,
  };

  const hasJjMetadata = (cwd: string) =>
    Effect.gen(function* () {
      let directory = path.resolve(cwd);
      while (true) {
        if (yield* fileSystem.exists(path.join(directory, ".jj", "repo"))) return true;
        const parent = path.dirname(directory);
        if (parent === directory) return false;
        directory = parent;
      }
    }).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            cwd,
            operation: "JjVcsDriver.detectRepository",
            detail: "Could not inspect Jujutsu metadata.",
            cause,
          }),
      ),
    );

  const isInsideWorkTree: VcsDriver.VcsDriverShape["isInsideWorkTree"] = (cwd) =>
    detectRepository(cwd).pipe(Effect.map((repository) => repository !== null));

  const execute: VcsDriver.VcsDriverShape["execute"] = (input) =>
    jjCommand(process, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
    });

  const initRepository: VcsDriver.VcsDriverShape["initRepository"] = (input) =>
    jjCommand(process, "JjVcsDriver.initRepository", input.cwd, ["git", "init", "--colocate"]).pipe(
      Effect.asVoid,
    );

  const detectRepository: VcsDriver.VcsDriverShape["detectRepository"] = Effect.fn(
    "JjVcsDriver.detectRepository",
  )(function* (cwd) {
    const root = yield* jjCommand(process, "JjVcsDriver.detectRepository.root", cwd, ["root"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          // A missing/broken JJ executable must never silently route a colocated
          // workspace through Git's mutating workflows.
          if (yield* hasJjMetadata(cwd)) return yield* error;
          return null;
        }),
      ),
    );
    if (!root) return null;
    if (root.exitCode !== 0 || root.stdout.trim().length === 0) {
      if (yield* hasJjMetadata(cwd))
        return yield* new VcsRepositoryDetectionError({
          cwd,
          operation: "JjVcsDriver.detectRepository",
          detail:
            "Jujutsu metadata is present, but JJ could not open this workspace. Repair it before using source control.",
        });
      return null;
    }

    const rootPath = root.stdout.trim();

    return {
      kind: "jj" as const,
      rootPath,
      metadataPath: `${rootPath.replace(/[\\/]$/g, "")}/.jj`,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles = (cwd: string, snapshot = true) =>
    jjCommand(
      process,
      "JjVcsDriver.listWorkspaceFiles",
      cwd,
      ["file", "list", ...(snapshot ? [] : ["--ignore-working-copy"]), "-T", 'path ++ "\\0"'],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              return {
                paths: result.stdout.includes("\0")
                  ? result.stdout.split("\0").filter((entry) => entry.length > 0)
                  : splitLineSeparatedPaths(result.stdout, result.stdoutTruncated),
                truncated: result.stdoutTruncated,
                freshness: yield* nowFreshness(),
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "JjVcsDriver.listWorkspaceFiles",
                command: "jj file list",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "jj file list failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriver.VcsDriverShape["listRemotes"] = Effect.fn("JjVcsDriver.listRemotes")(
    function* (cwd) {
      const result = yield* jjCommand(
        process,
        "JjVcsDriver.listRemotes",
        cwd,
        ["git", "remote", "list", "--ignore-working-copy"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        },
      );

      if (result.exitCode !== 0) {
        return { remotes: [], freshness: yield* nowFreshness() };
      }

      return {
        remotes: parseJjRemoteList(result.stdout).map((remote) => ({
          name: remote.name,
          url: remote.url,
          pushUrl: Option.none(),
          isPrimary: remote.name === "origin",
        })),
        freshness: yield* nowFreshness(),
      };
    },
  );

  const currentChange: JjVcsDriverShape["currentChange"] = (cwd) =>
    jjCommand(
      process,
      "JjVcsDriver.currentChange",
      cwd,
      [
        "log",
        "-r",
        "@",
        "--no-graph",
        "--template",
        'change_id ++ "\\0" ++ commit_id ++ "\\0" ++ description.first_line()',
      ],
      {
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      },
    ).pipe(Effect.map((result) => decodeJjCurrentChange(result.stdout, cwd)));

  const listBookmarks: JjVcsDriverShape["listBookmarks"] = (cwd) =>
    jjCommand(
      process,
      "JjVcsDriver.listBookmarks",
      cwd,
      [
        "bookmark",
        "list",
        "--ignore-working-copy",
        "--all-remotes",
        "--template",
        'name ++ "\\0" ++ remote ++ "\\0" ++ if(conflict, "conflict", if(present, normal_target.commit_id(), "")) ++ "\\0" ++ tracked ++ "\\n"',
      ],
      {
        timeoutMs: 5_000,
        maxOutputBytes: 256 * 1024,
        outputMode: "error",
      },
    ).pipe(
      Effect.map((result) =>
        decodeJjBookmarkList(result.stdout).filter((bookmark) => bookmark.remoteName !== "git"),
      ),
    );

  const listWorkspaceRecords = (cwd: string) =>
    jjCommand(
      process,
      "JjVcsDriver.listWorkspaces",
      cwd,
      [
        "workspace",
        "list",
        "--ignore-working-copy",
        "--template",
        'name ++ "\\0" ++ root ++ "\\0"',
      ],
      {
        timeoutMs: 5_000,
        maxOutputBytes: 256 * 1024,
        outputMode: "error",
      },
    ).pipe(Effect.map((result) => decodeJjWorkspaceList(result.stdout)));
  const listWorkspaces: JjVcsDriverShape["listWorkspaces"] = (cwd) =>
    listWorkspaceRecords(cwd).pipe(
      Effect.map((records) =>
        records.flatMap((record) =>
          record.path === null ? [] : [{ ...record, path: record.path, current: false }],
        ),
      ),
    );

  // jj intentionally hides root paths once a workspace disappears. Deriving
  // our identity from its path lets recovery select that exact snapshot,
  // rather than confusing it with another thread's bookmarked change.
  const workspaceIdentity = (cwd: string, workspacePath: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(path.resolve(cwd, workspacePath))).pipe(
      Effect.map((hash) => `t3-${Encoding.encodeHex(hash).slice(0, 24)}`),
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "JjVcsDriver.workspaceIdentity",
            cwd,
            detail: "Could not identify the workspace path.",
            cause,
          }),
      ),
    );

  const resolveCommit = (operation: string, cwd: string, revision: string) =>
    jjCommand(
      process,
      operation,
      cwd,
      [
        "log",
        ...(revision === "@" ? [] : ["--ignore-working-copy"]),
        "-r",
        revision,
        "--no-graph",
        "--template",
        "commit_id",
      ],
      { allowNonZeroExit: true, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) return null;
        const commitId = result.stdout.trim();
        return /^[a-f0-9]{40,64}$/.test(commitId) ? commitId : null;
      }),
    );

  const resolveGitBackendDir = Effect.fn("JjVcsDriver.resolveGitBackendDir")(function* (
    cwd: string,
  ) {
    const operation = "JjVcsDriver.resolveGitBackendDir";
    const rootResult = yield* jjCommand(process, operation, cwd, ["root"], {
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    const workspaceRoot = rootResult.stdout.trim();
    const repoMarker = path.join(workspaceRoot, ".jj", "repo");
    const repoMarkerInfo = yield* fileSystem.stat(repoMarker).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation,
            cwd,
            detail: `failed to inspect Jujutsu repository marker at ${repoMarker}`,
            cause,
          }),
      ),
    );
    const repoDir =
      repoMarkerInfo.type === "Directory"
        ? repoMarker
        : path.resolve(
            path.dirname(repoMarker),
            (yield* fileSystem.readFileString(repoMarker).pipe(
              Effect.mapError(
                (cause) =>
                  new VcsRepositoryDetectionError({
                    operation,
                    cwd,
                    detail: `failed to read Jujutsu repository pointer at ${repoMarker}`,
                    cause,
                  }),
              ),
            )).trim(),
          );
    const gitTargetPath = path.join(repoDir, "store", "git_target");
    const gitTarget = yield* fileSystem.readFileString(gitTargetPath).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation,
            cwd,
            detail: `failed to read Jujutsu Git backend pointer at ${gitTargetPath}`,
            cause,
          }),
      ),
    );
    return path.resolve(path.dirname(gitTargetPath), gitTarget.trim());
  });

  const checkpointGitCommand = Effect.fn("JjVcsDriver.checkpointGitCommand")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: Parameters<typeof processCommand>[5],
  ) {
    const gitDir = yield* resolveGitBackendDir(cwd);
    return yield* gitCommand(process, operation, cwd, ["--git-dir", gitDir, ...args], options);
  });

  const associatedBookmarks = (cwd: string, bookmarks: ReadonlyArray<JjBookmark>) =>
    jjCommand(process, "JjVcsDriver.associatedBookmarks", cwd, [
      "log",
      "--ignore-working-copy",
      "-r",
      "heads(::@ & bookmarks())",
      "--no-graph",
      "-T",
      'commit_id ++ "\\n"',
    ]).pipe(
      Effect.map((result) => {
        const nearest = result.stdout.trim().split("\n");
        return bookmarks.filter(
          (bookmark) =>
            bookmark.remoteName === null &&
            bookmark.target !== null &&
            nearest.includes(bookmark.target),
        );
      }),
    );

  const localStatus: JjVcsDriverShape["localStatus"] = Effect.fn("JjVcsDriver.localStatus")(
    function* (cwd) {
      const operation = "JjVcsDriver.localStatus";
      const change = yield* currentChange(cwd);
      // Snapshot once, then read that view. Native diff stats merge multiple
      // parents correctly and emit root-relative literal paths, including binaries.
      const [stats, bookmarks, remotes, trunkCommit] = yield* Effect.all([
        jjCommand(
          process,
          operation,
          cwd,
          [
            "log",
            "--ignore-working-copy",
            "-r",
            "@",
            "--no-graph",
            "-T",
            'self.diff().stat().files().map(|f| f.lines_added() ++ "\\t" ++ f.lines_removed() ++ "\\t" ++ f.path() ++ "\\0").join("")',
          ],
          { maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES, outputMode: "error" },
        ),
        listBookmarks(cwd),
        listRemotes(cwd),
        resolveCommit(operation, cwd, "trunk()"),
      ]);
      const files = parseTurnDiffFilesFromNumstat(stats.stdout).map((file) => ({
        path: file.path,
        insertions: file.additions,
        deletions: file.deletions,
      }));
      // A workspace is a working-copy change, not a bookmark. Associate only
      // one unambiguous local bookmark at its nearest bookmarked ancestor.
      const candidates = yield* associatedBookmarks(cwd, bookmarks);
      const currentBookmark = candidates.length === 1 ? candidates[0] : undefined;

      return {
        kind: "jj",
        isRepo: true,
        supportsWorkflowActions: true,
        hasPrimaryRemote:
          remotes.remotes.some((remote) => remote.isPrimary) || remotes.remotes.length === 1,
        isDefaultRef:
          currentBookmark !== undefined &&
          (currentBookmark.name === "main" ||
            currentBookmark.name === "master" ||
            currentBookmark.target === trunkCommit),
        refName: currentBookmark?.name ?? null,
        jj: {
          changeId: change?.changeId ?? "unknown",
          bookmarks: candidates.map((bookmark) => bookmark.name),
        },
        hasWorkingTreeChanges: files.length > 0,
        workingTree: {
          files,
          insertions: files.reduce((total, file) => total + file.insertions, 0),
          deletions: files.reduce((total, file) => total + file.deletions, 0),
        },
      };
    },
  );

  const REVIEW_BASE_REF_CANDIDATES = ["main@origin", "master@origin", "main", "master"] as const;

  const resolveReviewBaseRef = Effect.fn("JjVcsDriver.resolveReviewBaseRef")(function* (
    cwd: string,
    requestedBaseRef: string | undefined,
  ) {
    if (requestedBaseRef !== undefined && requestedBaseRef.length > 0) return requestedBaseRef;
    // trunk() is the idiomatic Jujutsu base, but it falls back to the root
    // commit when no trunk is configured. An all-zero commit means "no base".
    const trunkCommit = yield* resolveCommit("JjVcsDriver.resolveReviewBaseRef", cwd, "trunk()");
    if (trunkCommit !== null && !/^0+$/.test(trunkCommit)) return "trunk()";
    for (const candidate of REVIEW_BASE_REF_CANDIDATES) {
      const commit = yield* resolveCommit("JjVcsDriver.resolveReviewBaseRef", cwd, candidate);
      if (commit !== null && !/^0+$/.test(commit)) return candidate;
    }
    return null;
  });

  const getDiffPreview: VcsDriver.VcsDriverShape["getDiffPreview"] = Effect.fn(
    "JjVcsDriver.getDiffPreview",
  )(function* (input: ReviewDiffPreviewInput) {
    const repository = yield* detectRepository(input.cwd);
    if (!repository) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      } satisfies ReviewDiffPreviewResult;
    }

    yield* currentChange(input.cwd);
    const headRef = "@";
    const baseRef = yield* resolveReviewBaseRef(input.cwd, input.baseRef);

    // In Jujutsu the working copy is a commit, so `jj diff -r @` (against its
    // parent) is both the dirty worktree and the current change. Untracked
    // files are already included, unlike Git which needs a separate pass.
    const diffArgs = (revisions: ReadonlyArray<string>) => [
      "diff",
      "--git",
      ...(input.ignoreWhitespace === true ? ["--ignore-all-space"] : []),
      ...revisions,
    ];
    const readDiff = (operation: string, revisions: ReadonlyArray<string>) =>
      jjCommand(process, operation, input.cwd, diffArgs(revisions), {
        timeoutMs: 20_000,
        maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      }).pipe(
        Effect.map((result) => ({ diff: result.stdout, truncated: result.stdoutTruncated })),
        Effect.orElseSucceed(() => ({ diff: "", truncated: false })),
      );
    const dirty = yield* readDiff("JjVcsDriver.getDiffPreview.dirty", ["-r", "@"]);
    const base =
      baseRef === null
        ? { diff: "", truncated: false }
        : yield* readDiff("JjVcsDriver.getDiffPreview.base", ["--from", baseRef, "--to", "@"]);

    const hashDiff = (diff: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(diff)).pipe(
        Effect.map(Encoding.encodeHex),
        Effect.mapError(
          () =>
            new VcsProcessExitError({
              operation: "JjVcsDriver.getDiffPreview.hash",
              command: "crypto.digest SHA-256",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Failed to hash review diff.",
            }),
        ),
      );
    const [dirtyDiffHash, baseDiffHash] = yield* Effect.all([
      hashDiff(dirty.diff),
      hashDiff(base.diff),
    ]);

    const sources: ReviewDiffPreviewSource[] = [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Dirty worktree",
        baseRef: "@-",
        headRef: "@",
        diff: dirty.diff,
        diffHash: dirtyDiffHash,
        truncated: dirty.truncated,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: baseRef ? `Against ${baseRef}` : "Against base branch",
        baseRef,
        headRef,
        diff: base.diff,
        diffHash: baseDiffHash,
        truncated: base.truncated,
      },
    ];

    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources,
    } satisfies ReviewDiffPreviewResult;
  });

  const reviewDiffFileError = (input: ReviewDiffFileContentsInput, detail: string) =>
    new VcsProcessExitError({
      operation: "JjVcsDriver.getReviewDiffFileContents",
      command: "jj file show",
      cwd: input.cwd,
      exitCode: 1,
      detail,
    });

  const isPathWithinRoot = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const readJjFileAtRevision = Effect.fn("readJjFileAtRevision")(function* (
    input: ReviewDiffFileContentsInput,
    repositoryRoot: string,
    revision: string,
    relativePath: string,
  ) {
    const result = yield* jjCommand(
      process,
      "JjVcsDriver.getReviewDiffFileContents.revision",
      repositoryRoot,
      ["file", "show", "-r", revision, "--", jjFile(relativePath)],
      { timeoutMs: 20_000, maxOutputBytes: REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES },
    );
    if (result.exitCode !== 0) {
      return yield* reviewDiffFileError(
        input,
        `Could not read diff file '${relativePath}' at revision '${revision}'.`,
      );
    }
    if (result.stdout.includes("\0")) {
      return yield* reviewDiffFileError(input, `Cannot expand binary file '${relativePath}'.`);
    }
    return result.stdout;
  });

  const readWorkingTreeReviewFile = Effect.fn("readWorkingTreeReviewFile")(function* (
    input: ReviewDiffFileContentsInput,
    repositoryRoot: string,
  ) {
    const fileError = (stage: string, detail: string, cause?: unknown) =>
      new VcsProcessExitError({
        operation: `JjVcsDriver.getReviewDiffFileContents.workingTree.${stage}`,
        command: stage,
        cwd: input.cwd,
        exitCode: 1,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const requestedPath = path.resolve(repositoryRoot, input.newPath);
    if (!isPathWithinRoot(repositoryRoot, requestedPath)) {
      return yield* fileError(
        "path.resolve",
        `Diff file '${input.newPath}' resolves outside the review workspace.`,
      );
    }

    const [realRepositoryRoot, realTarget] = yield* Effect.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(requestedPath),
    ]).pipe(
      Effect.mapError((cause) =>
        fileError("fs.realPath", `Could not resolve diff file '${input.newPath}'.`, cause),
      ),
    );
    if (!isPathWithinRoot(realRepositoryRoot, realTarget)) {
      return yield* fileError(
        "fs.realPath",
        `Diff file '${input.newPath}' resolves outside the review workspace.`,
      );
    }

    const info = yield* fileSystem
      .stat(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError("fs.stat", `Could not inspect diff file '${input.newPath}'.`, cause),
        ),
      );
    if (info.type !== "File") {
      return yield* fileError("fs.stat", `Diff path '${input.newPath}' is not a file.`);
    }
    if (info.size > BigInt(REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES)) {
      return yield* fileError(
        "fs.stat",
        `Diff file '${input.newPath}' exceeds the 1 MB expansion limit.`,
      );
    }

    const bytes = yield* fileSystem
      .readFile(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError("fs.readFile", `Could not read diff file '${input.newPath}'.`, cause),
        ),
      );
    if (bytes.includes(0)) {
      return yield* fileError("fs.readFile", `Cannot expand binary file '${input.newPath}'.`);
    }
    return new TextDecoder("utf-8").decode(bytes);
  });

  const getDiffFileContents: VcsDriver.VcsDriverShape["getDiffFileContents"] = Effect.fn(
    "JjVcsDriver.getReviewDiffFileContents",
  )(function* (input: ReviewDiffFileContentsInput) {
    const repository = yield* detectRepository(input.cwd);
    if (!repository) {
      return yield* reviewDiffFileError(input, "Could not resolve the Jujutsu repository root.");
    }
    const repositoryRoot = repository.rootPath;

    if (input.sourceKind === "working-tree") {
      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new"
            ? Effect.succeed("")
            : readJjFileAtRevision(input, repositoryRoot, input.baseRef ?? "@-", input.oldPath),
          input.changeType === "deleted"
            ? Effect.succeed("")
            : readWorkingTreeReviewFile(input, repositoryRoot),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents } satisfies ReviewDiffFileContentsResult;
    }

    if (!input.baseRef || !input.headRef) {
      return yield* reviewDiffFileError(
        input,
        "Branch diff file expansion requires both base and head refs.",
      );
    }
    // `jj diff --from <base> --to @` compares trees directly (no merge-base),
    // so the file sides are exactly the base and head revisions.
    const [oldContents, newContents] = yield* Effect.all(
      [
        input.changeType === "new"
          ? Effect.succeed("")
          : readJjFileAtRevision(input, repositoryRoot, input.baseRef, input.oldPath),
        input.changeType === "deleted"
          ? Effect.succeed("")
          : readJjFileAtRevision(input, repositoryRoot, input.headRef, input.newPath),
      ],
      { concurrency: 2 },
    );
    return { oldContents, newContents } satisfies ReviewDiffFileContentsResult;
  });

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    checkpointGitCommand(
      "JjVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      { allowNonZeroExit: true, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) return null;
        const commitId = result.stdout.trim();
        return commitId.length > 0 ? commitId : null;
      }),
    );

  const checkpointRelativePath = Effect.fn("JjVcsDriver.checkpoints.relativePath")(function* (
    cwd: string,
  ) {
    const repository = yield* detectRepository(cwd);
    if (!repository) return ".";
    const [root, directory] = yield* Effect.all([
      fileSystem.realPath(repository.rootPath),
      fileSystem.realPath(cwd),
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            cwd,
            operation: "JjVcsDriver.checkpoints.relativePath",
            detail: "Could not resolve checkpoint directory.",
            cause,
          }),
      ),
    );
    return path.relative(root, directory).replaceAll(path.sep, "/") || ".";
  });

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("JjVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      const operation = "JjVcsDriver.checkpoints.captureCheckpoint";
      // Every jj command snapshots the working copy first. The resulting @ commit
      // is therefore an exact checkpoint without rewriting the user's change.
      const commitId = yield* resolveCommit(operation, input.cwd, "@");
      if (commitId === null) {
        return yield* new VcsProcessExitError({
          operation,
          command: "jj log -r @",
          cwd: input.cwd,
          exitCode: 0,
          detail: "jj did not return a working-copy commit id.",
        });
      }
      // Jujutsu's Git backend shares its object database with the colocated Git
      // repository. A private ref roots its Git objects for GC without exposing
      // a bookmark. Native restore also needs JJ's revision index: explicit
      // operation-history pruning/reindexing can remove that visibility.
      yield* checkpointGitCommand(operation, input.cwd, [
        "update-ref",
        input.checkpointRef,
        commitId,
      ]);
    }),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    restoreCheckpoint: Effect.fn("JjVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      let commitId = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
      if (commitId === null && input.fallbackToHead === true) {
        commitId = yield* resolveCommit(
          "JjVcsDriver.checkpoints.restoreCheckpoint.fallback",
          input.cwd,
          "@-",
        );
      }
      if (commitId === null) return false;
      if (
        (yield* resolveCommit(
          "JjVcsDriver.checkpoints.restoreCheckpoint.resolve",
          input.cwd,
          jjCommit(commitId),
        )) === null
      )
        return yield* new VcsUnsupportedOperationError({
          operation: "JjVcsDriver.checkpoints.restoreCheckpoint",
          kind: "jj",
          detail:
            "JJ cannot resolve this retained checkpoint revision. The working-copy files have not been changed.",
        });

      const relative = yield* checkpointRelativePath(input.cwd);
      yield* jjCommand(
        process,
        "JjVcsDriver.checkpoints.restoreCheckpoint",
        input.cwd,
        [
          "restore",
          "--from",
          jjCommit(commitId),
          "--into",
          "@",
          "--",
          `root:${jjString(relative || ".")}`,
        ],
        { timeoutMs: 20_000, maxOutputBytes: 256 * 1024 },
      );
      return true;
    }),

    diffCheckpoints: Effect.fn("JjVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      let fromRevision = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      if (fromRevision === null && input.fallbackFromToHead === true) {
        fromRevision = yield* resolveCommit(
          "JjVcsDriver.checkpoints.diffCheckpoints.fallback",
          input.cwd,
          "@-",
        );
      }
      const toRevision = yield* resolveCheckpointCommit(input.cwd, input.toCheckpointRef);
      if (fromRevision === null || toRevision === null) {
        return yield* new VcsProcessExitError({
          operation: "JjVcsDriver.checkpoints.diffCheckpoints",
          command: "jj diff",
          cwd: input.cwd,
          exitCode: 1,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const relative = yield* checkpointRelativePath(input.cwd);
      // Private checkpoint refs root Git-backend objects; diff them without
      // importing refs into jj or depending on jj's visible revision graph.
      const result = yield* checkpointGitCommand(
        "JjVcsDriver.checkpoints.diffCheckpoints",
        input.cwd,
        [
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          fromRevision,
          toRevision,
          "--",
          `:(literal)${relative || "."}`,
        ],
        {
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: input.format === "numstat" ? "error" : "truncate",
        },
      );
      return result.stdout;
    }),

    deleteCheckpointRefs: Effect.fn("JjVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            checkpointGitCommand(
              "JjVcsDriver.checkpoints.deleteCheckpointRefs",
              input.cwd,
              ["update-ref", "-d", checkpointRef],
              { allowNonZeroExit: true },
            ),
          { discard: true },
        );
      },
    ),
  };

  const readGitBackend: JjVcsDriverShape["readGitBackend"] = (input) => {
    // This bridge exists for hosting metadata and object reads only. New
    // user-history operations must be implemented with jj, not added here.
    if (
      !["log", "show", "diff", "rev-parse", "for-each-ref", "config", "remote"].includes(
        input.args[0] ?? "",
      ) ||
      (input.args[0] === "config" && !input.args.includes("--get")) ||
      (input.args[0] === "remote" && input.args.length !== 1)
    ) {
      return Effect.fail(
        new VcsRepositoryDetectionError({
          operation: input.operation,
          cwd: input.cwd,
          detail: "Refusing a mutating Git command in a Jujutsu workspace.",
        }),
      );
    }
    return checkpointGitCommand(input.operation, input.cwd, input.args, input);
  };

  const stableBase = Effect.fn("JjVcsDriver.stableBase")(function* (cwd: string, revision: string) {
    const mutable = (yield* jjCommand(process, "JjVcsDriver.stableBase", cwd, [
      "log",
      "-r",
      `::(${jjRef(revision)}) & working_copies()`,
      "--no-graph",
      "-T",
      'commit_id ++ "\\n"',
    ])).stdout.trim();
    // Never make a workspace descend from another workspace's mutable @.
    if (mutable.includes("\n"))
      return yield* new VcsRepositoryDetectionError({
        operation: "JjVcsDriver.stableBase",
        cwd,
        detail: "Workspace base depends on several mutable working copies.",
      });
    const direct = (yield* jjCommand(process, "JjVcsDriver.stableBase", cwd, [
      "log",
      "--ignore-working-copy",
      "-r",
      jjRef(revision),
      "--no-graph",
      "-T",
      'commit_id ++ "\\n"',
    ])).stdout.trim();
    if (mutable && direct !== mutable)
      return yield* new VcsRepositoryDetectionError({
        operation: "JjVcsDriver.stableBase",
        cwd,
        detail: "Workspace base descends from a mutable working copy; choose a stable revision.",
      });
    const parents = mutable
      ? (yield* jjCommand(process, "JjVcsDriver.stableBase", cwd, [
          "log",
          "--ignore-working-copy",
          "-r",
          `parents(${jjCommit(mutable)})`,
          "--no-graph",
          "-T",
          'commit_id ++ "\\n"',
        ])).stdout.trim()
      : direct;
    const revisions = parents.split("\n").filter((value) => /^[a-f0-9]{40,64}$/.test(value));
    if (revisions.length === 0)
      return yield* new VcsRepositoryDetectionError({
        operation: "JjVcsDriver.stableBase",
        cwd,
        detail: "No stable workspace base is available.",
      });
    return revisions;
  });

  const createRef: JjVcsDriverShape["createRef"] = Effect.fn("JjVcsDriver.createRef")(
    function* (input) {
      const ownsTrunk = yield* resolveCommit(
        "JjVcsDriver.createRef.trunk",
        input.cwd,
        '@ & (bookmarks(exact:"main") | bookmarks(exact:"master") | trunk())',
      );
      if (ownsTrunk !== null)
        return yield* new VcsRepositoryDetectionError({
          cwd: input.cwd,
          operation: "JjVcsDriver.createRef",
          detail:
            "Trunk bookmarks the working-copy change. Use JJ to separate that change before creating a feature bookmark.",
        });
      yield* jjCommand(process, "JjVcsDriver.createRef", input.cwd, [
        "bookmark",
        "create",
        "-r",
        // After a commit, @ is an unnamed empty child. Name the recorded
        // change instead of creating an unpublishable placeholder bookmark.
        'coalesce(@ ~ (empty() & description(exact:"")), @- ~ root(), @)',
        "--",
        input.refName,
      ]);
      return { refName: input.refName };
    },
  );

  const switchRef: JjVcsDriverShape["switchRef"] = Effect.fn("JjVcsDriver.switchRef")(
    function* (input) {
      const change = yield* currentChange(input.cwd);
      const selected = yield* resolveCommit(
        "JjVcsDriver.switchRef",
        input.cwd,
        jjRef(input.refName),
      );
      const associated = yield* associatedBookmarks(input.cwd, yield* listBookmarks(input.cwd));
      if (
        selected === change?.commitId ||
        (associated.length === 1 && associated[0]?.name === input.refName)
      )
        return { refName: input.refName };
      // New child preserves the current change instead of editing or discarding it.
      const revision = yield* stableBase(input.cwd, input.refName);
      yield* jjCommand(process, "JjVcsDriver.switchRef", input.cwd, [
        "new",
        ...revision.map(jjCommit),
        "-m",
        "",
      ]);
      return { refName: (yield* localStatus(input.cwd)).refName };
    },
  );

  const listRefs: JjVcsDriverShape["listRefs"] = Effect.fn("JjVcsDriver.listRefs")(
    function* (input) {
      if (input.refresh) {
        const remotes = yield* listRemotes(input.cwd);
        for (const remote of remotes.remotes)
          yield* fetchRemote({ cwd: input.cwd, remoteName: remote.name });
      }
      yield* currentChange(input.cwd);
      const [bookmarks, workspaces, remotes, repository, trunkCommit] = yield* Effect.all([
        listBookmarks(input.cwd),
        input.includeWorkspaces ? listWorkspaceRecords(input.cwd) : Effect.succeed([]),
        listRemotes(input.cwd),
        detectRepository(input.cwd),
        resolveCommit("JjVcsDriver.listRefs", input.cwd, "trunk()"),
      ]);
      const candidates = yield* associatedBookmarks(input.cwd, bookmarks);
      const currentBookmark = candidates.length === 1 ? candidates[0] : undefined;
      const hasPrimaryRemote =
        remotes.remotes.some((remote) => remote.isPrimary) || remotes.remotes.length === 1;
      const refs = [
        ...bookmarks
          .filter((bookmark) => bookmark.target !== null)
          .map((bookmark) => ({
            kind: "bookmark" as const,
            name:
              bookmark.remoteName === null
                ? bookmark.name
                : `${bookmark.name}@${bookmark.remoteName}`,
            isRemote: bookmark.remoteName !== null,
            ...(bookmark.remoteName === null ? {} : { remoteName: bookmark.remoteName }),
            current: bookmark.remoteName === null && bookmark.name === currentBookmark?.name,
            isDefault:
              bookmark.name === "main" ||
              bookmark.name === "master" ||
              bookmark.target === trunkCommit,
            worktreePath:
              bookmark.remoteName === null && bookmark.name === currentBookmark?.name
                ? (repository?.rootPath ?? null)
                : null,
          })),
        ...(input.includeWorkspaces ? workspaces : []).map((workspace) => ({
          kind: "workspace" as const,
          name: `${workspace.name}@`,
          isRemote: false,
          current: workspace.path === repository?.rootPath,
          isDefault: false,
          worktreePath: workspace.path,
        })),
      ]
        .filter(
          (ref) =>
            (input.refKind !== "remote" || ref.isRemote) &&
            (input.refKind !== "local" || !ref.isRemote) &&
            (!input.query || ref.name.toLowerCase().includes(input.query.toLowerCase())),
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? 100;
      return {
        refs: refs.slice(cursor, cursor + limit),
        isRepo: true,
        hasPrimaryRemote,
        nextCursor: cursor + limit < refs.length ? cursor + limit : null,
        totalCount: refs.length,
      };
    },
  );

  const pruneWorktrees: JjVcsDriverShape["pruneWorktrees"] = Effect.fn(
    "JjVcsDriver.pruneWorktrees",
  )(function* (cwd) {
    for (const workspace of yield* listWorkspaceRecords(cwd)) {
      if (workspace.path === null) {
        yield* jjCommand(process, "JjVcsDriver.pruneWorktrees", cwd, [
          "workspace",
          "forget",
          "--",
          workspace.name,
        ]);
      }
    }
  });

  const createWorktree = Effect.fn("JjVcsDriver.createWorktree")(function* (
    input: VcsCreateWorktreeInput,
    recovery?: { workspaceName: string; snapshot: string },
  ) {
    if (input.path === null) {
      return yield* new VcsProcessExitError({
        operation: "JjVcsDriver.createWorktree",
        command: "jj workspace add",
        cwd: input.cwd,
        exitCode: 1,
        detail: "Jujutsu workspace creation requires an explicit destination path.",
      });
    }
    const workspacePath = path.resolve(input.cwd, input.path);
    if (
      input.newRefName &&
      (yield* listBookmarks(input.cwd)).some(
        (bookmark) => bookmark.remoteName === null && bookmark.name === input.newRefName,
      )
    ) {
      return yield* new VcsRepositoryDetectionError({
        cwd: input.cwd,
        operation: "JjVcsDriver.createWorktree",
        detail: `Bookmark already exists: ${input.newRefName}`,
      });
    }
    const workspaceName =
      recovery?.workspaceName ?? (yield* workspaceIdentity(input.cwd, workspacePath));
    yield* fileSystem.makeDirectory(path.dirname(workspacePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "JjVcsDriver.createWorktree",
            cwd: input.cwd,
            detail: `failed to create the Jujutsu workspace parent directory for ${workspacePath}`,
            cause,
          }),
      ),
    );
    yield* jjCommand(
      process,
      "JjVcsDriver.createWorktree",
      input.cwd,
      [
        "workspace",
        "add",
        workspacePath,
        "--name",
        workspaceName,
        ...(recovery ? [recovery.snapshot] : yield* stableBase(input.cwd, input.refName)).flatMap(
          (revision) => ["-r", jjCommit(revision)],
        ),
      ],
      { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 },
    );
    if (input.newRefName !== undefined) {
      // The launch contract explicitly requests a new publishable ref. Name
      // the new working-copy change, never the base revision in another workspace.
      yield* jjCommand(process, "JjVcsDriver.createWorktree.bookmark", workspacePath, [
        "bookmark",
        "create",
        "-r",
        "@",
        "--",
        input.newRefName,
      ]).pipe(
        Effect.tapError(() =>
          removeWorktree({ cwd: input.cwd, path: workspacePath }).pipe(Effect.ignore),
        ),
      );
    }
    return { worktree: { path: workspacePath, refName: input.newRefName ?? `${workspaceName}@` } };
  });

  const recoverWorktree: JjVcsDriverShape["recoverWorktree"] = Effect.fn(
    "JjVcsDriver.recoverWorktree",
  )(function* (input) {
    if (
      yield* fileSystem.exists(path.resolve(input.cwd, input.path)).pipe(
        Effect.mapError(
          (cause) =>
            new VcsRepositoryDetectionError({
              cwd: input.cwd,
              operation: "JjVcsDriver.recoverWorktree",
              detail: "Could not inspect workspace destination.",
              cause,
            }),
        ),
      )
    )
      return yield* new VcsRepositoryDetectionError({
        cwd: input.cwd,
        operation: "JjVcsDriver.recoverWorktree",
        detail: "Refusing to recover over an existing workspace path.",
      });
    const identity = yield* workspaceIdentity(input.cwd, input.path);
    const workspace = (yield* listWorkspaceRecords(input.cwd)).find((workspace) =>
      workspace.path !== null
        ? path.resolve(workspace.path) === path.resolve(input.cwd, input.path)
        : workspace.name === identity ||
          (input.refName.endsWith("@") && workspace.name === input.refName.slice(0, -1)) ||
          workspace.name === input.refName.replace(/[^a-zA-Z0-9_-]/g, "-"),
    );
    if (!workspace) {
      // Automatic cleanup deliberately forgets a clean workspace. Resume it
      // from the saved bookmark, but never guess from an unrelated working copy.
      const bookmark = (yield* listBookmarks(input.cwd)).find(
        (bookmark) =>
          bookmark.remoteName === null &&
          bookmark.name === input.refName &&
          bookmark.target !== null &&
          !bookmark.conflict,
      );
      if (!bookmark?.target)
        return yield* new VcsRepositoryDetectionError({
          cwd: input.cwd,
          operation: "JjVcsDriver.recoverWorktree",
          detail:
            "The original workspace identity and saved bookmark are unavailable; create a new workspace explicitly.",
        });
      yield* createWorktree({ cwd: input.cwd, path: input.path, refName: bookmark.name });
      const unclaimed = yield* jjCommand(process, "JjVcsDriver.recoverWorktree", input.cwd, [
        "log",
        "--ignore-working-copy",
        "-r",
        `${jjCommit(bookmark.target)} & empty() & description(exact:"") & ~working_copies() & ~immutable()`,
        "--no-graph",
        "-T",
        "commit_id",
      ]);
      if (unclaimed.stdout.trim())
        yield* jjCommand(
          process,
          "JjVcsDriver.recoverWorktree",
          path.resolve(input.cwd, input.path),
          ["edit", jjCommit(bookmark.target)],
        );
      return;
    }
    const snapshot = yield* resolveCommit(
      "JjVcsDriver.recoverWorktree",
      input.cwd,
      `${jjString(workspace.name)}@`,
    );
    if (!snapshot)
      return yield* new VcsRepositoryDetectionError({
        cwd: input.cwd,
        operation: "JjVcsDriver.recoverWorktree",
        detail: "The missing workspace's snapshot is unavailable.",
      });
    const temporaryName = `t3-recover-${yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => new VcsRepositoryDetectionError({ cwd: input.cwd, operation: "JjVcsDriver.recoverWorktree", detail: "Could not allocate a recovery identity.", cause })))}`;
    // Retain the original snapshot until the replacement is on disk. A failed
    // add must not erase the only workspace reference to the lost contents.
    yield* createWorktree(
      { cwd: input.cwd, path: input.path, refName: snapshot },
      { workspaceName: temporaryName, snapshot },
    );
    // Resume the original change, rather than making its uncommitted edits a
    // parent commit. Its change id and pending diff must survive recovery.
    yield* jjCommand(process, "JjVcsDriver.recoverWorktree", path.resolve(input.cwd, input.path), [
      "edit",
      jjCommit(snapshot),
    ]);
    yield* jjCommand(process, "JjVcsDriver.recoverWorktree", input.cwd, [
      "workspace",
      "forget",
      "--",
      workspace.name,
    ]);
    yield* jjCommand(process, "JjVcsDriver.recoverWorktree", path.resolve(input.cwd, input.path), [
      "workspace",
      "rename",
      "--",
      workspace.name,
    ]);
  });

  const hasUntrackedFiles: JjVcsDriverShape["hasUntrackedFiles"] = Effect.fn(
    "JjVcsDriver.hasUntrackedFiles",
  )(function* (cwd) {
    // Do not auto-track a file created after the caller checked cleanliness.
    const tracked = new Set((yield* listWorkspaceFiles(cwd, false)).paths);
    const directories = new Set(
      [...tracked].flatMap((file) => {
        const parts = file.split("/");
        return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
      }),
    );
    const failure = (cause: unknown) =>
      new VcsRepositoryDetectionError({
        operation: "JjVcsDriver.hasUntrackedFiles",
        cwd,
        detail: "Could not inspect workspace files.",
        cause,
      });
    const inspect = Effect.fnUntraced(function* (
      relative: string,
    ): Effect.fn.Return<boolean, VcsError> {
      for (const name of yield* fileSystem
        .readDirectory(path.join(cwd, relative))
        .pipe(Effect.mapError(failure))) {
        if (relative === "" && (name === ".jj" || name === ".git")) continue;
        const child = relative ? `${relative}/${name}` : name;
        const link = yield* fileSystem.readLink(path.join(cwd, child)).pipe(Effect.option);
        if (Option.isSome(link)) {
          if (!tracked.has(child)) return true;
          else continue;
        }
        const info = yield* fileSystem.stat(path.join(cwd, child)).pipe(Effect.mapError(failure));
        if (info.type === "Directory") {
          if (!directories.has(child) || (yield* inspect(child))) return true;
        } else if (!tracked.has(child)) return true;
      }
      return false;
    });
    return yield* inspect("");
  });

  const validateWorktreePath: JjVcsDriverShape["validateWorktreePath"] = Effect.fn(
    "JjVcsDriver.validateWorktreePath",
  )(function* (input) {
    const target = path.resolve(input.cwd, input.path);
    if (
      !(yield* listWorkspaces(input.cwd)).some(
        (workspace) => path.resolve(workspace.path) === target,
      )
    )
      return yield* new VcsRepositoryDetectionError({
        operation: "JjVcsDriver.validateWorktreePath",
        cwd: input.cwd,
        detail: "The selected workspace does not belong to this Jujutsu repository.",
      });
    const canonicalBackend = (cwd: string) =>
      resolveGitBackendDir(cwd).pipe(
        Effect.flatMap((directory) => fileSystem.realPath(directory)),
        Effect.mapError(
          (cause) =>
            new VcsRepositoryDetectionError({
              operation: "JjVcsDriver.validateWorktreePath",
              cwd,
              detail: "Could not verify workspace repository ownership.",
              cause,
            }),
        ),
      );
    if ((yield* canonicalBackend(input.cwd)) !== (yield* canonicalBackend(target)))
      return yield* new VcsRepositoryDetectionError({
        operation: "JjVcsDriver.validateWorktreePath",
        cwd: input.cwd,
        detail: "The workspace path now belongs to another Jujutsu repository.",
      });
  });

  const removeWorktree: JjVcsDriverShape["removeWorktree"] = Effect.fn(
    "JjVcsDriver.removeWorktree",
  )(function* (input) {
    const requestedPath = path.normalize(path.resolve(input.cwd, input.path));
    if (
      !(yield* fileSystem.exists(requestedPath).pipe(
        Effect.mapError(
          (cause) =>
            new VcsRepositoryDetectionError({
              cwd: input.cwd,
              operation: "JjVcsDriver.removeWorktree",
              detail: "Could not inspect the workspace path.",
              cause,
            }),
        ),
      ))
    )
      return;
    const workspace = (yield* listWorkspaces(input.cwd)).find(
      (candidate) => path.normalize(path.resolve(candidate.path)) === requestedPath,
    );
    if (workspace === undefined) {
      return yield* new VcsRepositoryDetectionError({
        operation: "JjVcsDriver.removeWorktree",
        cwd: input.cwd,
        detail: `Refusing to remove an unregistered workspace: ${requestedPath}`,
      });
    }
    const marker = yield* fileSystem.stat(path.join(requestedPath, ".jj", "repo")).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "JjVcsDriver.removeWorktree",
            cwd: input.cwd,
            detail: "Could not validate workspace metadata",
            cause,
          }),
      ),
    );
    if (marker.type !== "File") {
      return yield* new VcsRepositoryDetectionError({
        operation: "JjVcsDriver.removeWorktree",
        cwd: input.cwd,
        detail: "Refusing to remove the primary Jujutsu repository.",
      });
    }
    yield* validateWorktreePath({ cwd: input.cwd, path: requestedPath });
    const source = yield* fileSystem.realPath(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "JjVcsDriver.removeWorktree",
            cwd: input.cwd,
            detail: "Could not inspect the source workspace.",
            cause,
          }),
      ),
    );
    if (source === requestedPath || source.startsWith(`${requestedPath}${path.sep}`))
      return yield* new VcsRepositoryDetectionError({
        operation: "JjVcsDriver.removeWorktree",
        cwd: input.cwd,
        detail: "Remove this workspace from another checkout.",
      });
    const snapshot = yield* currentChange(requestedPath);
    if (input.force !== true) {
      const status = yield* localStatus(requestedPath);
      if (
        !snapshot ||
        status.hasWorkingTreeChanges ||
        (yield* hasUntrackedFiles(requestedPath)) ||
        (yield* currentChange(requestedPath))?.commitId !== snapshot.commitId
      ) {
        return yield* new VcsRepositoryDetectionError({
          operation: "JjVcsDriver.removeWorktree",
          cwd: input.cwd,
          detail: "Workspace contains changes or ignored/untracked files; force is required.",
        });
      }
    }
    const detachedMetadata = path.join(
      (yield* jjCommand(process, "JjVcsDriver.removeWorktree.root", input.cwd, [
        "root",
      ])).stdout.trim(),
      ".jj",
      `t3-removing-${yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => new VcsRepositoryDetectionError({ cwd: input.cwd, operation: "JjVcsDriver.removeWorktree", detail: "Could not allocate detached workspace metadata.", cause })))}`,
    );
    // Detach metadata before deletion so status refreshes cannot snapshot a
    // half-deleted tree. Keep registration and metadata if deletion fails.
    yield* fileSystem.rename(path.join(requestedPath, ".jj"), detachedMetadata).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            cwd: input.cwd,
            operation: "JjVcsDriver.removeWorktree",
            detail: "Could not detach workspace metadata before removal.",
            cause,
          }),
      ),
    );
    yield* fileSystem.remove(requestedPath, { recursive: true, force: input.force === true }).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "JjVcsDriver.removeWorktree",
            cwd: input.cwd,
            detail: `failed to remove Jujutsu workspace at ${requestedPath}`,
            cause,
          }),
      ),
    );
    // Keep the snapshot reference if filesystem removal or forgetting fails.
    // Recovery can then resume the original change rather than guess a base.
    yield* jjCommand(
      process,
      "JjVcsDriver.removeWorktree",
      input.cwd,
      ["workspace", "forget", "--ignore-working-copy", "--", workspace.name],
      { timeoutMs: 10_000 },
    );
    yield* fileSystem.remove(detachedMetadata, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            cwd: input.cwd,
            operation: "JjVcsDriver.removeWorktree",
            detail: "Workspace removed, but detached metadata could not be cleaned up.",
            cause,
          }),
      ),
    );
  });

  const renameBookmark: JjVcsDriverShape["renameBookmark"] = Effect.fn(
    "JjVcsDriver.renameBookmark",
  )(function* (input) {
    yield* jjCommand(process, "JjVcsDriver.renameBookmark", input.cwd, [
      "bookmark",
      "rename",
      "--",
      input.oldBranch,
      input.newBranch,
    ]);
    return { branch: input.newBranch };
  });

  const fetchRemote: JjVcsDriverShape["fetchRemote"] = (input) =>
    jjCommand(
      process,
      "JjVcsDriver.fetchRemote",
      input.cwd,
      ["git", "fetch", "--remote", input.remoteName],
      {
        timeoutMs: 60_000,
        maxOutputBytes: 256 * 1024,
        env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      },
    ).pipe(Effect.asVoid);

  const resolveRemoteTrackingCommit: JjVcsDriverShape["resolveRemoteTrackingCommit"] = Effect.fn(
    "JjVcsDriver.resolveRemoteTrackingCommit",
  )(function* (input) {
    const remoteRefName = input.refName.includes("@")
      ? input.refName
      : `${input.refName}@${input.fallbackRemoteName}`;
    const commitSha = yield* resolveCommit(
      "JjVcsDriver.resolveRemoteTrackingCommit",
      input.cwd,
      jjRef(remoteRefName),
    );
    if (commitSha === null) {
      return yield* new VcsProcessExitError({
        operation: "JjVcsDriver.resolveRemoteTrackingCommit",
        command: "jj log",
        cwd: input.cwd,
        exitCode: 1,
        detail: `Unable to resolve Jujutsu remote bookmark '${remoteRefName}'.`,
      });
    }
    return { commitSha, remoteRefName };
  });

  const filterIgnoredPaths: VcsDriver.VcsDriverShape["filterIgnoredPaths"] = Effect.fn(
    "JjVcsDriver.filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) return relativePaths;

    const operation = "JjVcsDriver.filterIgnoredPaths";
    const ignoredPaths = new Set<string>();

    yield* Effect.scoped(
      Effect.gen(function* () {
        const gitDir = yield* makeScopedTempGitDir(fileSystem, operation, cwd);
        const initResult = yield* gitCommand(
          process,
          operation,
          cwd,
          ["--git-dir", gitDir, "init", "--bare"],
          { allowNonZeroExit: true },
        );
        if (initResult.exitCode !== 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git init --bare",
            cwd,
            exitCode: initResult.exitCode,
            detail: initResult.stderr.trim() || "git init --bare failed",
          });
        }

        for (const chunk of chunkPathsForCheckIgnore(relativePaths)) {
          const result = yield* gitCommand(
            process,
            operation,
            cwd,
            [
              "--git-dir",
              gitDir,
              "--work-tree",
              cwd,
              "check-ignore",
              "--no-index",
              "-z",
              "--stdin",
            ],
            {
              stdin: `${chunk.join("\0")}\0`,
              allowNonZeroExit: true,
              timeoutMs: 20_000,
              maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            },
          );

          if (result.exitCode !== 0 && result.exitCode !== 1) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git check-ignore",
              cwd,
              exitCode: result.exitCode,
              detail: result.stderr.trim() || "git check-ignore failed",
            });
          }

          for (const ignoredPath of splitNullSeparatedPaths(
            result.stdout,
            result.stdoutTruncated,
          )) {
            ignoredPaths.add(ignoredPath);
          }
        }
      }),
    );

    return ignoredPaths.size === 0
      ? relativePaths
      : relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const driver = {
    capabilities,
    execute,
    checkpoints,
    initRepository,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listWorkspaces,
    listRemotes,
    filterIgnoredPaths,
    currentChange,
    listBookmarks,
    getDiffPreview,
    getDiffFileContents,
    createWorktree,
    removeWorktree,
    renameBookmark,
    listRefs,
    createRef,
    switchRef,
    pruneWorktrees,
    recoverWorktree,
    readGitBackend,
    fetchRemote,
    resolveRemoteTrackingCommit,
    localStatus,
    hasUntrackedFiles,
    validateWorktreePath,
  } satisfies Omit<JjVcsDriverShape, "workflow">;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const defaultWorkspacePath = Option.isSome(config)
    ? (cwd: string, refName: string) =>
        path.join(config.value.worktreesDir, path.basename(cwd), refName.replaceAll("/", "-"))
    : undefined;
  return { ...driver, workflow: JjWorkflow.make(driver, defaultWorkspacePath) };
});

export const makeJjVcsDriver = Effect.fn("makeJjVcsDriver")(function* () {
  return JjVcsDriver.of(yield* makeVcsDriverShape());
});

export const makeVcsDriver = Effect.fn("makeJjGenericVcsDriver")(function* () {
  return VcsDriver.VcsDriver.of(yield* makeVcsDriverShape());
});

export const layer = Layer.effect(JjVcsDriver, makeJjVcsDriver());
export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver());
