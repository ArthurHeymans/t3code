import type { EnvironmentId } from "@t3tools/contracts";

import { threadOutboxManager } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { scheduleUnusedComposerAttachmentCleanup } from "./use-composer-drafts";

/**
 * The only way a queued message leaves the outbox. Removal also releases the
 * message's local attachment files (via the reference-counting sweep, so a
 * file still referenced by a draft or another queued message survives).
 * Keeping release inside the removal call means no call site can forget it.
 *
 * `expectedRevision` (from `threadOutboxRevision`) makes the removal a
 * compare-and-set: when an edit was accepted since the revision was read, the
 * newer message stays queued, nothing is released, and this returns false.
 */
export async function removeThreadOutboxMessage(
  message: QueuedThreadMessage,
  expectedRevision?: number,
): Promise<boolean> {
  if (!(await threadOutboxManager.remove(message, expectedRevision))) {
    return false;
  }
  scheduleUnusedComposerAttachmentCleanup(message.attachments);
  return true;
}

/** Removes every queued message of an environment and releases their files. */
export async function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  // clearEnvironment loads and merges persisted messages itself and reports
  // what it actually removed, so the release set cannot miss messages a
  // failed earlier hydration would have hidden.
  const removed = await threadOutboxManager.clearEnvironment(environmentId);
  scheduleUnusedComposerAttachmentCleanup(removed.flatMap((message) => message.attachments));
}
