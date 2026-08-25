import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { AppStateStatus } from "react-native";

export function resolveThreadViewCommand(input: {
  readonly appState: AppStateStatus;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly completedAt: string | null;
  readonly viewedAt: string | undefined;
  readonly supported: boolean;
}): { readonly viewedThrough: string; readonly expectedViewedAt?: string } | undefined {
  if (
    input.appState !== "active" ||
    input.connectionState !== "connected" ||
    input.completedAt === null ||
    !input.supported
  ) {
    return undefined;
  }
  const completedAtMs = Date.parse(input.completedAt);
  if (!Number.isFinite(completedAtMs)) return undefined;
  if (input.viewedAt === undefined) return { viewedThrough: input.completedAt };

  const viewedAtMs = Date.parse(input.viewedAt);
  if (!Number.isFinite(viewedAtMs)) return { viewedThrough: input.completedAt };
  if (viewedAtMs >= completedAtMs) return undefined;

  return {
    viewedThrough: input.completedAt,
    expectedViewedAt: input.viewedAt,
  };
}

export function resolveAppliedThreadViewBoundary(input: {
  readonly completedAt: string | null;
  readonly viewedAt: string | undefined;
  readonly requestedBoundaries: ReadonlySet<string>;
}): string | undefined {
  if (input.completedAt === null || input.viewedAt === undefined) return undefined;

  const viewedAtMs = Date.parse(input.viewedAt);
  const completedAtMs = Date.parse(input.completedAt);
  if (!Number.isFinite(viewedAtMs) || !Number.isFinite(completedAtMs)) return undefined;
  if (viewedAtMs >= completedAtMs) return undefined;

  for (const requestedBoundary of input.requestedBoundaries) {
    if (Date.parse(requestedBoundary) === viewedAtMs) {
      return input.viewedAt;
    }
  }

  return undefined;
}
