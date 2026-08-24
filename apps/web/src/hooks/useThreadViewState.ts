import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentSupportsViewState, readThreadShell } from "../state/entities";
import { environmentShell } from "../state/shell";
import { threadEnvironment } from "../state/threads";
import { type PendingThreadViewState, useUiStateStore } from "../uiStateStore";
import { useAtomCommand } from "../state/use-atom-command";

function timestampCovers(timestamp: string | undefined, target: string): boolean {
  if (timestamp === undefined) return false;
  const timestampMs = Date.parse(timestamp);
  const targetMs = Date.parse(target);
  return Number.isFinite(timestampMs) && Number.isFinite(targetMs) && timestampMs >= targetMs;
}

function clearPendingWhenShellCatchesUp(
  threadRef: ScopedThreadRef,
  pending: PendingThreadViewState,
  sequence: number,
  clearPending: (threadKey: string, pending: PendingThreadViewState) => void,
): void {
  const threadKey = scopedThreadKey(threadRef);
  const shellStateAtom = environmentShell.stateValueAtom(threadRef.environmentId);
  let unsubscribe: (() => void) | undefined;
  let completed = false;
  const finishIfCaughtUp = () => {
    if (completed) return;
    if (useUiStateStore.getState().threadViewStatePendingById[threadKey] !== pending) {
      completed = true;
      unsubscribe?.();
      return;
    }
    const snapshot = appAtomRegistry.get(shellStateAtom).snapshot;
    if (Option.isNone(snapshot) || snapshot.value.snapshotSequence < sequence) return;
    completed = true;
    unsubscribe?.();
    clearPending(threadKey, pending);
  };

  finishIfCaughtUp();
  if (completed) return;
  unsubscribe = appAtomRegistry.subscribe(shellStateAtom, finishIfCaughtUp);
  if (completed) {
    unsubscribe();
    return;
  }
  finishIfCaughtUp();
}

/** Keeps the local compatibility marker and the server view marker in sync. */
export function useThreadViewState() {
  const markLocalViewed = useUiStateStore((state) => state.markThreadVisited);
  const markLocalUnread = useUiStateStore((state) => state.markThreadUnread);
  const setPending = useUiStateStore((state) => state.setThreadViewStatePending);
  const keepLocal = useUiStateStore((state) => state.keepThreadViewStateLocal);
  const clearPending = useUiStateStore((state) => state.clearThreadViewStatePending);
  const viewThread = useAtomCommand(threadEnvironment.view, { reportFailure: false });
  const markUnreadOnServer = useAtomCommand(threadEnvironment.markUnread, "thread mark unread");

  const markViewed = useCallback(
    (threadRef: ScopedThreadRef, viewedThrough: string, serverSupportsViewState?: boolean) => {
      if (!Number.isFinite(Date.parse(viewedThrough))) return;
      const threadKey = scopedThreadKey(threadRef);
      if (!(serverSupportsViewState ?? readEnvironmentSupportsViewState(threadRef.environmentId))) {
        markLocalViewed(threadKey, viewedThrough);
        return;
      }
      const thread = readThreadShell(threadRef);
      const previousPending = useUiStateStore.getState().threadViewStatePendingById[threadKey];
      if (
        previousPending?.kind !== "unread" &&
        (timestampCovers(thread?.viewedAt, viewedThrough) ||
          (previousPending?.kind === "viewed" &&
            previousPending.localOnly !== true &&
            timestampCovers(previousPending.targetAt, viewedThrough)))
      ) {
        return;
      }
      const pending = { kind: "viewed", targetAt: viewedThrough } as const;
      setPending(threadKey, pending);
      markLocalViewed(threadKey, viewedThrough);
      void viewThread({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, viewedThrough },
      }).then((result) => {
        if (result._tag === "Failure") {
          keepLocal(threadKey, pending);
          return;
        }
        clearPendingWhenShellCatchesUp(threadRef, pending, result.value.sequence, clearPending);
      });
    },
    [clearPending, keepLocal, markLocalViewed, setPending, viewThread],
  );

  const markUnread = useCallback(
    (threadRef: ScopedThreadRef, latestTurnCompletedAt: string | null | undefined) => {
      const threadKey = scopedThreadKey(threadRef);
      if (
        latestTurnCompletedAt == null ||
        !Number.isFinite(Date.parse(latestTurnCompletedAt)) ||
        !readEnvironmentSupportsViewState(threadRef.environmentId)
      ) {
        markLocalUnread(threadKey, latestTurnCompletedAt);
        return;
      }
      const pending = { kind: "unread", targetAt: latestTurnCompletedAt } as const;
      setPending(threadKey, pending);
      markLocalUnread(threadKey, latestTurnCompletedAt);
      void markUnreadOnServer({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      }).then((result) => {
        if (result._tag === "Failure") {
          keepLocal(threadKey, pending);
          return;
        }
        clearPendingWhenShellCatchesUp(threadRef, pending, result.value.sequence, clearPending);
      });
    },
    [clearPending, keepLocal, markLocalUnread, markUnreadOnServer, setPending],
  );

  return useMemo(() => ({ markViewed, markUnread }), [markUnread, markViewed]);
}
