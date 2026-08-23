import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { AppStateStatus } from "react-native";

export function shouldAcknowledgeThreadView(input: {
  readonly appState: AppStateStatus;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly completedAt: string | null;
  readonly viewedAt: string | undefined;
  readonly supported: boolean;
}): boolean {
  if (
    input.appState !== "active" ||
    input.connectionState !== "connected" ||
    input.completedAt === null ||
    !input.supported
  ) {
    return false;
  }
  if (input.viewedAt === undefined) return true;

  const viewedAtMs = Date.parse(input.viewedAt);
  const completedAtMs = Date.parse(input.completedAt);
  return (
    !Number.isFinite(viewedAtMs) || !Number.isFinite(completedAtMs) || viewedAtMs < completedAtMs
  );
}
