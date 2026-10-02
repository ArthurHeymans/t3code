import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as Adapter from "./JjGitWorkflowAdapter.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { jjFile } from "./jjExpressions.ts";

const layer = Layer.mergeAll(NodeServices.layer, Layer.mock(GitVcsDriver.GitVcsDriver)({})).pipe(
  Layer.provideMerge(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
);
const command = (cwd: string, args: readonly string[], binary = "jj") =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return (yield* process.run({
      cwd,
      command: binary,
      args,
      operation: "JjGitWorkflowAdapter.test",
      timeoutMs: 10_000,
    })).stdout.trim();
  });
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-workflow-" });
  const cwd = path.join(root, "repo");
  yield* command(root, ["git", "init", "--no-colocate", cwd]);
  yield* command(cwd, ["config", "set", "--repo", "user.name", "Test"]);
  yield* command(cwd, ["config", "set", "--repo", "user.email", "test@example.com"]);
  yield* fs.writeFileString(path.join(cwd, "base.txt"), "base\n");
  yield* command(cwd, ["commit", "-m", "base"]);
  yield* command(cwd, ["bookmark", "create", "main", "-r", "@-"]);
  const jj = yield* JjVcsDriver.makeVcsDriverShape();
  const adapter = Adapter.make(jj, yield* GitVcsDriver.GitVcsDriver, () => Effect.succeed(true));
  return { root, cwd, fs, path, jj, adapter };
});

describe("Jujutsu workflow adapter", () => {
  it.effect(
    "commits only selected literal paths and advances the feature bookmark, not trunk",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { cwd, fs, path, jj, adapter } = yield* fixture;
          const selected = 'dir/file (a)|~".txt';
          yield* fs.makeDirectory(path.join(cwd, "dir"));
          yield* fs.writeFileString(path.join(cwd, selected), "selected\n");
          yield* fs.writeFileString(path.join(cwd, "remaining.txt"), "remaining\n");
          yield* jj.createRef({ cwd, refName: "feature/test" });
          const trunk = (yield* jj.listBookmarks(cwd)).find(
            (bookmark) => bookmark.name === "main",
          )?.target;
          assert.isNotNull(yield* adapter.prepareCommitContext(path.join(cwd, "dir"), [selected]));
          const result = yield* adapter.commit(cwd, "selected files", "", {
            refName: "feature/test",
            filePaths: [selected],
          });
          assert.equal(
            yield* command(cwd, ["file", "show", "-r", result.commitSha, "--", jjFile(selected)]),
            "selected",
          );
          assert.equal(yield* command(cwd, ["diff", "--name-only", "-r", "@"]), "remaining.txt");
          const bookmarks = yield* jj.listBookmarks(cwd);
          assert.equal(
            bookmarks.find((bookmark) => bookmark.name === "feature/test")?.target,
            result.commitSha,
          );
          assert.equal(bookmarks.find((bookmark) => bookmark.name === "main")?.target, trunk);
        }),
      ).pipe(Effect.provide(layer)),
  );

  it.effect("commits both sides of a selected rename while retaining other changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, fs, path, jj, adapter } = yield* fixture;
        yield* fs.rename(path.join(cwd, "base.txt"), path.join(cwd, "renamed.txt"));
        yield* fs.writeFileString(path.join(cwd, "remaining.txt"), "remaining\n");
        yield* jj.createRef({ cwd, refName: "feature/rename" });
        const result = yield* adapter.commit(cwd, "rename", "", {
          refName: "feature/rename",
          filePaths: ["renamed.txt"],
        });
        assert.equal(yield* command(cwd, ["file", "list", "-r", result.commitSha]), "renamed.txt");
        assert.equal(yield* command(cwd, ["diff", "--name-only", "-r", "@"]), "remaining.txt");
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("does not report an empty workspace change as a publishable commit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, cwd, path, jj, adapter } = yield* fixture;
        const remote = path.join(root, "remote.git");
        yield* command(root, ["init", "--bare", remote], "git");
        yield* command(cwd, ["git", "remote", "add", "origin", remote]);
        const workspace = path.join(root, "workspace");
        yield* jj.createWorktree({
          cwd,
          refName: "main",
          newRefName: "feature/empty",
          path: workspace,
        });
        const status = yield* adapter.statusDetails(workspace);
        assert.equal(status.branch, "feature/empty");
        assert.equal(status.aheadCount, 0);
        assert.equal(status.aheadOfDefaultCount, 0);
        const error = yield* adapter
          .pushCurrentBranch(workspace, "feature/empty")
          .pipe(Effect.flip);
        assert.include(error.message, "Commit or describe");
        assert.equal(
          yield* command(root, ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], "git"),
          "",
        );
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("publishes a tracked fork bookmark rather than selecting origin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, cwd, fs, path, jj, adapter } = yield* fixture;
        const origin = path.join(root, "origin.git"),
          fork = path.join(root, "fork.git");
        yield* command(root, ["init", "--bare", origin], "git");
        yield* command(root, ["init", "--bare", fork], "git");
        yield* command(cwd, ["git", "remote", "add", "origin", origin]);
        yield* command(cwd, ["git", "remote", "add", "fork", fork]);
        yield* fs.writeFileString(path.join(cwd, "feature.txt"), "one\n");
        yield* jj.createRef({ cwd, refName: "feature/fork" });
        yield* adapter.commit(cwd, "first", "", { refName: "feature/fork" });
        yield* adapter.pushCurrentBranch(cwd, "feature/fork", { remoteName: "fork" });
        assert.equal(yield* adapter.readConfigValue(cwd, "branch.feature/fork.remote"), "fork");
        yield* fs.writeFileString(path.join(cwd, "feature.txt"), "two\n");
        const result = yield* adapter.commit(cwd, "second", "", { refName: "feature/fork" });
        yield* adapter.pushCurrentBranch(cwd, "feature/fork");
        assert.equal(
          yield* command(root, ["--git-dir", fork, "rev-parse", "refs/heads/feature/fork"], "git"),
          result.commitSha,
        );
        assert.equal(
          yield* command(root, ["--git-dir", origin, "for-each-ref", "--format=%(refname)"], "git"),
          "",
        );
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("pushes exactly the selected bookmark to a bare remote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, cwd, fs, path, jj, adapter } = yield* fixture;
        const remote = path.join(root, "remote.git");
        yield* command(root, ["init", "--bare", remote], "git");
        yield* command(cwd, ["git", "remote", "add", "origin", remote]);
        yield* fs.writeFileString(path.join(cwd, "feature.txt"), "one\n");
        yield* jj.createRef({ cwd, refName: "feature/test" });
        const first = yield* adapter.commit(cwd, "first", "", { refName: "feature/test" });
        yield* command(cwd, ["bookmark", "create", "unrelated", "-r", first.commitSha]);
        yield* adapter.pushCurrentBranch(cwd, "feature/test");
        assert.equal(
          yield* command(
            root,
            ["--git-dir", remote, "rev-parse", "refs/heads/feature/test"],
            "git",
          ),
          first.commitSha,
        );
        yield* fs.writeFileString(path.join(cwd, "feature.txt"), "two\n");
        const second = yield* adapter.commit(cwd, "second", "", { refName: "feature/test" });
        yield* adapter.pushCurrentBranch(cwd, "feature/test");
        assert.equal(
          yield* command(
            root,
            ["--git-dir", remote, "rev-parse", "refs/heads/feature/test"],
            "git",
          ),
          second.commitSha,
        );
        assert.equal(
          yield* command(root, ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], "git"),
          "refs/heads/feature/test",
        );
        const details = yield* adapter.statusDetails(cwd);
        assert.equal(details.aheadCount, 0);
        assert.equal(details.behindCount, 0);
        assert.isTrue(details.hasUpstream);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("can publish a bookmark created after an unbookmarked commit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, cwd, fs, path, jj, adapter } = yield* fixture;
        yield* command(cwd, ["bookmark", "delete", "main"]);
        yield* fs.writeFileString(path.join(cwd, "first.txt"), "first\n");
        const commit = yield* adapter.commit(cwd, "first unbookmarked commit", "");
        yield* jj.createRef({ cwd, refName: "feature/recorded" });
        assert.equal((yield* adapter.statusDetails(cwd)).branch, "feature/recorded");
        const remote = path.join(root, "recorded.git");
        yield* command(root, ["init", "--bare", remote], "git");
        yield* command(cwd, ["git", "remote", "add", "origin", remote]);
        yield* adapter.pushCurrentBranch(cwd, "feature/recorded");
        assert.equal(
          yield* command(
            root,
            ["--git-dir", remote, "rev-parse", "refs/heads/feature/recorded"],
            "git",
          ),
          commit.commitSha,
        );
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("does not rewrite trunk through an alias of its working-copy change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, fs, path, jj, adapter } = yield* fixture;
        yield* fs.writeFileString(path.join(cwd, "pending.txt"), "pending\n");
        yield* command(cwd, ["bookmark", "move", "main", "--to", "@"]);
        const before = yield* jj.currentChange(cwd);
        assert.equal(
          (yield* Effect.exit(jj.createRef({ cwd, refName: "feature/new" })))._tag,
          "Failure",
        );
        yield* command(cwd, ["bookmark", "create", "feature/alias"]);
        const error = yield* adapter
          .commit(cwd, "feature commit", "", { refName: "feature/alias" })
          .pipe(Effect.flip);
        assert.include(error.message, "separate feature change");
        assert.equal(
          (yield* jj.listBookmarks(cwd)).find(
            (bookmark) => bookmark.name === "main" && bookmark.remoteName === null,
          )?.target,
          before?.commitId,
        );
        assert.isTrue((yield* jj.localStatus(cwd)).hasWorkingTreeChanges);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("allows an explicitly confirmed commit to the default bookmark", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, fs, path, jj, adapter } = yield* fixture;
        yield* fs.writeFileString(path.join(cwd, "pending.txt"), "pending\n");
        const commit = yield* adapter.commit(cwd, "explicit default commit", "", {
          refName: "main",
          allowDefaultRef: true,
        });
        assert.equal(
          (yield* jj.listBookmarks(cwd)).find(
            (bookmark) => bookmark.name === "main" && bookmark.remoteName === null,
          )?.target,
          commit.commitSha,
        );
        assert.isFalse((yield* jj.localStatus(cwd)).hasWorkingTreeChanges);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("refuses unimplemented Git mutations instead of falling through", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, adapter } = yield* fixture;
        const error = yield* adapter
          .refreshCheckedOutBranch({ cwd, targetCommit: "main" })
          .pipe(Effect.flip);
        assert.include(error.message, "no Jujutsu implementation");
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("honors the routing seam when a colocated project selects Git", () => {
    const original = vi.fn(() => Effect.succeed({ commitSha: "git-commit" }));
    return Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const adapter = Adapter.make(
        yield* JjVcsDriver.makeVcsDriverShape(),
        { ...git, commit: original },
        () => Effect.succeed(false),
      );
      assert.equal((yield* adapter.commit("/repo", "subject", "")).commitSha, "git-commit");
      assert.equal(original.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  });
});
