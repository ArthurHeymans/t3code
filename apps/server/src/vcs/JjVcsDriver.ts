import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  VcsProcessExitError,
  VcsRepositoryDetectionError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsError,
  type VcsRemoveWorktreeInput,
  type VcsStatusLocalResult,
  type VcsWorkspace,
} from "@t3tools/contracts";

import * as VcsDriver from "./VcsDriver.ts";
import { nowFreshness } from "./VcsFreshness.ts";
import * as VcsProcess from "./VcsProcess.ts";

export interface JjVcsDriverShape extends VcsDriver.VcsDriverShape {
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
  readonly renameWorkspace: (input: {
    readonly cwd: string;
    readonly newName: string;
  }) => Effect.Effect<{ readonly branch: string }, VcsError>;
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
}

export interface JjCurrentChange {
  readonly changeId: string;
  readonly commitId: string | null;
  readonly description: string | null;
}

export interface JjBookmark {
  readonly name: string;
  readonly target: string | null;
}

export class JjVcsDriver extends Context.Service<JjVcsDriver, JjVcsDriverShape>()(
  "t3/vcs/JjVcsDriver",
) {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
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
      const [name, ...urlParts] = line.split(/\s+/g);
      const url = urlParts.join(" ").trim();
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
      const [name, target] = parseNullRecord(line);
      return { name: name ?? line, target: target || null };
    });
}

function decodeJjWorkspaceList(raw: string): ReadonlyArray<VcsWorkspace> {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, path] = parseNullRecord(line);
      return name && path ? [{ name, path, current: false }] : [];
    })
    .flat();
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  return stdout.split(/\r?\n/g).flatMap((line) => {
    if (line.trim().length === 0) return [];
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath = pathParts.at(-1)?.trim() ?? "";
    if (rawPath.length === 0) return [];
    const insertions = Number.parseInt(addedRaw ?? "0", 10);
    const deletions = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const path =
      renameArrowIndex === -1 ? rawPath : rawPath.slice(renameArrowIndex + " => ".length).trim();
    return [
      {
        path: path.length > 0 ? path : rawPath,
        insertions: Number.isFinite(insertions) ? insertions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
      },
    ];
  });
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
  const capabilities = {
    kind: "jj" as const,
    supportsWorktrees: true as const,
    supportsWorkspaceSelection: true as const,
    supportsBookmarks: true as const,
    supportsAtomicSnapshot: true as const,
    supportsPushDefaultRemote: false as const,
    ignoreClassifier: "git-compatible-fallback" as const,
  };

  const isInsideWorkTree: VcsDriver.VcsDriverShape["isInsideWorkTree"] = (cwd) =>
    jjCommand(process, "JjVcsDriver.isInsideWorkTree", cwd, ["root"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }).pipe(
      Effect.map((result) => result.exitCode === 0 && result.stdout.trim().length > 0),
      Effect.catch(() => Effect.succeed(false)),
    );

  const execute: VcsDriver.VcsDriverShape["execute"] = (input) =>
    jjCommand(process, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
    });

  const initRepository: VcsDriver.VcsDriverShape["initRepository"] = (input) =>
    jjCommand(process, "JjVcsDriver.initRepository", input.cwd, ["git", "init"]).pipe(
      Effect.asVoid,
    );

  const detectRepository: VcsDriver.VcsDriverShape["detectRepository"] = Effect.fn(
    "JjVcsDriver.detectRepository",
  )(function* (cwd) {
    const root = yield* jjCommand(process, "JjVcsDriver.detectRepository.root", cwd, ["root"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!root || root.exitCode !== 0) return null;

    const rootPath = root.stdout.trim();
    if (rootPath.length === 0) return null;

    return {
      kind: "jj" as const,
      rootPath,
      metadataPath: `${rootPath.replace(/[\\/]$/g, "")}/.jj`,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriverShape["listWorkspaceFiles"] = (cwd) =>
    jjCommand(process, "JjVcsDriver.listWorkspaceFiles", cwd, ["file", "list"], {
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
    }).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              return {
                paths: splitLineSeparatedPaths(result.stdout, result.stdoutTruncated),
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
        ["git", "remote", "list"],
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
      ["bookmark", "list", "--template", 'name ++ "\\0" ++ target.commit_id() ++ "\\n"'],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 256 * 1024,
      },
    ).pipe(
      Effect.map((result) => (result.exitCode === 0 ? decodeJjBookmarkList(result.stdout) : [])),
    );

  const listWorkspaces: JjVcsDriverShape["listWorkspaces"] = (cwd) =>
    jjCommand(
      process,
      "JjVcsDriver.listWorkspaces",
      cwd,
      ["workspace", "list", "--template", 'name ++ "\\0" ++ root ++ "\\n"'],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 256 * 1024,
      },
    ).pipe(
      Effect.map((result) => (result.exitCode === 0 ? decodeJjWorkspaceList(result.stdout) : [])),
    );

  const resolveCommit = (operation: string, cwd: string, revision: string) =>
    jjCommand(
      process,
      operation,
      cwd,
      ["log", "-r", revision, "--no-graph", "--template", "commit_id"],
      { allowNonZeroExit: true, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) return null;
        const commitId = result.stdout.trim();
        return commitId.length > 0 ? commitId : null;
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

  const localStatus: JjVcsDriverShape["localStatus"] = Effect.fn("JjVcsDriver.localStatus")(
    function* (cwd) {
      const operation = "JjVcsDriver.localStatus";
      const [change, parentCommit, bookmarks, remotes] = yield* Effect.all([
        currentChange(cwd),
        resolveCommit(operation, cwd, "@-"),
        listBookmarks(cwd),
        listRemotes(cwd),
      ]);
      const currentCommit = change?.commitId ?? (yield* resolveCommit(operation, cwd, "@"));
      const fromCommit =
        parentCommit !== null && !/^0+$/.test(parentCommit)
          ? parentCommit
          : (yield* checkpointGitCommand(operation, cwd, ["mktree"], {
              stdin: "",
              maxOutputBytes: 64 * 1024,
            })).stdout.trim();

      const files =
        currentCommit === null
          ? []
          : parseNumstatEntries(
              (yield* checkpointGitCommand(
                operation,
                cwd,
                ["diff", "--numstat", fromCommit, currentCommit, "--"],
                { timeoutMs: 20_000, maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES },
              )).stdout,
            );
      const currentBookmark = bookmarks.find(
        (bookmark) => bookmark.target !== null && bookmark.target === currentCommit,
      );

      return {
        kind: "jj",
        isRepo: true,
        hasPrimaryRemote: remotes.remotes.some((remote) => remote.isPrimary),
        isDefaultRef: currentBookmark?.name === "main" || currentBookmark?.name === "master",
        refName: currentBookmark?.name ?? change?.changeId.slice(0, 12) ?? null,
        hasWorkingTreeChanges: files.length > 0,
        workingTree: {
          files,
          insertions: files.reduce((total, file) => total + file.insertions, 0),
          deletions: files.reduce((total, file) => total + file.deletions, 0),
        },
      };
    },
  );

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
      // repository. A private ref roots the commit for GC without exposing a jj
      // bookmark or changing which VCS driver owns the workspace.
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

      yield* jjCommand(
        process,
        "JjVcsDriver.checkpoints.restoreCheckpoint",
        input.cwd,
        ["restore", "--from", commitId, "--into", "@"],
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

      const result = yield* jjCommand(
        process,
        "JjVcsDriver.checkpoints.diffCheckpoints",
        input.cwd,
        [
          "diff",
          "--git",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          "--from",
          fromRevision,
          "--to",
          toRevision,
        ],
        { maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES },
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

  const createWorktree: JjVcsDriverShape["createWorktree"] = Effect.fn(
    "JjVcsDriver.createWorktree",
  )(function* (input) {
    const targetName = input.newRefName ?? input.refName;
    const workspaceName = targetName.replaceAll("/", "-");
    if (input.path === null) {
      return yield* new VcsProcessExitError({
        operation: "JjVcsDriver.createWorktree",
        command: "jj workspace add",
        cwd: input.cwd,
        exitCode: 1,
        detail: "Jujutsu workspace creation requires an explicit destination path.",
      });
    }
    const workspacePath = input.path;
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
      ["workspace", "add", workspacePath, "--name", workspaceName, "-r", input.refName],
      { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 },
    );
    return { worktree: { path: workspacePath, refName: targetName } };
  });

  const removeWorktree: JjVcsDriverShape["removeWorktree"] = Effect.fn(
    "JjVcsDriver.removeWorktree",
  )(function* (input) {
    const requestedPath = path.normalize(path.resolve(input.path));
    const workspace = (yield* listWorkspaces(input.cwd)).find(
      (candidate) => path.normalize(path.resolve(candidate.path)) === requestedPath,
    );
    if (workspace !== undefined) {
      yield* jjCommand(
        process,
        "JjVcsDriver.removeWorktree",
        input.cwd,
        ["workspace", "forget", workspace.name],
        { allowNonZeroExit: input.force === true, timeoutMs: 10_000 },
      );
    }
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
  });

  const renameWorkspace: JjVcsDriverShape["renameWorkspace"] = Effect.fn(
    "JjVcsDriver.renameWorkspace",
  )(function* (input) {
    const workspaceName = input.newName.replaceAll("/", "-");
    yield* jjCommand(process, "JjVcsDriver.renameWorkspace", input.cwd, [
      "workspace",
      "rename",
      workspaceName,
    ]);
    return { branch: input.newName };
  });

  const fetchRemote: JjVcsDriverShape["fetchRemote"] = (input) =>
    jjCommand(
      process,
      "JjVcsDriver.fetchRemote",
      input.cwd,
      ["git", "fetch", "--remote", input.remoteName],
      { timeoutMs: 60_000, maxOutputBytes: 256 * 1024 },
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
      remoteRefName,
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

  return {
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
    createWorktree,
    removeWorktree,
    renameWorkspace,
    fetchRemote,
    resolveRemoteTrackingCommit,
    localStatus,
  } satisfies JjVcsDriverShape;
});

export const makeJjVcsDriver = Effect.fn("makeJjVcsDriver")(function* () {
  return JjVcsDriver.of(yield* makeVcsDriverShape());
});

export const makeVcsDriver = Effect.fn("makeJjGenericVcsDriver")(function* () {
  return VcsDriver.VcsDriver.of(yield* makeVcsDriverShape());
});

export const layer = Layer.effect(JjVcsDriver, makeJjVcsDriver());
export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver());
