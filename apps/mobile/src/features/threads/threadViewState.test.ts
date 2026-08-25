import { describe, expect, it } from "vite-plus/test";

import { resolveAppliedThreadViewBoundary, resolveThreadViewCommand } from "./threadViewState";

const input = {
  appState: "active" as const,
  connectionState: "connected" as const,
  completedAt: "2026-01-01T00:01:00.000Z",
  viewedAt: "2026-01-01T00:00:00.000Z",
  supported: true,
};

describe("resolveThreadViewCommand", () => {
  it("acknowledges a completed thread only while the app is active and connected", () => {
    expect(resolveThreadViewCommand(input)).toEqual({
      viewedThrough: input.completedAt,
      expectedViewedAt: input.viewedAt,
    });
    expect(resolveThreadViewCommand({ ...input, appState: "background" })).toBeUndefined();
    expect(resolveThreadViewCommand({ ...input, appState: "inactive" })).toBeUndefined();
    expect(resolveThreadViewCommand({ ...input, connectionState: "reconnecting" })).toBeUndefined();
    expect(resolveThreadViewCommand({ ...input, completedAt: null })).toBeUndefined();
    expect(resolveThreadViewCommand({ ...input, supported: false })).toBeUndefined();
  });

  it("does not acknowledge a completion that the server already recorded", () => {
    expect(
      resolveThreadViewCommand({
        ...input,
        viewedAt: "2026-01-01T00:01:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("omits missing or invalid view boundaries from the command guard", () => {
    expect(resolveThreadViewCommand({ ...input, viewedAt: undefined })).toEqual({
      viewedThrough: input.completedAt,
    });
    expect(resolveThreadViewCommand({ ...input, viewedAt: "not-a-timestamp" })).toEqual({
      viewedThrough: input.completedAt,
    });
  });

  it("does not acknowledge an invalid completion timestamp", () => {
    expect(resolveThreadViewCommand({ ...input, completedAt: "not-a-timestamp" })).toBeUndefined();
    expect(
      resolveThreadViewCommand({
        ...input,
        completedAt: "not-a-timestamp",
        viewedAt: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("resolveAppliedThreadViewBoundary", () => {
  const earlierCompletion = "2026-01-01T00:01:00.000Z";
  const laterCompletion = "2026-01-01T00:02:00.000Z";

  it("retries the latest completion after an earlier requested view is applied", () => {
    expect(
      resolveAppliedThreadViewBoundary({
        completedAt: laterCompletion,
        viewedAt: earlierCompletion,
        requestedBoundaries: new Set([earlierCompletion, laterCompletion]),
      }),
    ).toBe(earlierCompletion);
  });

  it("does not retry when another client explicitly marks the thread unread", () => {
    expect(
      resolveAppliedThreadViewBoundary({
        completedAt: laterCompletion,
        viewedAt: "2026-01-01T00:01:59.999Z",
        requestedBoundaries: new Set([earlierCompletion, laterCompletion]),
      }),
    ).toBeUndefined();
  });

  it("does not retry an invalid or already covered completion", () => {
    const requestedBoundaries = new Set([earlierCompletion, laterCompletion]);

    expect(
      resolveAppliedThreadViewBoundary({
        completedAt: laterCompletion,
        viewedAt: laterCompletion,
        requestedBoundaries,
      }),
    ).toBeUndefined();
    expect(
      resolveAppliedThreadViewBoundary({
        completedAt: laterCompletion,
        viewedAt: "not-a-timestamp",
        requestedBoundaries,
      }),
    ).toBeUndefined();
    expect(
      resolveAppliedThreadViewBoundary({
        completedAt: "not-a-timestamp",
        viewedAt: earlierCompletion,
        requestedBoundaries,
      }),
    ).toBeUndefined();
  });
});
