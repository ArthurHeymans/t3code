import { describe, expect, it } from "vite-plus/test";

import { shouldAcknowledgeThreadView } from "./threadViewState";

const input = {
  appState: "active" as const,
  connectionState: "connected" as const,
  completedAt: "2026-01-01T00:01:00.000Z",
  viewedAt: "2026-01-01T00:00:00.000Z",
  supported: true,
};

describe("shouldAcknowledgeThreadView", () => {
  it("acknowledges a completed thread only while the app is active and connected", () => {
    expect(shouldAcknowledgeThreadView(input)).toBe(true);
    expect(shouldAcknowledgeThreadView({ ...input, appState: "background" })).toBe(false);
    expect(shouldAcknowledgeThreadView({ ...input, appState: "inactive" })).toBe(false);
    expect(shouldAcknowledgeThreadView({ ...input, connectionState: "reconnecting" })).toBe(false);
    expect(shouldAcknowledgeThreadView({ ...input, completedAt: null })).toBe(false);
    expect(shouldAcknowledgeThreadView({ ...input, supported: false })).toBe(false);
  });

  it("does not acknowledge a completion that the server already recorded", () => {
    expect(
      shouldAcknowledgeThreadView({
        ...input,
        viewedAt: "2026-01-01T00:01:00.000Z",
      }),
    ).toBe(false);
    expect(shouldAcknowledgeThreadView({ ...input, viewedAt: undefined })).toBe(true);
    expect(shouldAcknowledgeThreadView({ ...input, viewedAt: "not-a-timestamp" })).toBe(true);
  });

  it("does not acknowledge an invalid completion timestamp", () => {
    expect(shouldAcknowledgeThreadView({ ...input, completedAt: "not-a-timestamp" })).toBe(false);
    expect(
      shouldAcknowledgeThreadView({
        ...input,
        completedAt: "not-a-timestamp",
        viewedAt: undefined,
      }),
    ).toBe(false);
  });
});
