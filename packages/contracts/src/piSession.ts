import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PiSessionSummary = Schema.Struct({
  sessionPath: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  name: Schema.NullOr(TrimmedNonEmptyString),
  firstUserText: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PiSessionSummary = typeof PiSessionSummary.Type;

export const PiSessionsListInput = Schema.Struct({
  limit: Schema.optional(PositiveInt),
});
export type PiSessionsListInput = typeof PiSessionsListInput.Type;

export const PiSessionsListResult = Schema.Struct({
  sessions: Schema.Array(PiSessionSummary),
});
export type PiSessionsListResult = typeof PiSessionsListResult.Type;

export const PiSessionAdoptInput = Schema.Struct({
  sessionPath: TrimmedNonEmptyString,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
});
export type PiSessionAdoptInput = typeof PiSessionAdoptInput.Type;

export const PiSessionAdoptResult = Schema.Struct({
  threadId: ThreadId,
});
export type PiSessionAdoptResult = typeof PiSessionAdoptResult.Type;

export class PiSessionError extends Schema.TaggedErrorClass<PiSessionError>()("PiSessionError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
