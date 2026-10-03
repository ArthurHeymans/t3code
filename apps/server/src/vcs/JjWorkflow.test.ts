import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import type { VcsWorkflow } from "./VcsWorkflow.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { jjFile } from "./jjExpressions.ts";

const layer = NodeServices.layer.pipe(
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
  const adapter = jj.workflow;
  return { root, cwd, fs, path, jj, adapter };
});

const record = (
  workflow: VcsWorkflow,
  cwd: string,
  subject: string,
  options?: { refName?: string; filePaths?: readonly string[]; allowDefaultRef?: boolean },
) =>
  workflow.recordCommit({
    cwd,
    subject,
    body: "",
    publicationRef: options?.refName ?? null,
    confirmedDefaultRef: options?.allowDefaultRef === true,
    ...(options?.filePaths ? { paths: options.filePaths } : {}),
  });

describe("Native Jujutsu workflows", () => {
  it.effect("reads a PR base hint from the JJ Git backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, fs, path, adapter } = yield* fixture;
        assert.isNull(yield* adapter.prBaseRef(cwd, "feature/base-hint"));
        const config = path.join(cwd, ".jj", "repo", "store", "git", "config");
        const existing = yield* fs.readFileString(config);
        yield* fs.writeFileString(
          config,
          `${existing}\n[branch "feature/base-hint"]\n\tgh-merge-base = release/2026\n`,
        );
        assert.equal(yield* adapter.prBaseRef(cwd, "feature/base-hint"), "release/2026");
      }),
    ).pipe(Effect.provide(layer)),
  );
  it.effect("does not treat an unpublished or deleted remote bookmark as published", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, cwd, fs, path, jj, adapter } = yield* fixture;
        const remote = path.join(root, "remote.git");
        yield* command(root, ["init", "--bare", remote], "git");
        yield* command(cwd, ["git", "remote", "add", "origin", remote]);
        yield* fs.writeFileString(path.join(cwd, "feature.txt"), "local work\n");
        yield* jj.createRef({ cwd, refName: "feature/published" });
        yield* record(adapter, cwd, "feature", { refName: "feature/published" });
        assert.isFalse((yield* adapter.probePublication(cwd, "feature/published")).published);
        yield* adapter.publish(cwd, "feature/published");
        assert.isTrue((yield* adapter.probePublication(cwd, "feature/published")).published);
        yield* command(
          root,
          ["--git-dir", remote, "update-ref", "-d", "refs/heads/feature/published"],
          "git",
        );
        yield* adapter.refs.fetchRemote({ cwd, remoteName: "origin" });
        const deleted = yield* adapter.refContext(cwd, "feature/published");
        assert.isFalse((yield* adapter.probePublication(cwd, "feature/published")).published);
        assert.isNull(deleted.publication.remoteRef);
      }),
    ).pipe(Effect.provide(layer)),
  );
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
          assert.isNotNull(yield* adapter.prepareCommit(path.join(cwd, "dir"), [selected]));
          const result = yield* record(adapter, cwd, "selected files", {
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
        const result = yield* record(adapter, cwd, "rename", {
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
        const status = yield* adapter.state(workspace);
        assert.equal(status.publication?.name, "feature/empty");
        assert.equal(status.remote.aheadCount, 0);
        assert.equal(status.remote.aheadOfDefaultCount, 0);
        const error = yield* adapter.publish(workspace, "feature/empty").pipe(Effect.flip);
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
        yield* record(adapter, cwd, "first", { refName: "feature/fork" });
        yield* adapter.publish(cwd, "feature/fork", { remoteName: "fork" });
        assert.equal(
          (yield* adapter.refContext(cwd, "feature/fork")).publication.remoteName,
          "fork",
        );
        yield* fs.writeFileString(path.join(cwd, "feature.txt"), "two\n");
        const result = yield* record(adapter, cwd, "second", { refName: "feature/fork" });
        yield* adapter.publish(cwd, "feature/fork");
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
        const first = yield* record(adapter, cwd, "first", { refName: "feature/test" });
        yield* command(cwd, ["bookmark", "create", "unrelated", "-r", first.commitSha]);
        yield* adapter.publish(cwd, "feature/test");
        assert.equal(
          yield* command(
            root,
            ["--git-dir", remote, "rev-parse", "refs/heads/feature/test"],
            "git",
          ),
          first.commitSha,
        );
        yield* fs.writeFileString(path.join(cwd, "feature.txt"), "two\n");
        const second = yield* record(adapter, cwd, "second", { refName: "feature/test" });
        yield* adapter.publish(cwd, "feature/test");
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
        const details = (yield* adapter.state(cwd)).remote;
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
        const commit = yield* record(adapter, cwd, "first unbookmarked commit");
        yield* jj.createRef({ cwd, refName: "feature/recorded" });
        assert.equal(
          (yield* adapter.state(cwd, { localOnly: true })).publication?.name,
          "feature/recorded",
        );
        const remote = path.join(root, "recorded.git");
        yield* command(root, ["init", "--bare", remote], "git");
        yield* command(cwd, ["git", "remote", "add", "origin", remote]);
        yield* adapter.publish(cwd, "feature/recorded");
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
        const error = yield* record(adapter, cwd, "feature commit", {
          refName: "feature/alias",
        }).pipe(Effect.flip);
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
        const commit = yield* record(adapter, cwd, "explicit default commit", {
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
});
