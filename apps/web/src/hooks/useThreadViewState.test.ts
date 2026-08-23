import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";

type PendingState = { readonly kind: "viewed" | "unread"; readonly targetAt: string };
type ShellListener = () => void;

const testState = vi.hoisted(() => {
  const viewAtom = Symbol("view");
  const unreadAtom = Symbol("unread");
  const shellAtom = Symbol("shell");
  const listeners = new Set<ShellListener>();
  const uiState = {
    threadLastVisitedAtById: {} as Record<string, string>,
    threadViewStatePendingById: {} as Record<string, PendingState>,
    markThreadVisited: vi.fn((threadKey: string, visitedAt: string) => {
      uiState.threadLastVisitedAtById[threadKey] = visitedAt;
    }),
    markThreadUnread: vi.fn((threadKey: string, completedAt: string | null | undefined) => {
      if (completedAt === null || completedAt === undefined) return;
      const completedAtMs = Date.parse(completedAt);
      if (!Number.isFinite(completedAtMs)) return;
      uiState.threadLastVisitedAtById[threadKey] = new Date(completedAtMs - 1).toISOString();
    }),
    setThreadViewStatePending: vi.fn((threadKey: string, pending: PendingState) => {
      uiState.threadViewStatePendingById[threadKey] = pending;
    }),
    clearThreadViewStatePending: vi.fn((threadKey: string, pending: PendingState) => {
      if (uiState.threadViewStatePendingById[threadKey] === pending) {
        delete uiState.threadViewStatePendingById[threadKey];
      }
    }),
  };

  return {
    viewAtom,
    unreadAtom,
    shellAtom,
    listeners,
    uiState,
    supported: true,
    shell: { viewedAt: "2026-01-01T00:00:00.000Z" } as { viewedAt?: string } | null,
    snapshotSequence: 0,
    viewThread: vi.fn(),
    markUnreadOnServer: vi.fn(),
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
  };
});

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => ({
      snapshot: {
        _tag: "Some" as const,
        value: { snapshotSequence: testState.snapshotSequence },
      },
    }),
    subscribe: (_atom: unknown, listener: ShellListener) => {
      testState.listeners.add(listener);
      return () => {
        testState.listeners.delete(listener);
      };
    },
  },
}));

vi.mock("../state/entities", () => ({
  readEnvironmentSupportsViewState: () => testState.supported,
  readThreadShell: () => testState.shell,
}));

vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: () => testState.shellAtom },
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: { view: testState.viewAtom, markUnread: testState.unreadAtom },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === testState.viewAtom ? testState.viewThread : testState.markUnreadOnServer,
}));

vi.mock("../uiStateStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../uiStateStore")>();
  const useUiStateStore = Object.assign(
    (selector: (state: typeof testState.uiState) => unknown) => selector(testState.uiState),
    { getState: () => testState.uiState },
  );
  return { ...actual, useUiStateStore };
});

import { useThreadViewState } from "./useThreadViewState";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const threadKey = scopedThreadKey(threadRef);
const completedAt = "2026-01-01T00:01:00.000Z";

function renderHook() {
  hooks.beginRender();
  return useThreadViewState();
}

async function flushCommands(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function advanceShell(sequence: number, viewedAt: string): void {
  testState.snapshotSequence = sequence;
  testState.shell = { viewedAt };
  for (const listener of testState.listeners) {
    listener();
  }
}

describe("useThreadViewState", () => {
  beforeEach(() => {
    hooks.reset();
    testState.listeners.clear();
    testState.supported = true;
    testState.shell = { viewedAt: "2026-01-01T00:00:00.000Z" };
    testState.snapshotSequence = 0;
    testState.uiState.threadLastVisitedAtById = {};
    testState.uiState.threadViewStatePendingById = {};
    testState.uiState.markThreadVisited.mockClear();
    testState.uiState.markThreadUnread.mockClear();
    testState.uiState.setThreadViewStatePending.mockClear();
    testState.uiState.clearThreadViewStatePending.mockClear();
    testState.viewThread.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 2 } });
    testState.markUnreadOnServer
      .mockReset()
      .mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
  });

  it("keeps optimistic unread state until the authoritative shell catches up", async () => {
    renderHook().markUnread(threadRef, completedAt);
    await flushCommands();

    expect(testState.uiState.threadViewStatePendingById[threadKey]?.kind).toBe("unread");
    expect(testState.listeners).toHaveLength(1);

    advanceShell(1, "2026-01-01T00:00:59.999Z");

    expect(testState.uiState.threadViewStatePendingById[threadKey]).toBeUndefined();
    expect(testState.listeners).toHaveLength(0);
  });

  it("queues a view after marking the same thread unread", async () => {
    testState.shell = { viewedAt: completedAt };
    const { markUnread, markViewed } = renderHook();

    markUnread(threadRef, completedAt);
    markViewed(threadRef, completedAt);

    expect(testState.markUnreadOnServer).toHaveBeenCalledTimes(1);
    expect(testState.viewThread).toHaveBeenCalledTimes(1);
    expect(testState.uiState.threadViewStatePendingById[threadKey]?.kind).toBe("viewed");

    await flushCommands();
    expect(testState.listeners).toHaveLength(1);
    advanceShell(2, completedAt);
    expect(testState.uiState.threadViewStatePendingById[threadKey]).toBeUndefined();
    expect(testState.listeners).toHaveLength(0);
  });

  it("uses the shell event sequence when another device changes the final state", async () => {
    renderHook().markUnread(threadRef, completedAt);
    await flushCommands();

    advanceShell(3, completedAt);

    expect(testState.uiState.threadViewStatePendingById[threadKey]).toBeUndefined();
  });

  it("clears pending state immediately when a server command fails", async () => {
    testState.viewThread.mockResolvedValue({ _tag: "Failure" });

    renderHook().markViewed(threadRef, completedAt);
    await flushCommands();

    expect(testState.uiState.threadViewStatePendingById[threadKey]).toBeUndefined();
    expect(testState.listeners).toHaveLength(0);
  });

  it("clears pending state when the shell arrives before the command receipt", async () => {
    testState.snapshotSequence = 2;

    renderHook().markViewed(threadRef, completedAt);
    await flushCommands();

    expect(testState.uiState.threadViewStatePendingById[threadKey]).toBeUndefined();
    expect(testState.listeners).toHaveLength(0);
  });

  it("uses local state for an old server and syncs once the capability becomes available", () => {
    testState.supported = false;
    const { markViewed } = renderHook();

    markViewed(threadRef, completedAt, false);
    expect(testState.viewThread).not.toHaveBeenCalled();

    testState.supported = true;
    markViewed(threadRef, completedAt, true);
    expect(testState.viewThread).toHaveBeenCalledTimes(1);
  });

  it("does not send invalid view or completion timestamps", () => {
    const { markUnread, markViewed } = renderHook();

    markViewed(threadRef, "not-a-timestamp");
    markUnread(threadRef, "not-a-timestamp");

    expect(testState.viewThread).not.toHaveBeenCalled();
    expect(testState.markUnreadOnServer).not.toHaveBeenCalled();
    expect(testState.uiState.threadViewStatePendingById[threadKey]).toBeUndefined();
  });
});
