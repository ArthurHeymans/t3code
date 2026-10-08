import * as Schema from "effect/Schema";

// This is a separate opt-in catalog, not the client's storage document.
export const LocalConnectionMetadata = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  label: Schema.String.check(Schema.isMaxLength(500)),
  endpoint: Schema.String.check(Schema.isMaxLength(2048)),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export const LocalConnectionSecret = Schema.Struct({
  ...LocalConnectionMetadata.fields,
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384)),
});
export type LocalConnectionSecret = typeof LocalConnectionSecret.Type;
export const LocalConnectionsSnapshot = Schema.Struct({
  environments: Schema.Array(LocalConnectionMetadata).check(Schema.isMaxLength(64)),
});
export type LocalConnectionsSnapshot = typeof LocalConnectionsSnapshot.Type;
export const LocalConnectionsWrite = Schema.Struct({
  environments: Schema.Array(LocalConnectionSecret).check(Schema.isMaxLength(64)),
});
const LocalConnectionsRevision = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
);
export const LocalConnectionsEnable = Schema.Struct({
  ...LocalConnectionsWrite.fields,
  expectedRevision: LocalConnectionsRevision,
});
export const LocalConnectionsGrant = Schema.Struct({
  grantId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export const LocalConnectionsStatus = Schema.Struct({
  enabled: Schema.Boolean,
  grantId: Schema.NullOr(Schema.String),
  revision: LocalConnectionsRevision,
});
export const LocalConnectionsSync = Schema.Struct({
  ...LocalConnectionsWrite.fields,
  ...LocalConnectionsGrant.fields,
});
export class LocalConnectionsError extends Schema.TaggedError<LocalConnectionsError>()(
  "LocalConnectionsError",
  { message: Schema.String },
) {}

export function isLocalConnectionsEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
