import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { onTestFinished, vi } from "vite-plus/test";

const composerDraftFileMocks = vi.hoisted(() => {
  let document = "";
  let writeError: Error | null = null;
  let releaseRead: (() => void) | null = null;
  let readBarrier = Promise.resolve();

  return {
    blockRead() {
      readBarrier = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseRead() {
      releaseRead?.();
      releaseRead = null;
    },
    getDocument() {
      return document;
    },
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
        await readBarrier;
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
});

const composerAttachmentCleanupMocks = vi.hoisted(() => ({
  remove: vi.fn(async () => undefined),
}));

vi.mock("expo-file-system", () => ({
  Directory: composerDraftFileMocks.Directory,
  File: composerDraftFileMocks.File,
  Paths: { document: "/documents" },
}));

vi.mock("../lib/composerImages", () => ({
  removePersistedComposerAttachmentFile: composerAttachmentCleanupMocks.remove,
}));

import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";
import {
  appendComposerDraftAttachments,
  clearComposerDraftContentState,
  ComposerDraftPersistenceError,
  composerDraftsAtom,
  copyComposerDraftContentIfEmpty,
  copyComposerDraftContentState,
  decodePersistedComposerDrafts,
  type ComposerDraft,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContentState,
  releaseUnusedComposerAttachmentFiles,
  removeComposerDraftsForEnvironment,
  restoreComposerDraftSnapshotState,
  setComposerDraftText,
  undoComposerDraftMergeState,
} from "./use-composer-drafts";

const DRAFT: ComposerDraft = {
  text: "hello",
  attachments: [],
};

afterEach(() => {
  appAtomRegistry.set(composerDraftsAtom, {});
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  composerAttachmentCleanupMocks.remove.mockClear();
});

describe("mobile composer drafts", () => {
  // Hydration is one-shot per module instance and the attachment sweep now
  // triggers it too, so this test must observe it before any sweep test runs.
  it("waits for persisted drafts before copying content between projects", async () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const unrelatedKey = "environment-1:thread-1";
    const source = { text: "Current task", attachments: [] } satisfies ComposerDraft;
    const target = { text: "Persisted target", attachments: [] } satisfies ComposerDraft;
    const unrelated = { text: "Keep me", attachments: [] } satisfies ComposerDraft;

    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: {
        [targetKey]: target,
        [unrelatedKey]: unrelated,
      },
    });
    composerDraftFileMocks.blockRead();
    appAtomRegistry.set(composerDraftsAtom, { [sourceKey]: source });

    const copy = copyComposerDraftContentIfEmpty(sourceKey, targetKey);
    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({ [sourceKey]: source });

    composerDraftFileMocks.releaseRead();
    await copy;

    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({
      [sourceKey]: source,
      [targetKey]: target,
      [unrelatedKey]: unrelated,
    });
  });

  it("hydrates generic file attachments from their saved local paths", () => {
    const file = {
      id: "file-1",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/report.pdf",
    };

    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": { text: "Review this file", attachments: [file] },
        },
      }),
    ).toEqual({
      "environment-1:thread-1": { text: "Review this file", attachments: [file] },
    });
  });

  it("caps appended attachments at the send limit against the live draft", () => {
    const makeAttachment = (id: string) => ({
      id,
      type: "file" as const,
      name: `${id}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: `file:///documents/t3-composer-attachments/${id}.pdf`,
    });
    const existing = Array.from({ length: 7 }, (_, index) => makeAttachment(`held-${index}`));
    appAtomRegistry.set(composerDraftsAtom, {
      "environment-1:thread-cap": { text: "send this", attachments: existing },
    });

    const rejected = appendComposerDraftAttachments("environment-1:thread-cap", [
      makeAttachment("incoming-1"),
      makeAttachment("incoming-2"),
    ]);

    expect(rejected).toBe(1);
    const draft = appAtomRegistry.get(composerDraftsAtom)["environment-1:thread-cap"];
    expect(draft?.attachments).toHaveLength(8);
    expect(draft?.attachments.at(-1)?.id).toBe("incoming-1");

    // Restore paths bypass the cap so a failed send never drops its files.
    const overflowRejected = appendComposerDraftAttachments(
      "environment-1:thread-cap",
      [makeAttachment("restored-1")],
      { allowOverflow: true },
    );
    expect(overflowRejected).toBe(0);
    expect(
      appAtomRegistry.get(composerDraftsAtom)["environment-1:thread-cap"]?.attachments,
    ).toHaveLength(9);
  });

  it("keeps shared attachment files until every draft releases them", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const file = {
      id: "file-1",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    appAtomRegistry.set(composerDraftsAtom, {
      source: { text: "First draft", attachments: [file] },
      copied: { text: "Second draft", attachments: [file] },
    });

    await releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    appAtomRegistry.set(composerDraftsAtom, {
      copied: { text: "Second draft", attachments: [file] },
    });
    await releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();

    appAtomRegistry.set(composerDraftsAtom, {});
    await releaseUnusedComposerAttachmentFiles([file]);
    expect(composerAttachmentCleanupMocks.remove).toHaveBeenCalledWith(file.fileUri);
  });

  it("keeps local attachment files while an outbox message still needs them", async () => {
    const file = {
      id: "file-queued",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
      "environment-1:thread-1": [
        {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          commandId: CommandId.make("command-1"),
          text: "Review the report",
          attachments: [file],
          createdAt: "2026-08-24T12:00:00.000Z",
        },
      ],
    });

    await releaseUnusedComposerAttachmentFiles([file]);

    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
  });

  it("loads persisted outbox messages before deciding an attachment file is unused", async () => {
    const file = {
      id: "file-persisted",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    const load = vi.spyOn(threadOutboxManager, "load").mockImplementation(async () => {
      appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
        "environment-1:thread-1": [
          {
            environmentId: EnvironmentId.make("environment-1"),
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("message-persisted"),
            commandId: CommandId.make("command-persisted"),
            text: "Review the report",
            attachments: [file],
            createdAt: "2026-08-24T12:00:00.000Z",
          },
        ],
      });
      return true;
    });

    try {
      await releaseUnusedComposerAttachmentFiles([file]);

      expect(load).toHaveBeenCalledOnce();
      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it("does not delete attachment files when the draft removal cannot be saved", async () => {
    const file = {
      id: "file-unsaved",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    setComposerDraftText("environment-1:thread-1", "Unsaved draft");
    composerDraftFileMocks.setWriteError(new Error("storage unavailable"));

    try {
      await expect(releaseUnusedComposerAttachmentFiles([file])).rejects.toBeInstanceOf(
        ComposerDraftPersistenceError,
      );
      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    } finally {
      composerDraftFileMocks.setWriteError(null);
    }
  });

  it("hydrates selector state even when the message content is empty", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "new-task:environment-1:project-1": {
            text: "",
            attachments: [],
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            workspaceSelection: {
              mode: "worktree",
              branch: "main",
              worktreePath: null,
            },
          },
        },
      }),
    ).toEqual({
      "new-task:environment-1:project-1": {
        text: "",
        attachments: [],
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspaceSelection: {
          mode: "worktree",
          branch: "main",
          worktreePath: null,
        },
      },
    });
  });

  it("keeps legacy content-only drafts and rejects invalid selector state", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": DRAFT,
        },
      }),
    ).toEqual({
      "environment-1:thread-1": DRAFT,
    });

    expect(() =>
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": {
            ...DRAFT,
            runtimeMode: "sometimes-safe",
          },
        },
      }),
    ).toThrow();
  });

  it("clears sent content without clearing the selected model or workspace", () => {
    const draftKey = "environment-1:thread-1";
    const draft: ComposerDraft = {
      text: "send this",
      attachments: [],
      importedShareIds: ["share-1"],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
      },
    };

    expect(clearComposerDraftContentState({ [draftKey]: draft }, draftKey)).toEqual({
      [draftKey]: {
        modelSelection: draft.modelSelection,
        workspaceSelection: draft.workspaceSelection,
        text: "",
        attachments: [],
      },
    });
  });

  it("drops the workspace selection when clearing a sent new-task draft", () => {
    const draftKey = "new-task:environment-1:project-1";
    const draft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
        startFromOrigin: false,
      },
    };

    expect(
      clearComposerDraftContentState({ [draftKey]: draft }, draftKey, {
        clearWorkspaceSelection: true,
      }),
    ).toEqual({
      [draftKey]: {
        modelSelection: draft.modelSelection,
        text: "",
        attachments: [],
      },
    });
  });

  it("reads the latest selector state synchronously for send", () => {
    const draftKey = "environment-1:thread-1";
    const selectedDraft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    };
    appAtomRegistry.set(composerDraftsAtom, { [draftKey]: selectedDraft });

    expect(getComposerDraftSnapshot(draftKey)).toEqual(selectedDraft);
  });

  it("carries unfinished content to a newly selected project without overwriting its settings", () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const source: ComposerDraft = {
      text: "Keep this task",
      attachments: [],
      importedShareIds: ["share-1"],
      workspaceSelection: {
        mode: "worktree",
        branch: "feature/source",
        worktreePath: null,
      },
    };
    const target: ComposerDraft = {
      text: "",
      attachments: [],
      runtimeMode: "approval-required",
    };

    expect(
      copyComposerDraftContentState(
        { [sourceKey]: source, [targetKey]: target },
        sourceKey,
        targetKey,
      ),
    ).toEqual({
      [sourceKey]: source,
      [targetKey]: {
        ...target,
        text: source.text,
        attachments: source.attachments,
        importedShareIds: source.importedShareIds,
      },
    });
  });

  it("does not overwrite unfinished content already stored for the selected project", () => {
    const sourceKey = "new-task:environment-1:project-1";
    const targetKey = "new-task:environment-1:project-2";
    const drafts: Record<string, ComposerDraft> = {
      [sourceKey]: { text: "Source task", attachments: [] },
      [targetKey]: { text: "Target task", attachments: [] },
    };

    expect(copyComposerDraftContentState(drafts, sourceKey, targetKey)).toBe(drafts);
  });

  it("merges shared content into a project draft without duplicating retries", () => {
    const draftKey = "new-task:environment-1:project-1";
    const sharedAttachment = {
      id: "share-1:image:0",
      type: "image" as const,
      name: "Screenshot.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "data:image/png;base64,YWJj",
    };
    const existing: Record<string, ComposerDraft> = {
      [draftKey]: { text: "Existing context", attachments: [] },
    };
    const content = {
      text: "Shared note",
      attachments: [sharedAttachment],
      sourceShareId: "share-1",
    };

    const merged = mergeComposerDraftContentState(existing, draftKey, content);
    expect(merged[draftKey]).toMatchObject({
      text: "Existing context\n\nShared note",
      attachments: [sharedAttachment],
      importedShareIds: ["share-1"],
    });
    expect(mergeComposerDraftContentState(merged, draftKey, content)).toBe(merged);

    const edited = {
      ...merged,
      [draftKey]: { ...merged[draftKey]!, text: "User edited the imported context" },
    };
    expect(mergeComposerDraftContentState(edited, draftKey, content)).toBe(edited);
  });

  it("preserves existing images when shared content exceeds the draft attachment limit", () => {
    const draftKey = "new-task:environment-1:project-1";
    const image = (id: string) => ({
      id,
      type: "image" as const,
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "data:image/png;base64,YWJj",
    });
    const existingImage = image("existing");
    const sharedImages = Array.from({ length: 8 }, (_, index) => image(`shared-${index}`));

    const merged = mergeComposerDraftContentState(
      { [draftKey]: { text: "", attachments: [existingImage] } },
      draftKey,
      { text: "", attachments: sharedImages },
    );

    expect(merged[draftKey]?.attachments).toHaveLength(8);
    expect(merged[draftKey]?.attachments[0]).toEqual(existingImage);
    expect(merged[draftKey]?.attachments.at(-1)?.id).toBe("shared-6");
  });

  it("restores the exact draft captured before an interrupted share import", () => {
    const draftKey = "new-task:environment-1:project-1";
    const beforeImport: ComposerDraft = {
      text: "Existing context",
      attachments: [],
      runtimeMode: "approval-required",
    };
    const imported: ComposerDraft = {
      ...beforeImport,
      text: "Existing context\n\nShared note",
      importedShareIds: ["share-1"],
    };

    expect(
      restoreComposerDraftSnapshotState({ [draftKey]: imported }, draftKey, beforeImport),
    ).toEqual({ [draftKey]: beforeImport });
    expect(
      restoreComposerDraftSnapshotState({ [draftKey]: imported }, draftKey, {
        text: "",
        attachments: [],
      }),
    ).toEqual({});
  });

  it("removes only drafts owned by the selected environment", () => {
    const environmentId = EnvironmentId.make("environment-cloud");
    const retainedEnvironmentId = EnvironmentId.make("environment-local");

    expect(
      removeComposerDraftsForEnvironment(
        {
          [`${environmentId}:thread-cloud`]: DRAFT,
          [`new-task:${environmentId}:project-cloud`]: DRAFT,
          [`${retainedEnvironmentId}:thread-local`]: DRAFT,
          [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
        },
        environmentId,
      ),
    ).toEqual({
      [`${retainedEnvironmentId}:thread-local`]: DRAFT,
      [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
    });
  });

  it("lands a still-debounced draft write when flushed", async () => {
    const draftKey = "environment-1:thread-1";
    setComposerDraftText(draftKey, "typed right before the restart");

    await flushComposerDrafts();

    expect(JSON.parse(composerDraftFileMocks.getDocument())).toMatchObject({
      drafts: { [draftKey]: { text: "typed right before the restart" } },
    });
  });

  it("propagates a flush write failure instead of resolving as saved", async () => {
    const draftKey = "environment-1:thread-1";
    setComposerDraftText(draftKey, "unsaved");
    composerDraftFileMocks.setWriteError(new Error("storage unavailable"));

    try {
      await expect(flushComposerDrafts()).rejects.toBeInstanceOf(ComposerDraftPersistenceError);
    } finally {
      composerDraftFileMocks.setWriteError(null);
    }
  });

  it("restores the pre-merge snapshot when the draft is untouched since the merge", () => {
    const draftKey = "environment-1:thread-1";
    const snapshot: ComposerDraft = { text: "typed before", attachments: [] };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [],
      runtimeMode: "approval-required",
    };

    expect(undoComposerDraftMergeState({ [draftKey]: merged }, draftKey, snapshot, merged)).toEqual(
      { [draftKey]: snapshot },
    );
    expect(
      undoComposerDraftMergeState(
        { [draftKey]: merged },
        draftKey,
        { text: "", attachments: [] },
        merged,
      ),
    ).toEqual({});
  });

  it("returns merge-written settings to the snapshot but keeps user-edited ones", () => {
    const draftKey = "environment-1:thread-1";
    const snapshot: ComposerDraft = {
      text: "typed before",
      attachments: [],
      runtimeMode: "approval-required",
      interactionMode: "default",
    };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [],
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    // The user edited the text (forcing the partial undo) and also switched
    // interaction mode, but never touched the merge-written runtime mode.
    const edited: ComposerDraft = {
      text: "typed EDITED before\n\nqueued text",
      attachments: [],
      runtimeMode: "full-access",
      interactionMode: "plan",
    };

    expect(undoComposerDraftMergeState({ [draftKey]: edited }, draftKey, snapshot, merged)).toEqual(
      {
        [draftKey]: {
          text: "typed EDITED before",
          attachments: [],
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      },
    );
  });

  it("takes out only what the merge inserted when the user edited during it", () => {
    const draftKey = "environment-1:thread-1";
    const keptAttachment = {
      id: "kept",
      type: "file" as const,
      name: "kept.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      fileUri: "file:///documents/t3-composer-attachments/kept.pdf",
    };
    const insertedAttachment = {
      id: "inserted",
      type: "file" as const,
      name: "inserted.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      fileUri: "file:///documents/t3-composer-attachments/inserted.pdf",
    };
    const userAttachment = { ...keptAttachment, id: "user-added" };
    const snapshot: ComposerDraft = { text: "typed before", attachments: [keptAttachment] };
    const merged: ComposerDraft = {
      text: "typed before\n\nqueued text",
      attachments: [keptAttachment, insertedAttachment],
    };
    // The user rewrote the leading text and attached a file mid-recovery.
    const edited: ComposerDraft = {
      text: "typed EDITED before\n\nqueued text",
      attachments: [keptAttachment, insertedAttachment, userAttachment],
    };

    expect(undoComposerDraftMergeState({ [draftKey]: edited }, draftKey, snapshot, merged)).toEqual(
      {
        [draftKey]: {
          text: "typed EDITED before",
          attachments: [keptAttachment, userAttachment],
        },
      },
    );

    // Edits that broke the merged suffix keep their text untouched; only the
    // inserted attachments still come out.
    const rewritten: ComposerDraft = {
      text: "totally rewritten",
      attachments: [insertedAttachment],
    };
    expect(
      undoComposerDraftMergeState({ [draftKey]: rewritten }, draftKey, snapshot, merged),
    ).toEqual({
      [draftKey]: { text: "totally rewritten", attachments: [] },
    });
  });

  it("spares a file re-owned between the sweep's scan and its deletion", async () => {
    const outboxLoad = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
    onTestFinished(() => outboxLoad.mockRestore());
    const fileFor = (id: string) => ({
      id,
      type: "file" as const,
      name: `${id}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: `file:///documents/t3-composer-attachments/${id}.pdf`,
    });
    const first = fileFor("file-first");
    const reowned = fileFor("file-reowned");
    // A restore re-owns the second file while the first deletion is in
    // flight, after the sweep already decided both were unused.
    composerAttachmentCleanupMocks.remove.mockImplementationOnce(async () => {
      appAtomRegistry.set(composerDraftsAtom, {
        "environment-1:thread-1": { text: "restored", attachments: [reowned] },
      });
    });

    await releaseUnusedComposerAttachmentFiles([first, reowned]);

    expect(composerAttachmentCleanupMocks.remove.mock.calls).toEqual([[first.fileUri]]);
  });

  // Uses a fresh module instance (hydration is one-shot), so it stays last.
  it("hydrates persisted drafts before a cold-start sweep deletes their files", async () => {
    const file = {
      id: "file-cold-start",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/t3-composer-attachments/report.pdf",
    };
    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: {
        "environment-1:thread-1": { text: "Persisted draft", attachments: [file] },
      },
    });
    vi.resetModules();
    const fresh = await import("./use-composer-drafts");
    const freshRegistry = (await import("./atom-registry")).appAtomRegistry;

    await fresh.releaseUnusedComposerAttachmentFiles([file]);

    expect(freshRegistry.get(fresh.composerDraftsAtom)).toEqual({
      "environment-1:thread-1": { text: "Persisted draft", attachments: [file] },
    });
    expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
  });
});
