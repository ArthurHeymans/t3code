import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionDirectoryPersistenceError } from "../provider/Errors.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { importRecentAgentThreads } from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const makeThread = (source: "codex" | "claudeAgent"): AgentSessionScanner.AgentSessionThread => ({
  source,
  providerInstanceId: ProviderInstanceId.make(source),
  providerSessionId: source === "codex" ? "codex-session" : "claude-session",
  title: `Imported ${source} thread`,
  model: null,
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:01:00.000Z",
  messages: [
    { role: "user", text: "Fix the bug", createdAt: "2026-08-24T10:00:00.000Z" },
    { role: "assistant", text: "Fixed", createdAt: "2026-08-24T10:01:00.000Z" },
  ],
});

it.layer(NodeServices.layer)("AgentSessionImporter", (it) => {
  describe("importRecentAgentThreads", () => {
    it.effect("creates transcript history and stores provider-specific resume cursors", () =>
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        const bindings: Array<ProviderSessionDirectory.ProviderRuntimeBinding> = [];
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: () => Effect.succeed([makeThread("codex"), makeThread("claudeAgent")]),
        });
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({ sequence: commands.length });
          },
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        });
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: (binding) => {
            bindings.push(binding);
            return Effect.void;
          },
          getProvider: () => Effect.die("unused"),
          getBinding: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.die("unused"),
        });

        const result = yield* importRecentAgentThreads({
          projectId: ProjectId.make("project-1"),
          workspaceRoot: "/tmp/project",
        }).pipe(
          Effect.provideService(AgentSessionScanner.AgentSessionScanner, scanner),
          Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
          Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, directory),
        );

        expect(result).toEqual({ importedCount: 2, skippedCount: 0 });
        expect(commands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.history.import",
          "thread.create",
          "thread.history.import",
        ]);
        expect(bindings).toMatchObject([
          {
            provider: "codex",
            providerInstanceId: "codex",
            status: "stopped",
            resumeCursor: { threadId: "codex-session" },
          },
          {
            provider: "claudeAgent",
            providerInstanceId: "claudeAgent",
            status: "stopped",
            resumeCursor: {
              threadId: "import:claudeAgent:claude-session",
              resume: "claude-session",
            },
          },
        ]);
      }),
    );

    it.effect("skips a rejected session and continues importing later sessions", () =>
      Effect.gen(function* () {
        const bindings: Array<ProviderSessionDirectory.ProviderRuntimeBinding> = [];
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: () => Effect.succeed([makeThread("codex"), makeThread("claudeAgent")]),
        });
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: (command) =>
            command.type === "thread.create" && command.threadId.includes("codex-session")
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "The thread already exists.",
                  }),
                )
              : Effect.succeed({ sequence: 1 }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        });
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: (binding) => {
            bindings.push(binding);
            return Effect.void;
          },
          getProvider: () => Effect.die("unused"),
          getBinding: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.die("unused"),
        });

        const result = yield* importRecentAgentThreads({
          projectId: ProjectId.make("project-1"),
          workspaceRoot: "/tmp/project",
        }).pipe(
          Effect.provideService(AgentSessionScanner.AgentSessionScanner, scanner),
          Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
          Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, directory),
        );

        expect(result).toEqual({ importedCount: 1, skippedCount: 1 });
        expect(bindings[0]?.provider).toBe("claudeAgent");
      }),
    );

    it.effect("retries a partially imported session with the original command receipts", () =>
      Effect.gen(function* () {
        const acceptedCommandIds = new Set<string>();
        const bindings: Array<ProviderSessionDirectory.ProviderRuntimeBinding> = [];
        let threadCreated = false;
        let historyAttemptCount = 0;
        let bindingAttemptCount = 0;
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: () => Effect.succeed([makeThread("codex")]),
        });
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: (command) => {
            if (acceptedCommandIds.has(command.commandId)) {
              return Effect.succeed({ sequence: 1 });
            }
            if (command.type === "thread.create") {
              if (threadCreated) {
                return Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "The thread already exists.",
                  }),
                );
              }
              threadCreated = true;
              acceptedCommandIds.add(command.commandId);
              return Effect.succeed({ sequence: 1 });
            }
            historyAttemptCount += 1;
            if (historyAttemptCount === 1) {
              return Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Temporary history import failure.",
                }),
              );
            }
            acceptedCommandIds.add(command.commandId);
            return Effect.succeed({ sequence: 2 });
          },
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        });
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: (binding) => {
            bindingAttemptCount += 1;
            if (bindingAttemptCount === 1) {
              return Effect.fail(
                new ProviderSessionDirectoryPersistenceError({
                  operation: "upsert",
                  detail: "Temporary session storage failure.",
                }),
              );
            }
            bindings.push(binding);
            return Effect.void;
          },
          getProvider: () => Effect.die("unused"),
          getBinding: () => Effect.die("unused"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.die("unused"),
        });
        const runImport = () =>
          importRecentAgentThreads({
            projectId: ProjectId.make("project-1"),
            workspaceRoot: "/tmp/project",
          }).pipe(
            Effect.provideService(AgentSessionScanner.AgentSessionScanner, scanner),
            Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
            Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, directory),
          );

        expect(yield* runImport()).toEqual({ importedCount: 0, skippedCount: 1 });
        expect(yield* runImport()).toEqual({ importedCount: 0, skippedCount: 1 });
        expect(yield* runImport()).toEqual({ importedCount: 1, skippedCount: 0 });
        expect(bindings).toHaveLength(1);
        expect(historyAttemptCount).toBe(2);
      }),
    );
  });
});
