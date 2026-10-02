import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CheckpointRef, type VcsError } from "@t3tools/contracts";
import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import type { VcsProcessInput, VcsProcessOutput } from "./VcsProcess.ts";
import { VcsProcess, layer as VcsProcessLayer } from "./VcsProcess.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const JjContractLayer = JjVcsDriver.vcsLayer.pipe(
  Layer.provideMerge(VcsProcessLayer),
  Layer.provideMerge(NodeServices.layer),
);

const commandCalls = (calls: ReadonlyArray<VcsProcessInput>) =>
  calls.map((call) => [call.command].concat(call.args));

const processOutput = (stdout: string, exitCode = 0, stderr = ""): VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const runJj = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess;
    yield* process.run({
      operation: "JjVcsDriver.contract.jj",
      command: "jj",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type JjContractError = PlatformError.PlatformError | VcsError;

runVcsDriverContractSuite<VcsProcess, JjContractError>({
  name: "JJ",
  kind: "jj",
  layer: JjContractLayer,
  fixture: {
    createRepo: (cwd) => runJj(cwd, ["git", "init", "--colocate"]),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

describe("JjVcsDriver", () => {
  it.effect("captures, diffs, and restores checkpoints without changing VCS ownership", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-checkpoints-" });
        const repo = path.join(root, "repo");
        yield* runJj(root, ["git", "init", "--colocate", repo]);

        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        const filePath = path.join(repo, "README.md");
        const beforeRef = CheckpointRef.make("refs/t3/checkpoints/test/turn/0");
        const afterRef = CheckpointRef.make("refs/t3/checkpoints/test/turn/1");

        yield* fileSystem.writeFileString(filePath, "before\n");
        yield* driver.checkpoints!.captureCheckpoint({ cwd: repo, checkpointRef: beforeRef });
        yield* fileSystem.writeFileString(filePath, "after\n");
        yield* driver.checkpoints!.captureCheckpoint({ cwd: repo, checkpointRef: afterRef });

        assert.isTrue(
          yield* driver.checkpoints!.hasCheckpointRef({ cwd: repo, checkpointRef: beforeRef }),
        );
        const diff = yield* driver.checkpoints!.diffCheckpoints({
          cwd: repo,
          fromCheckpointRef: beforeRef,
          toCheckpointRef: afterRef,
          ignoreWhitespace: false,
        });
        assert.include(diff, "+after");

        assert.isTrue(
          yield* driver.checkpoints!.restoreCheckpoint({
            cwd: repo,
            checkpointRef: beforeRef,
          }),
        );
        assert.equal(yield* fileSystem.readFileString(filePath), "before\n");
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("creates a registered jj workspace that can use checkpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-workspace-" });
        const repo = path.join(root, "repo");
        const workspacePath = path.join(root, "workspaces", "feature");
        yield* runJj(root, ["git", "init", "--colocate", repo]);
        yield* fileSystem.writeFileString(path.join(repo, "README.md"), "root\n");

        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        const created = yield* driver.createWorktree({
          cwd: repo,
          refName: "@",
          newRefName: "feature/test",
          path: workspacePath,
        });

        assert.deepStrictEqual(created, {
          worktree: { path: workspacePath, refName: "feature/test" },
        });
        assert.isTrue(
          (yield* driver.listWorkspaces(repo)).some(
            (workspace) => workspace.name.startsWith("t3-") && workspace.path === workspacePath,
          ),
        );

        const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/workspace/turn/0");
        yield* fileSystem.writeFileString(
          path.join(workspacePath, "workspace.txt"),
          "checkpoint\n",
        );
        yield* driver.checkpoints!.captureCheckpoint({ cwd: workspacePath, checkpointRef });
        assert.isTrue(
          yield* driver.checkpoints!.hasCheckpointRef({ cwd: workspacePath, checkpointRef }),
        );
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("reports Jujutsu working-copy insertion and deletion counts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-status-" });
        const repo = path.join(root, "repo");
        yield* runJj(root, ["git", "init", "--colocate", repo]);
        yield* fileSystem.writeFileString(path.join(repo, "README.md"), "before\n");

        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        const initialStatus = yield* driver.localStatus(repo);
        assert.equal(initialStatus.workingTree.insertions, 1);
        assert.equal(initialStatus.workingTree.deletions, 0);

        yield* runJj(repo, ["new"]);
        yield* fileSystem.writeFileString(path.join(repo, "README.md"), "after\nextra\n");
        const status = yield* driver.localStatus(repo);

        assert.equal(status.kind, "jj");
        assert.isTrue(status.hasWorkingTreeChanges);
        assert.equal(status.workingTree.insertions, 2);
        assert.equal(status.workingTree.deletions, 1);
        assert.deepStrictEqual(status.workingTree.files, [
          { path: "README.md", insertions: 2, deletions: 1 },
        ]);
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("reads merge-change stats and creates a workspace on both stable parents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-merge-status-" });
        const repo = path.join(root, "repo");
        yield* runJj(root, ["git", "init", "--no-colocate", repo]);
        yield* fs.writeFileString(path.join(repo, "a.txt"), "a\n");
        yield* runJj(repo, ["commit", "-m", "parent A"]);
        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        const first = (yield* driver.execute({
          cwd: repo,
          operation: "test",
          args: ["log", "-r", "@-", "--no-graph", "-T", "commit_id"],
        })).stdout.trim();
        yield* runJj(repo, ["new", "root()"]);
        yield* fs.writeFileString(path.join(repo, "b.txt"), "b\n");
        yield* runJj(repo, ["commit", "-m", "parent B"]);
        const second = (yield* driver.execute({
          cwd: repo,
          operation: "test",
          args: ["log", "-r", "@-", "--no-graph", "-T", "commit_id"],
        })).stdout.trim();
        yield* runJj(repo, ["new", first, second]);
        assert.isFalse((yield* driver.localStatus(repo)).hasWorkingTreeChanges);
        yield* fs.writeFileString(path.join(repo, "merge.txt"), "merged edit\n");
        assert.deepStrictEqual((yield* driver.localStatus(repo)).workingTree.files, [
          { path: "merge.txt", insertions: 1, deletions: 0 },
        ]);
        const workspace = path.join(root, "workspace");
        yield* driver.createWorktree({ cwd: repo, refName: "@", path: workspace });
        assert.isTrue(yield* fs.exists(path.join(workspace, "a.txt")));
        assert.isTrue(yield* fs.exists(path.join(workspace, "b.txt")));
        assert.isFalse(yield* fs.exists(path.join(workspace, "merge.txt")));
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("scopes checkpoint summaries and restore to a non-colocated thread directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-checkpoint-scope-" });
        const repo = path.join(root, "repo");
        yield* runJj(root, ["git", "init", "--no-colocate", repo]);
        const cwd = path.join(repo, "thread");
        yield* fs.makeDirectory(cwd);
        yield* fs.writeFileString(path.join(cwd, "a file.txt"), "before\n");
        yield* fs.writeFileString(path.join(repo, "sibling.txt"), "before\n");
        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        const from = CheckpointRef.make("refs/t3/checkpoints/scoped/0");
        const to = CheckpointRef.make("refs/t3/checkpoints/scoped/1");
        yield* driver.checkpoints!.captureCheckpoint({ cwd, checkpointRef: from });
        yield* fs.writeFileString(path.join(cwd, "a file.txt"), "after\n");
        yield* fs.writeFileString(path.join(repo, "sibling.txt"), "sibling edit\n");
        yield* driver.checkpoints!.captureCheckpoint({ cwd, checkpointRef: to });
        const summary = yield* driver.checkpoints!.diffCheckpoints({
          cwd,
          fromCheckpointRef: from,
          toCheckpointRef: to,
          ignoreWhitespace: false,
          format: "numstat",
        });
        assert.deepStrictEqual(parseTurnDiffFilesFromNumstat(summary), [
          { path: "thread/a file.txt", additions: 1, deletions: 1 },
        ]);
        assert.isTrue(yield* driver.checkpoints!.restoreCheckpoint({ cwd, checkpointRef: from }));
        assert.equal(yield* fs.readFileString(path.join(cwd, "a file.txt")), "before\n");
        assert.equal(yield* fs.readFileString(path.join(repo, "sibling.txt")), "sibling edit\n");
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect(
    "retains checkpoint objects and refuses a shadowed, unindexed revision after pruning",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-checkpoint-gc-" });
          yield* runJj(root, ["git", "init", "--no-colocate"]);
          const driver = yield* JjVcsDriver.makeVcsDriverShape();
          const from = CheckpointRef.make("refs/t3/checkpoints/gc/0");
          const to = CheckpointRef.make("refs/t3/checkpoints/gc/1");
          yield* fs.writeFileString(path.join(root, "file.txt"), "before\n");
          yield* driver.checkpoints!.captureCheckpoint({ cwd: root, checkpointRef: from });
          yield* fs.writeFileString(path.join(root, "file.txt"), "after\n");
          yield* driver.checkpoints!.captureCheckpoint({ cwd: root, checkpointRef: to });
          const savedId = (yield* driver.readGitBackend({
            cwd: root,
            operation: "checkpoint shadow test",
            args: ["rev-parse", from],
          })).stdout.trim();
          yield* runJj(root, ["bookmark", "create", savedId, "-r", "@"]);
          assert.isTrue(
            yield* driver.checkpoints!.restoreCheckpoint({ cwd: root, checkpointRef: from }),
          );
          assert.equal(yield* fs.readFileString(path.join(root, "file.txt")), "before\n");
          assert.isTrue(
            yield* driver.checkpoints!.restoreCheckpoint({ cwd: root, checkpointRef: to }),
          );
          yield* runJj(root, ["op", "abandon", "..@-"]);
          yield* runJj(root, ["debug", "reindex"]);
          yield* runJj(root, ["util", "gc", "--expire", "now"]);
          assert.isTrue(
            yield* driver.checkpoints!.hasCheckpointRef({ cwd: root, checkpointRef: from }),
          );
          assert.deepEqual(
            parseTurnDiffFilesFromNumstat(
              yield* driver.checkpoints!.diffCheckpoints({
                cwd: root,
                fromCheckpointRef: from,
                toCheckpointRef: to,
                ignoreWhitespace: false,
                format: "numstat",
              }),
            ),
            [{ path: "file.txt", additions: 1, deletions: 1 }],
          );
          const error = yield* driver
            .checkpoints!.restoreCheckpoint({ cwd: root, checkpointRef: from })
            .pipe(Effect.flip);
          assert.include(error.message, "cannot resolve this retained checkpoint");
          assert.equal(yield* fs.readFileString(path.join(root, "file.txt")), "after\n");
        }),
      ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("detaches metadata before deleting files so refresh cannot rewrite the bookmark", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-delete-race-" });
        const repo = path.join(root, "repo");
        const workspace = path.join(root, "workspace");
        yield* runJj(root, ["git", "init", "--no-colocate", repo]);
        yield* fs.writeFileString(path.join(repo, "file.txt"), "keep\n");
        yield* runJj(repo, ["commit", "-m", "initial"]);
        let refreshAttempted = false;
        const driver = yield* JjVcsDriver.makeVcsDriverShape().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            remove: (target, options) =>
              target === workspace
                ? Effect.gen(function* () {
                    assert.isFalse(yield* fs.exists(path.join(workspace, ".jj")));
                    yield* fs.remove(path.join(workspace, "file.txt"));
                    assert.equal(
                      (yield* runJj(workspace, [
                        "log",
                        "-r",
                        "@",
                        "--no-graph",
                        "-T",
                        "commit_id",
                      ]).pipe(Effect.exit))._tag,
                      "Failure",
                    );
                    refreshAttempted = true;
                    yield* fs.remove(target, options);
                  })
                : fs.remove(target, options),
          }),
        );
        yield* driver.createWorktree({
          cwd: repo,
          refName: "@-",
          newRefName: "review/delete",
          path: workspace,
        });
        const before = (yield* driver.listBookmarks(repo)).find(
          (bookmark) => bookmark.name === "review/delete" && bookmark.remoteName === null,
        )?.target;
        assert.isString(before);
        yield* driver.removeWorktree({ cwd: repo, path: workspace });
        assert.isTrue(refreshAttempted);
        assert.equal(
          (yield* driver.listBookmarks(repo)).find(
            (bookmark) => bookmark.name === "review/delete" && bookmark.remoteName === null,
          )?.target,
          before,
        );
        yield* driver.removeWorktree({ cwd: repo, path: workspace });
        const collision = path.join(root, "collision");
        assert.equal(
          (yield* driver
            .createWorktree({
              cwd: repo,
              refName: "@-",
              newRefName: "review/delete",
              path: collision,
            })
            .pipe(Effect.exit))._tag,
          "Failure",
        );
        assert.isFalse(yield* fs.exists(collision));
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect(
    "protects unrelated directories, the primary repository, and ignored workspace files",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-removal-" });
          const repo = path.join(root, "repo");
          const workspace = path.join(root, "workspace");
          const unrelated = path.join(root, "unrelated");
          yield* runJj(root, ["git", "init", "--no-colocate", repo]);
          yield* fs.writeFileString(path.join(repo, ".gitignore"), "local.bin\n");
          yield* runJj(repo, ["commit", "-m", "ignore local data"]);
          const driver = yield* JjVcsDriver.makeVcsDriverShape();
          yield* driver.createWorktree({ cwd: repo, refName: "@-", path: workspace });
          yield* fs.makeDirectory(unrelated);
          yield* fs.writeFileString(path.join(unrelated, "keep.txt"), "keep\n");
          assert.isTrue(
            (yield* Effect.exit(driver.removeWorktree({ cwd: repo, path: unrelated, force: true })))
              ._tag === "Failure",
          );
          assert.isTrue(
            (yield* Effect.exit(driver.removeWorktree({ cwd: repo, path: repo, force: true })))
              ._tag === "Failure",
          );
          assert.isFalse(yield* driver.hasUntrackedFiles(workspace));
          yield* fs.writeFileString(path.join(workspace, "local.bin"), "ignored\n");
          assert.isTrue(yield* driver.hasUntrackedFiles(workspace));
          assert.isTrue(
            (yield* Effect.exit(driver.removeWorktree({ cwd: repo, path: workspace })))._tag ===
              "Failure",
          );
          assert.isTrue(yield* fs.exists(path.join(workspace, "local.bin")));
          assert.isTrue(yield* fs.exists(path.join(unrelated, "keep.txt")));
          yield* driver.removeWorktree({ cwd: repo, path: workspace, force: true });
          assert.isFalse(yield* fs.exists(workspace));
          assert.isTrue(yield* fs.exists(repo));
          yield* driver.createWorktree({ cwd: repo, refName: "@-", path: workspace });
          yield* fs.remove(workspace, { recursive: true });
          const other = path.join(root, "other");
          yield* runJj(root, ["git", "init", "--no-colocate", other]);
          yield* driver.createWorktree({ cwd: other, refName: "@", path: workspace });
          yield* fs.writeFileString(path.join(workspace, "belongs-to-other.txt"), "keep\n");
          assert.equal(
            (yield* Effect.exit(driver.validateWorktreePath({ cwd: repo, path: workspace })))._tag,
            "Failure",
          );
          assert.equal(
            (yield* Effect.exit(driver.removeWorktree({ cwd: repo, path: workspace, force: true })))
              ._tag,
            "Failure",
          );
          assert.equal(
            yield* fs.readFileString(path.join(workspace, "belongs-to-other.txt")),
            "keep\n",
          );
        }),
      ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("isolates workspace bases and recovers a missing workspace's snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-recover-" });
        const repo = path.join(root, "repo");
        const workspace = path.join(root, "workspace");
        yield* runJj(root, ["git", "init", "--no-colocate", repo]);
        yield* fs.writeFileString(path.join(repo, "base.txt"), "base\n");
        yield* runJj(repo, ["commit", "-m", "base"]);
        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        yield* driver.createWorktree({
          cwd: repo,
          refName: "@",
          newRefName: "feature/recover",
          path: workspace,
        });
        yield* fs.writeFileString(path.join(repo, "root-only.txt"), "root\n");
        yield* driver.currentChange(repo);
        assert.isFalse(yield* fs.exists(path.join(workspace, "root-only.txt")));
        yield* fs.writeFileString(path.join(workspace, "saved.txt"), "saved\n");
        const saved = yield* driver.currentChange(workspace);
        yield* fs.remove(workspace, { recursive: true });
        yield* driver.recoverWorktree({ cwd: repo, path: workspace, refName: "feature/recover" });
        assert.equal(yield* fs.readFileString(path.join(workspace, "saved.txt")), "saved\n");
        assert.equal((yield* driver.currentChange(workspace))?.changeId, saved?.changeId);
        assert.isTrue((yield* driver.localStatus(workspace)).hasWorkingTreeChanges);
        assert.isFalse(
          (yield* driver.listRefs({ cwd: repo })).refs.some((ref) => ref.kind === "workspace"),
        );
        assert.isTrue(
          (yield* driver.listRefs({ cwd: repo, includeWorkspaces: true })).refs.some(
            (ref) => ref.kind === "workspace" && ref.worktreePath === workspace,
          ),
        );
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("resumes a clean bookmarked workspace after automatic removal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-cleanup-resume-" });
        const repo = path.join(root, "repo");
        const workspace = path.join(root, "workspace");
        yield* runJj(root, ["git", "init", "--no-colocate", repo]);
        yield* fs.writeFileString(path.join(repo, "base.txt"), "base\n");
        yield* runJj(repo, ["commit", "-m", "base"]);
        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        yield* driver.createWorktree({
          cwd: repo,
          refName: "@-",
          newRefName: "feature/resume",
          path: workspace,
        });
        const original = yield* driver.currentChange(workspace);
        yield* driver.removeWorktree({ cwd: repo, path: workspace, force: false });
        yield* driver.recoverWorktree({ cwd: repo, path: workspace, refName: "feature/resume" });
        assert.equal((yield* driver.currentChange(workspace))?.changeId, original?.changeId);
        assert.equal(yield* fs.readFileString(path.join(workspace, "base.txt")), "base\n");
        assert.isFalse((yield* driver.localStatus(workspace)).hasWorkingTreeChanges);
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("never falls back to Git when JJ metadata exists but its executable is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-missing-cli-" });
        yield* runJj(root, ["git", "init", "--colocate"]);
        const process = yield* VcsProcess;
        const driver = yield* JjVcsDriver.makeVcsDriverShape().pipe(
          Effect.provideService(VcsProcess, {
            run: (input) => process.run({ ...input, command: path.join(root, "missing-jj") }),
          }),
        );
        assert.equal((yield* Effect.exit(driver.detectRepository(root)))._tag, "Failure");
        assert.equal((yield* Effect.exit(driver.isInsideWorkTree(root)))._tag, "Failure");
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("detects repository identity with jj root", () => {
    const calls: VcsProcessInput[] = [];

    return Effect.gen(function* () {
      const driver = yield* JjVcsDriver.makeVcsDriverShape();
      const identity = yield* driver.detectRepository("/repo/src");

      assert.equal(identity?.kind, "jj");
      assert.equal(identity?.rootPath, "/repo");
      assert.equal(identity?.metadataPath, "/repo/.jj");
      assert.deepStrictEqual(commandCalls(calls), [["jj", "--no-pager", "root"]]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return processOutput("/repo\n");
              }),
          }),
          NodeServices.layer,
        ),
      ),
    );
  });

  it.effect("lists workspace files using jj file list", () => {
    let observedInput: VcsProcessInput | null = null;

    return Effect.gen(function* () {
      const driver = yield* JjVcsDriver.makeVcsDriverShape();
      const result = yield* driver.listWorkspaceFiles("/repo");

      assert.deepStrictEqual(result.paths, ["README.md", "src/index.ts"]);
      assert.deepStrictEqual(observedInput?.args, [
        "--no-pager",
        "file",
        "list",
        "-T",
        'path ++ "\\0"',
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                observedInput = input;
                return processOutput("README.md\nsrc/index.ts\n");
              }),
          }),
          NodeServices.layer,
        ),
      ),
    );
  });

  it.effect("returns working-tree and branch-range review diffs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-review-" });
        const repo = path.join(root, "repo");
        yield* runJj(root, ["git", "init", "--colocate", repo]);
        yield* runJj(repo, ["bookmark", "create", "main"]);
        yield* fileSystem.writeFileString(path.join(repo, "a.txt"), "hello\n");
        yield* runJj(repo, ["new"]);
        yield* fileSystem.writeFileString(path.join(repo, "a.txt"), "hello world\n");
        yield* fileSystem.writeFileString(path.join(repo, "b.txt"), "new file\n");

        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        const preview = yield* driver.getDiffPreview!({ cwd: repo });

        assert.equal(preview.cwd, repo);
        assert.equal(preview.sources.length, 2);
        const workingTree = preview.sources.find((source) => source.kind === "working-tree");
        const branchRange = preview.sources.find((source) => source.kind === "branch-range");
        assert.equal(workingTree?.title, "Dirty worktree");
        assert.equal(workingTree?.baseRef, "@-");
        assert.equal(workingTree?.headRef, "@");
        assert.include(workingTree?.diff ?? "", "b.txt");
        assert.include(workingTree?.diff ?? "", "+hello world");
        assert.equal(branchRange?.title, "Against main");
        assert.equal(branchRange?.baseRef, "main");
        assert.include(branchRange?.diff ?? "", "a.txt");
        assert.include(branchRange?.diff ?? "", "b.txt");
        for (const source of preview.sources) {
          assert.match(source.diffHash, /^[0-9a-f]{64}$/);
          assert.isFalse(source.truncated);
        }
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("honors an explicit baseRef for review diff preview", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-review-base-" });
        const repo = path.join(root, "repo");
        yield* runJj(root, ["git", "init", "--colocate", repo]);
        yield* fileSystem.writeFileString(path.join(repo, "a.txt"), "hello\n");

        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        const preview = yield* driver.getDiffPreview!({ cwd: repo, baseRef: "@-" });

        const branchRange = preview.sources.find((source) => source.kind === "branch-range");
        assert.equal(branchRange?.title, "Against @-");
        assert.equal(branchRange?.baseRef, "@-");
        assert.include(branchRange?.diff ?? "", "a.txt");
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("returns empty review sources outside a repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const plain = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-review-plain-" });

        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        const preview = yield* driver.getDiffPreview!({ cwd: plain });

        assert.equal(preview.cwd, plain);
        assert.deepStrictEqual(preview.sources, []);
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("expands working-tree review file contents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-review-files-" });
        const repo = path.join(root, "repo");
        yield* runJj(root, ["git", "init", "--colocate", repo]);
        yield* fileSystem.writeFileString(path.join(repo, "a.txt"), "hello\n");
        yield* fileSystem.writeFileString(path.join(repo, "gone.txt"), "gone\n");
        yield* runJj(repo, ["new"]);
        yield* fileSystem.writeFileString(path.join(repo, "a.txt"), "hello world\n");
        yield* fileSystem.writeFileString(path.join(repo, "b.txt"), "new file\n");
        yield* fileSystem.remove(path.join(repo, "gone.txt"));

        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        const changed = yield* driver.getDiffFileContents!({
          cwd: repo,
          sourceKind: "working-tree",
          changeType: "change",
          baseRef: "@-",
          headRef: "@",
          oldPath: "a.txt",
          newPath: "a.txt",
        });
        assert.equal(changed.oldContents, "hello\n");
        assert.equal(changed.newContents, "hello world\n");

        const added = yield* driver.getDiffFileContents!({
          cwd: repo,
          sourceKind: "working-tree",
          changeType: "new",
          baseRef: "@-",
          headRef: "@",
          oldPath: "b.txt",
          newPath: "b.txt",
        });
        assert.equal(added.oldContents, "");
        assert.equal(added.newContents, "new file\n");

        const deleted = yield* driver.getDiffFileContents!({
          cwd: repo,
          sourceKind: "working-tree",
          changeType: "deleted",
          baseRef: "@-",
          headRef: "@",
          oldPath: "gone.txt",
          newPath: "gone.txt",
        });
        assert.equal(deleted.oldContents, "gone\n");
        assert.equal(deleted.newContents, "");
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("expands branch-range review file contents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-jj-review-range-",
        });
        const repo = path.join(root, "repo");
        yield* runJj(root, ["git", "init", "--colocate", repo]);
        yield* fileSystem.writeFileString(path.join(repo, "a.txt"), "hello\n");
        yield* runJj(repo, ["bookmark", "create", "main"]);
        yield* runJj(repo, ["new"]);
        yield* fileSystem.writeFileString(path.join(repo, "a.txt"), "hello world\n");

        const driver = yield* JjVcsDriver.makeVcsDriverShape();
        const contents = yield* driver.getDiffFileContents!({
          cwd: repo,
          sourceKind: "branch-range",
          changeType: "change",
          baseRef: "main",
          headRef: "@",
          oldPath: "a.txt",
          newPath: "a.txt",
        });
        assert.equal(contents.oldContents, "hello\n");
        assert.equal(contents.newContents, "hello world\n");

        const error = yield* driver.getDiffFileContents!({
          cwd: repo,
          sourceKind: "branch-range",
          changeType: "change",
          baseRef: null,
          headRef: "@",
          oldPath: "a.txt",
          newPath: "a.txt",
        }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsProcessExitError");
      }),
    ).pipe(Effect.provide(JjContractLayer)),
  );

  it.effect("filters paths with the git ignore oracle", () => {
    const calls: VcsProcessInput[] = [];

    return Effect.gen(function* () {
      const driver = yield* JjVcsDriver.makeVcsDriverShape();
      const result = yield* driver.filterIgnoredPaths("/repo", [
        "keep.ts",
        "debug.log",
        "src/index.ts",
      ]);

      assert.deepStrictEqual(result, ["keep.ts", "src/index.ts"]);
      assert.equal(calls[0]?.command, "git");
      assert.deepStrictEqual(calls[0]?.args.slice(-2), ["init", "--bare"]);
      assert.equal(calls[1]?.command, "git");
      assert.deepStrictEqual(calls[1]?.args.slice(-4), [
        "check-ignore",
        "--no-index",
        "-z",
        "--stdin",
      ]);
      assert.equal(calls[1]?.stdin, "keep.ts\0debug.log\0src/index.ts\0");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                calls.push(input);
                if (input.command === "git" && input.args.includes("check-ignore")) {
                  return processOutput("debug.log\0");
                }
                return processOutput("");
              }),
          }),
          NodeServices.layer,
        ),
      ),
    );
  });

  it.effect("forwards execute env to the VCS process", () => {
    let observedEnv: NodeJS.ProcessEnv | undefined;

    return Effect.gen(function* () {
      const driver = yield* JjVcsDriver.makeVcsDriverShape();

      yield* driver.execute({
        operation: "JjVcsDriver.test.env",
        cwd: "/repo",
        args: ["status"],
        env: {
          JJ_CONFIG: "/tmp/t3-jj-config.toml",
        },
      });

      assert.deepStrictEqual(observedEnv, {
        JJ_CONFIG: "/tmp/t3-jj-config.toml",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                observedEnv = input.env;
                return processOutput("");
              }),
          }),
          NodeServices.layer,
        ),
      ),
    );
  });
});
