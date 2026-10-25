import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { Effect, FileSystem, Layer, Path } from "effect";

import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

it.effect.each([false, true])(
  "reads hosting metadata without Git mutations (colocated: %s)",
  (colocated) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-host-" });
      const cwd = path.join(root, "repo");
      const jj = yield* JjVcsDriver.makeVcsDriverShape();
      const run = (directory: string, args: readonly string[]) =>
        jj.execute({ cwd: directory, args, operation: "test.setup" });
      yield* run(root, ["git", "init", colocated ? "--colocate" : "--no-colocate", cwd]);
      yield* run(cwd, ["config", "set", "--repo", "user.name", "Test"]);
      yield* run(cwd, ["config", "set", "--repo", "user.email", "test@example.com"]);
      yield* fs.writeFileString(path.join(cwd, "base.txt"), "hosting metadata\n");
      yield* run(cwd, ["commit", "-m", "base"]);
      const commit = (yield* run(cwd, [
        "log",
        "-r",
        "@-",
        "--no-graph",
        "-T",
        "commit_id",
      ])).stdout.trim();
      const repository = yield* jj.detectRepository(cwd);
      if (repository === null) throw new Error("Expected a Jujutsu repository");
      const handle = { kind: "jj" as const, repository, driver: jj };
      const host = yield* SourceControlHost.SourceControlHost.pipe(
        Effect.provide(
          ServerSourceControlHost.layer.pipe(
            Layer.provide(Layer.mock(ServerSettings.ServerSettingsService)({})),
            Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
            Layer.provide(
              Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
                detect: () => Effect.succeed(handle),
                resolve: () => Effect.succeed(handle),
              }),
            ),
          ),
        ),
      );
      assert.equal((yield* host.git.resolveCommit({ cwd, revision: commit })).commitSha, commit);
      assert.equal(
        (yield* host.git.execute({
          cwd,
          operation: "test.template",
          args: ["show", `${commit}:base.txt`],
        })).stdout,
        "hosting metadata\n",
      );
      assert.isNull(yield* host.git.readConfigValue(cwd, "t3.missing"));
      assert.equal(
        (yield* Effect.flip(
          host.git.execute({ cwd, operation: "test.refuseCheckout", args: ["checkout", "HEAD"] }),
        ))._tag,
        "GitCommandError",
      );
      assert.equal(
        (yield* Effect.flip(host.git.switchRef({ cwd, refName: "main" })))._tag,
        "GitCommandError",
      );
      assert.equal(yield* fs.readFileString(path.join(cwd, "base.txt")), "hosting metadata\n");
      assert.equal(yield* fs.exists(path.join(cwd, ".git")), colocated);
    }).pipe(
      Effect.scoped,
      Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);
