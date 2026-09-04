import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CheckpointRef, type VcsError } from "@t3tools/contracts";
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
            (workspace) => workspace.name === "feature-test" && workspace.path === workspacePath,
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
      assert.deepStrictEqual(observedInput?.args, ["--no-pager", "file", "list"]);
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
