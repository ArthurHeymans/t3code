import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  cleanup: vi.fn(),
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
}));

vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  harness.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => [],
      write: async () => undefined,
      remove: async () => undefined,
    },
  });
  return { threadOutboxManager: harness.manager };
});

vi.mock("./use-composer-drafts", () => ({
  scheduleUnusedComposerAttachmentCleanup: harness.cleanup,
}));

import { appAtomRegistry } from "./atom-registry";
import { clearThreadOutboxEnvironment, removeThreadOutboxMessage } from "./thread-outbox-removal";
import type { QueuedThreadMessage } from "./thread-outbox-model";

function queuedMessage(input: {
  readonly environmentId: string;
  readonly messageId: string;
  readonly fileUri: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId),
    threadId: ThreadId.make(`thread-${input.messageId}`),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: "Review the report",
    attachments: [
      {
        id: `file-${input.messageId}`,
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: input.fileUri,
      },
    ],
    createdAt: "2026-08-24T12:00:00.000Z",
  };
}

afterEach(() => {
  appAtomRegistry.set(harness.manager.queuedMessagesByThreadKeyAtom, {});
  harness.cleanup.mockClear();
});

describe("thread outbox removal", () => {
  it("releases a removed message's attachment files with the removal itself", async () => {
    const message = queuedMessage({
      environmentId: "environment-1",
      messageId: "message-1",
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    });
    await harness.manager.enqueue(message);

    await removeThreadOutboxMessage(message);

    expect(appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(harness.cleanup).toHaveBeenCalledExactlyOnceWith(message.attachments);
  });

  it("releases only the cleared environment's queued attachment files", async () => {
    const cleared = queuedMessage({
      environmentId: "environment-1",
      messageId: "message-cleared",
      fileUri: "file:///documents/t3-composer-attachments/cleared.pdf",
    });
    const kept = queuedMessage({
      environmentId: "environment-2",
      messageId: "message-kept",
      fileUri: "file:///documents/t3-composer-attachments/kept.pdf",
    });
    await harness.manager.enqueue(cleared);
    await harness.manager.enqueue(kept);

    await clearThreadOutboxEnvironment(cleared.environmentId);

    expect(harness.cleanup).toHaveBeenCalledExactlyOnceWith(cleared.attachments);
    const remaining = Object.values(
      appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom),
    ).flat();
    expect(remaining.map((message) => message.messageId)).toEqual([kept.messageId]);
  });
});
