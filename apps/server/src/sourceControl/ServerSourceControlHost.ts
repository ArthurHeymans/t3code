import { GitCommandError } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export const layer = Layer.effect(
  SourceControlHost.SourceControlHost,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const process = yield* VcsProcess.VcsProcess;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const failure = (cwd: string, detail: string, cause?: unknown) =>
      new GitCommandError({
        cwd,
        operation: "SourceControlHost.route",
        command: "vcs-route",
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const route = <A>(
      cwd: string,
      onGit: Effect.Effect<A, GitCommandError>,
      onJj: (handle: VcsDriverRegistry.VcsDriverHandle) => Effect.Effect<A, GitCommandError>,
    ) =>
      vcsRegistry.detect({ cwd }).pipe(
        Effect.mapError((cause) => failure(cwd, "Could not resolve the repository.", cause)),
        Effect.flatMap((handle) => (handle?.kind === "jj" ? onJj(handle) : onGit)),
      );
    // Host checkout helpers may mutate Git history. Native review preparation owns JJ checkouts.
    const gitOnly = <A>(cwd: string, operation: Effect.Effect<A, GitCommandError>) =>
      route(cwd, operation, () =>
        Effect.fail(
          failure(
            cwd,
            "This hosting operation cannot mutate a Jujutsu workspace. Use its native workflow instead.",
          ),
        ),
      );
    const readBackend = (
      handle: VcsDriverRegistry.VcsDriverHandle,
      input: GitVcsDriver.ExecuteGitInput,
    ) => {
      if (!handle.driver.readGitBackend)
        return Effect.fail(failure(input.cwd, "This repository has no read-only Git backend."));
      const { timeoutMs, ...options } = input;
      return handle.driver
        .readGitBackend({ ...options, ...(typeof timeoutMs === "number" ? { timeoutMs } : {}) })
        .pipe(
          Effect.mapError((cause) =>
            failure(input.cwd, "Could not read the Jujutsu Git backend.", cause),
          ),
        );
    };
    const execute = (input: GitVcsDriver.ExecuteGitInput) =>
      route(input.cwd, git.execute(input), (handle) => readBackend(handle, input));
    return SourceControlHost.SourceControlHost.of({
      settings: { get: serverSettings.getSettings },
      process: { run: process.run },
      git: {
        execute,
        resolveCommit: (input) =>
          route(input.cwd, git.resolveCommit(input), (handle) =>
            readBackend(handle, {
              cwd: input.cwd,
              operation: "SourceControlHost.resolveCommit",
              args: ["rev-parse", "--verify", `${input.revision}^{commit}`],
            }).pipe(Effect.map((result) => ({ commitSha: result.stdout.trim() }))),
          ),
        remotes: (cwd) =>
          vcsRegistry.resolve({ cwd }).pipe(Effect.map((handle) => handle.driver.listRemotes(cwd))),
        readConfigValue: (cwd, key) =>
          route(cwd, git.readConfigValue(cwd, key), (handle) =>
            readBackend(handle, {
              cwd,
              operation: "SourceControlHost.readConfigValue",
              args: ["config", "--get", key],
              allowNonZeroExit: true,
            }).pipe(
              Effect.flatMap((result) =>
                result.exitCode === 0
                  ? Effect.succeed(result.stdout.trim() || null)
                  : result.exitCode === 1
                    ? Effect.succeed(null)
                    : Effect.fail(failure(cwd, "Could not read the repository configuration.")),
              ),
            ),
          ),
        resolvePrimaryRemoteName: (cwd) =>
          route(cwd, git.resolvePrimaryRemoteName(cwd), (handle) =>
            handle.driver.workflow
              ? handle.driver.workflow.primaryRemote(cwd)
              : Effect.fail(failure(cwd, "This repository has no native workflow.")),
          ),
        listLocalBranchNames: (cwd) =>
          route(cwd, git.listLocalBranchNames(cwd), (handle) =>
            handle.driver.workflow
              ? handle.driver.workflow.refs.listLocalBranchNames(cwd)
              : Effect.fail(failure(cwd, "This repository has no native workflow.")),
          ),
        ensureRemote: (input) => gitOnly(input.cwd, git.ensureRemote(input)),
        fetchRemoteBranch: (input) => gitOnly(input.cwd, git.fetchRemoteBranch(input)),
        fetchRemoteTrackingBranch: (input) =>
          gitOnly(input.cwd, git.fetchRemoteTrackingBranch(input)),
        setBranchUpstream: (input) => gitOnly(input.cwd, git.setBranchUpstream(input)),
        switchRef: (input) => gitOnly(input.cwd, git.switchRef(input)),
      },
    });
  }),
);
