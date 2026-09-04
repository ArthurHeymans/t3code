import {
  EventId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { readPiSessionTranscript } from "../provider/PiSessions.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

const EVENT_BATCH_SIZE = 200;
const ENTITY_PREFIX = "pi-session-transcript";
// v2 repairs the initial importer, which truncated array-backed Pi message content.
const EVENT_PREFIX = "pi-session-transcript-v2";

export interface PiSessionTranscriptImportSummary {
  readonly importedMessageCount: number;
}

export class PiSessionTranscriptImportError extends Schema.TaggedErrorClass<PiSessionTranscriptImportError>()(
  "PiSessionTranscriptImportError",
  {
    threadId: ThreadId,
    sessionPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to import the Pi transcript for thread '${this.threadId}'.`;
  }
}

export interface PiSessionTranscriptImporterShape {
  readonly importTranscript: (input: {
    readonly threadId: ThreadId;
    readonly sessionPath: string;
  }) => Effect.Effect<PiSessionTranscriptImportSummary, PiSessionTranscriptImportError>;
}

export class PiSessionTranscriptImporter extends Context.Service<
  PiSessionTranscriptImporter,
  PiSessionTranscriptImporterShape
>()("t3/orchestration-v2/PiSessionTranscriptImporter") {}

function chunks<A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> {
  const result: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function messageIds(threadId: ThreadId, entryId: string) {
  const identity = `${encodeURIComponent(threadId)}:${encodeURIComponent(entryId)}`;
  return {
    messageId: MessageId.make(`${ENTITY_PREFIX}:message:${identity}`),
    turnItemId: TurnItemId.make(`${ENTITY_PREFIX}:turn-item:${identity}`),
    messageEventId: EventId.make(`${EVENT_PREFIX}:message:${identity}`),
    turnItemEventId: EventId.make(`${EVENT_PREFIX}:turn-item:${identity}`),
  };
}

function messageEvents(input: {
  readonly threadId: ThreadId;
  readonly entryId: string;
  readonly role: "user" | "assistant" | "custom";
  readonly text: string;
  readonly customType?: string;
  readonly createdAt: string;
  readonly ordinal: number;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ids = messageIds(input.threadId, input.entryId);
  const createdAt = DateTime.makeUnsafe(input.createdAt);
  const baseTurnItem = {
    id: ids.turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: input.role === "custom" ? (input.customType ?? "notification") : null,
    startedAt: createdAt,
    completedAt: createdAt,
    updatedAt: createdAt,
  };
  if (input.role === "custom") {
    return [
      {
        id: ids.turnItemEventId,
        type: "turn-item.updated",
        threadId: input.threadId,
        occurredAt: createdAt,
        payload: {
          ...baseTurnItem,
          type: "dynamic_tool",
          toolName: input.customType ?? "notification",
          input: {},
          output: input.text,
        },
      },
    ];
  }
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: ids.messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.role,
    text: input.text,
    attachments: [],
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.role === "user"
      ? {
          ...baseTurnItem,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId: ids.messageId,
          inputIntent: "turn_start",
          text: input.text,
          attachments: [],
        }
      : {
          ...baseTurnItem,
          type: "assistant_message",
          messageId: ids.messageId,
          text: input.text,
          streaming: false,
        };
  return [
    {
      id: ids.messageEventId,
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: createdAt,
      payload: message,
    },
    {
      id: ids.turnItemEventId,
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: createdAt,
      payload: turnItem,
    },
  ];
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSinkV2;
  const imports = yield* makeKeyedSerialExecutor<ThreadId>();

  const importTranscript = (input: { readonly threadId: ThreadId; readonly sessionPath: string }) =>
    imports.withLock(
      input.threadId,
      Effect.gen(function* () {
        const messages = yield* Effect.tryPromise({
          try: () => readPiSessionTranscript(input.sessionPath),
          catch: (cause) =>
            new PiSessionTranscriptImportError({
              threadId: input.threadId,
              sessionPath: input.sessionPath,
              cause,
            }),
        });
        const existingRows = yield* sql<{ readonly event_id: string }>`
          SELECT event_id
          FROM orchestration_events
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${input.threadId}
        `;
        const existing = new Set(existingRows.map((row) => row.event_id));
        const missing = messages.filter((message) => {
          const ids = messageIds(input.threadId, message.entryId);
          return !existing.has(
            message.role === "custom" ? ids.turnItemEventId : ids.messageEventId,
          );
        });
        for (const batch of chunks(missing, EVENT_BATCH_SIZE / 2)) {
          yield* Effect.forEach(
            batch,
            (message) => {
              const ids = messageIds(input.threadId, message.entryId);
              return sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${input.threadId},
                  ${ids.turnItemId},
                  ${message.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO NOTHING
              `;
            },
            { discard: true },
          );
          yield* eventSink.write({
            events: batch.flatMap((message) =>
              messageEvents({ ...message, threadId: input.threadId }),
            ),
          });
          yield* Effect.yieldNow;
        }
        return { importedMessageCount: missing.length };
      }).pipe(
        Effect.mapError((cause) =>
          cause._tag === "PiSessionTranscriptImportError"
            ? cause
            : new PiSessionTranscriptImportError({
                threadId: input.threadId,
                sessionPath: input.sessionPath,
                cause,
              }),
        ),
      ),
    );

  return PiSessionTranscriptImporter.of({ importTranscript });
});

export const layer: Layer.Layer<
  PiSessionTranscriptImporter,
  never,
  EventSinkV2 | SqlClient.SqlClient
> = Layer.effect(PiSessionTranscriptImporter, make);
