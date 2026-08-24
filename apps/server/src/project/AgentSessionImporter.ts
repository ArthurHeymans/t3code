import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* scanner.recentThreads(input.workspaceRoot);
  let importedCount = 0;
  let skippedCount = 0;

  for (const thread of threads) {
    const imported = yield* Effect.gen(function* () {
      const threadId = ThreadId.make(
        `import:${thread.providerInstanceId}:${thread.providerSessionId}`,
      );
      const provider = ProviderDriverKind.make(thread.source);
      const model = thread.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
      const createCommandId = CommandId.make(yield* crypto.randomUUIDv4);

      yield* engine.dispatch({
        type: "thread.create",
        commandId: createCommandId,
        threadId,
        projectId: input.projectId,
        title: thread.title,
        modelSelection: { instanceId: thread.providerInstanceId, model },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: thread.createdAt,
      });

      yield* engine.dispatch({
        type: "thread.history.import",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId,
        messages: thread.messages.map((message, index) => ({
          messageId: MessageId.make(`${threadId}:${index}`),
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      });

      yield* directory.upsert({
        threadId,
        provider,
        providerInstanceId: thread.providerInstanceId,
        status: "stopped",
        runtimeMode: DEFAULT_RUNTIME_MODE,
        resumeCursor:
          thread.source === "codex"
            ? { threadId: thread.providerSessionId }
            : { threadId, resume: thread.providerSessionId },
        runtimePayload: { cwd: input.workspaceRoot },
      });

      return true;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not import an agent session", {
          provider: thread.source,
          sessionId: thread.providerSessionId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

    if (imported) importedCount += 1;
    else skippedCount += 1;
  }

  return { importedCount, skippedCount } satisfies AgentSessionImportResult;
});
