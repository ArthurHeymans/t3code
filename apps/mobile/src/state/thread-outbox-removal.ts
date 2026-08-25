import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";
import { flattenQueuedThreadMessages, type QueuedThreadMessage } from "./thread-outbox-model";
import { scheduleUnusedComposerAttachmentCleanup } from "./use-composer-drafts";

/**
 * The only way a queued message leaves the outbox. Removal also releases the
 * message's local attachment files (via the reference-counting sweep, so a
 * file still referenced by a draft or another queued message survives).
 * Keeping release inside the removal call means no call site can forget it.
 */
export async function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  await threadOutboxManager.remove(message);
  scheduleUnusedComposerAttachmentCleanup(message.attachments);
}

/** Removes every queued message of an environment and releases their files. */
export async function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  // Load first so persisted-but-not-yet-hydrated messages contribute their
  // attachments to the release set.
  await threadOutboxManager.load();
  const removedAttachments = flattenQueuedThreadMessages(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  )
    .filter((message) => message.environmentId === environmentId)
    .flatMap((message) => message.attachments);
  await threadOutboxManager.clearEnvironment(environmentId);
  scheduleUnusedComposerAttachmentCleanup(removedAttachments);
}
