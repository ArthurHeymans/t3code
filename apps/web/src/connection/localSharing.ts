import type { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import {
  isLocalConnectionsEndpoint,
  LocalConnectionsGrant,
  LocalConnectionsStatus,
  type LocalConnectionSecret,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

export function sharedBearerEntries(
  document: ConnectionCatalogDocument,
  primaryEndpoint: string,
): ReadonlyArray<LocalConnectionSecret> {
  const primaryOrigin = new URL(primaryEndpoint).origin;
  return document.targets.flatMap((target) => {
    if (
      target._tag !== "BearerConnectionTarget" ||
      document.disabledEnvironmentIds.includes(target.environmentId)
    )
      return [];
    const profile = document.profiles.find(
      (profile) =>
        profile.connectionId === target.connectionId && profile._tag === "BearerConnectionProfile",
    );
    const credential = document.credentials.find(
      (credential) => credential.connectionId === target.connectionId,
    )?.credential;
    if (
      profile?._tag !== "BearerConnectionProfile" ||
      credential?._tag !== "BearerConnectionCredential"
    )
      return [];
    try {
      const endpoint = new URL(profile.httpBaseUrl);
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.origin === primaryOrigin
      )
        return [];
      return [
        {
          id: target.environmentId,
          label: profile.label,
          endpoint: endpoint.toString().replace(/\/$/, ""),
          enabled: true,
          token: credential.token,
        },
      ];
    } catch {
      return [];
    }
  });
}

const CHANGED = "t3code:local-sharing-changed";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeGrant = Schema.decodeUnknownSync(LocalConnectionsGrant);
const decodeStatus = Schema.decodeUnknownSync(LocalConnectionsStatus);
let latest: ConnectionCatalogDocument | null = null;
let queue: Promise<unknown> = Promise.resolve();
let syncError = false;

function destination(): string | null {
  try {
    const endpoint = resolvePrimaryEnvironmentHttpUrl("/api/local-connections");
    if (!isLocalConnectionsEndpoint(endpoint)) return null;
    if (
      !window.desktopBridge &&
      (!isLocalConnectionsEndpoint(window.location.origin) ||
        new URL(endpoint).origin !== window.location.origin)
    )
      return null;
    return endpoint;
  } catch {
    return null;
  }
}
const key = (endpoint: string) => `t3code:local-sharing:${new URL(endpoint).origin}`;
function localGrant(endpoint: string): string | null {
  try {
    const grant = window.localStorage.getItem(key(endpoint));
    return grant && grant !== "true" && !grant.startsWith("pending:") ? grant : null;
  } catch {
    return null;
  }
}
function notify() {
  window.dispatchEvent(new Event(CHANGED));
}
async function request(
  endpoint: string,
  method: string,
  document?: ConnectionCatalogDocument,
  grantId?: string,
  expectedRevision?: string,
) {
  // Desktop bearer is scoped to the primary destination; browser cookies never leave its origin.
  const token = await readDesktopPrimaryBearerToken();
  const response = await fetch(endpoint, {
    method,
    credentials: window.desktopBridge ? "omit" : "same-origin",
    redirect: "error",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(document ? { "Content-Type": "application/json" } : {}),
    },
    ...(document
      ? {
          body: encode({
            environments: sharedBearerEntries(document, endpoint),
            ...(grantId ? { grantId } : {}),
            ...(expectedRevision ? { expectedRevision } : {}),
          }),
        }
      : {}),
  });
  if (!response.ok)
    throw new Error(
      "Local sharing requires a loopback primary server and administrator permissions.",
    );
  return response;
}
function serial<A>(run: () => Promise<A>): Promise<A> {
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** Persistence always succeeds independently of the optional sharing transport. */
export function catalogForLocalSharing(document: ConnectionCatalogDocument): void {
  latest = document;
  const endpoint = destination();
  const grantId = endpoint ? localGrant(endpoint) : null;
  if (!endpoint || !grantId) return;
  void serial(async () => {
    if (localGrant(endpoint) !== grantId) return;
    try {
      await request(endpoint, "POST", document, grantId);
      syncError = false;
    } catch {
      syncError = true;
    }
    notify();
  });
}
export async function localSharingStatus(): Promise<{
  available: boolean;
  enabled: boolean;
  serverEnabled: boolean;
  needsReenable: boolean;
  syncError: boolean;
}> {
  const endpoint = destination();
  const unavailable = {
    available: false,
    enabled: false,
    serverEnabled: false,
    needsReenable: false,
    syncError,
  };
  if (!endpoint) return unavailable;
  try {
    const response = await request(endpoint, "GET");
    const status = decodeStatus(await response.json());
    const grant = localGrant(endpoint);
    const enabled = status.enabled && grant !== null && grant === status.grantId;
    return {
      available: true,
      enabled,
      serverEnabled: status.enabled,
      needsReenable: !enabled && (status.enabled || grant !== null),
      syncError,
    };
  } catch {
    return unavailable;
  }
}
export async function setLocalSharing(enabled: boolean): Promise<void> {
  const endpoint = destination();
  if (!endpoint || (enabled && latest === null))
    throw new Error("Local connection sharing is unavailable.");
  // A pending consent marker cannot authorize background sync. Revoke removes it immediately.
  // This browser-only marker coordinates consent across tabs, not an Effect workflow.
  // @effect-diagnostics-next-line cryptoRandomUUID:off
  const pending = `pending:${crypto.randomUUID()}`;
  if (!enabled) window.localStorage.removeItem(key(endpoint));
  else window.localStorage.setItem(key(endpoint), pending);
  await serial(async () => {
    const initial = latest;
    try {
      let expectedRevision: string | undefined;
      if (enabled) {
        const status = decodeStatus(await (await request(endpoint, "GET")).json());
        expectedRevision = status.revision;
        // A different tab may revoke while the revision read is in flight.
        if (window.localStorage.getItem(key(endpoint)) !== pending) return;
      }
      const response = await request(
        endpoint,
        enabled ? "PUT" : "DELETE",
        enabled ? initial! : undefined,
        undefined,
        expectedRevision,
      );
      if (enabled) {
        const { grantId } = decodeGrant(await response.json());
        if (window.localStorage.getItem(key(endpoint)) === pending) {
          window.localStorage.setItem(key(endpoint), grantId);
          // Mutations made while PUT was in flight were deliberately not shared under
          // pending consent. Reconcile the latest catalog under the newly issued epoch.
          if (latest !== initial) await request(endpoint, "POST", latest!, grantId);
        }
      }
    } catch (cause) {
      if (enabled && window.localStorage.getItem(key(endpoint)) === pending)
        window.localStorage.removeItem(key(endpoint));
      syncError = true;
      notify();
      throw cause;
    }
    syncError = false;
    notify();
  });
}
export function onLocalSharingChanged(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}
