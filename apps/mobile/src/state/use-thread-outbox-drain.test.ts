import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  removePersistedFile: vi.fn(async () => undefined),
  setPendingConnectionError: vi.fn(),
  draftFile: (() => {
    let document = "";
    let writeError: Error | null = null;
    return {
      setDocument(value: unknown) {
        document = JSON.stringify(value);
      },
      setWriteError(error: Error | null) {
        writeError = error;
      },
      Directory: class {
        create() {}
      },
      File: class {
        exists = true;
        parentDirectory = null;

        create() {}

        moveSync() {}

        async text() {
          return document;
        }

        write(value: string) {
          if (writeError) {
            throw writeError;
          }
          document = value;
        }
      },
    };
  })(),
}));

vi.mock("expo-file-system", () => ({
  Directory: harness.draftFile.Directory,
  File: harness.draftFile.File,
  Paths: { document: "/documents" },
}));

vi.mock("../lib/composerImages", () => ({
  removePersistedComposerAttachmentFile: harness.removePersistedFile,
  toUploadChatImageAttachments: () => [],
}));

vi.mock("../lib/uuid", () => ({
  uuidv4: () => "00000000-0000-4000-8000-000000000000",
  randomHex: () => "abcd",
}));

vi.mock("../lib/attachmentUpload", () => ({
  prepareTurnAttachments: vi.fn(),
}));

vi.mock("./entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  useThreadShells: () => [],
}));

vi.mock("./threads", () => ({
  threadEnvironment: {},
}));

vi.mock("./use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make<Record<string, boolean>>({}).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () => ({}),
    useThreadOutboxShellStatuses: () => new Map(),
  };
});

vi.mock("./use-remote-environment-registry", () => ({
  setPendingConnectionError: harness.setPendingConnectionError,
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
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
  const manager = harness.manager;
  return {
    threadOutboxManager: manager,
    flushThreadOutbox: async () => undefined,
    ensureThreadOutboxLoaded: () => undefined,
    confirmThreadOutboxMessageQueued: (message: never) => manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: never, expectedRevision?: number) =>
      manager.update(message, expectedRevision),
    threadOutboxRevision: (messageId: never) => manager.revisionOf(messageId),
  };
});

import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { composerDraftsAtom, getComposerDraftSnapshot } from "./use-composer-drafts";
import {
  completeQueuedMessageDelivery,
  restoreRejectedQueuedMessage,
} from "./use-thread-outbox-drain";

function queuedMessage(input: {
  readonly messageId: string;
  readonly text: string;
  readonly fileUri?: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.text,
    attachments: input.fileUri
      ? [
          {
            id: `file-${input.messageId}`,
            type: "file",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            fileUri: input.fileUri,
          },
        ]
      : [],
    createdAt: "2026-08-24T12:00:00.000Z",
  };
}

function remainingMessages(): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom)).flat();
}

afterEach(() => {
  appAtomRegistry.set(harness.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(composerDraftsAtom, {});
  harness.draftFile.setWriteError(null);
  harness.removePersistedFile.mockClear();
  harness.setPendingConnectionError.mockClear();
});

describe("thread outbox drain delivery cleanup", () => {
  it("keeps an edited message and its files when delivery cleanup loses the revision race", async () => {
    const message = queuedMessage({
      messageId: "message-edited",
      text: "original",
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);
    const edited = { ...message, text: "edited while the turn delivered" };
    await harness.manager.update(edited);

    await expect(completeQueuedMessageDelivery(message, deliveryRevision)).resolves.toBe(false);

    expect(remainingMessages()).toEqual([edited]);
    expect(harness.removePersistedFile).not.toHaveBeenCalled();
  });

  it("removes the delivered message when no edit was accepted", async () => {
    const message = queuedMessage({ messageId: "message-clean", text: "hello" });
    await harness.manager.enqueue(message);
    const deliveryRevision = harness.manager.revisionOf(message.messageId);

    await expect(completeQueuedMessageDelivery(message, deliveryRevision)).resolves.toBe(true);

    expect(remainingMessages()).toEqual([]);
  });
});

describe("thread outbox recovery rollback", () => {
  it("rolls a failed recovery merge back so the retry cannot duplicate the text", async () => {
    const message = queuedMessage({ messageId: "message-restore", text: "queued text" });
    const draftKey = `${message.environmentId}:${message.threadId}`;
    appAtomRegistry.set(composerDraftsAtom, {
      [draftKey]: { text: "typed offline", attachments: [] },
    });
    await harness.manager.enqueue(message);

    harness.draftFile.setWriteError(new Error("disk full"));
    await expect(restoreRejectedQueuedMessage(message, "too large")).resolves.toBe("retry");

    // The merge was rolled back and the message stayed queued for the retry.
    expect(getComposerDraftSnapshot(draftKey).text).toBe("typed offline");
    expect(remainingMessages()).toEqual([message]);

    harness.draftFile.setWriteError(null);
    await expect(restoreRejectedQueuedMessage(message, "too large")).resolves.toBe("restored");

    // The recovered text landed exactly once and the message left the queue.
    expect(getComposerDraftSnapshot(draftKey).text).toBe("typed offline\n\nqueued text");
    expect(remainingMessages()).toEqual([]);
    expect(harness.setPendingConnectionError).toHaveBeenCalledWith("too large");
  });
});
