import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
} from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";

import type { AtomCommand } from "./runtime.ts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
  formatAttachmentSize,
  runAttachmentUploadCycle,
} from "./attachments.ts";

const environmentId = EnvironmentId.make("environment-1");
// The cycle threads the registry through to the commands untouched, so the
// fakes below can ignore it.
const registry = {} as AtomRegistry.AtomRegistry;

type CreateUploadUrlCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentCreateUploadUrlInput },
  AttachmentCreateUploadUrlResult,
  never
>;

type RemoveCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentDeleteInput },
  unknown,
  never
>;

function makeCreateUploadUrl(attachmentId: string): CreateUploadUrlCommand {
  return {
    label: "test:create-upload-url",
    run: async () =>
      AsyncResult.success<AttachmentCreateUploadUrlResult, never>({
        attachmentId,
        relativeUrl: `/api/attachments/upload/${attachmentId}`,
        expiresAt: 1,
      }),
  };
}

const removeCalls: string[] = [];
const remove: RemoveCommand = {
  label: "test:remove",
  run: async (_registry, input) => {
    removeCalls.push(input.input.attachmentId);
    return AsyncResult.success(undefined);
  },
};

const uploadInput: AttachmentCreateUploadUrlInput = {
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 3,
};

describe("runAttachmentUploadCycle", () => {
  it("mints, transfers, and reports the attachment id", async () => {
    const transferred: string[] = [];
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-1"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: (relativeUrl) => `https://environment.test${relativeUrl}`,
      transport: (url) => {
        transferred.push(url);
        return { done: Promise.resolve(), abort: () => {} };
      },
    });

    expect(result).toEqual({ status: "uploaded", attachmentId: "pending-1" });
    expect(transferred).toEqual(["https://environment.test/api/attachments/upload/pending-1"]);
  });

  it("deletes the fresh mint when the caller cancels at onMinted", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-cancelled"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => {
        throw new Error("transport must not run after cancel");
      },
      onMinted: () => "cancel",
    });

    expect(result).toEqual({ status: "cancelled", attachmentId: "pending-cancelled" });
    expect(removeCalls).toEqual(["pending-cancelled"]);
  });

  it("keeps the minted id on transfer failure so the caller can retry or release", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-failed"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => ({
        done: Promise.reject(new Error("Upload rejected (413)")),
        abort: () => {},
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      step: "transfer",
      attachmentId: "pending-failed",
    });
    expect(removeCalls).toEqual([]);
  });
});

describe("file attachment limits", () => {
  it("clamps the advertised limit to the turn contract cap", () => {
    expect(clampFileAttachmentUploadBytes(1024)).toBe(1024);
    expect(clampFileAttachmentUploadBytes(PROVIDER_SEND_TURN_MAX_FILE_BYTES * 2)).toBe(
      PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    );
  });

  it("formats sizes and the too-large rejection", () => {
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatAttachmentSize(1)).toBe("1 KB");
    expect(fileAttachmentTooLargeMessage("big.zip", 50 * 1024 * 1024)).toBe(
      "'big.zip' exceeds the 50 MB attachment limit.",
    );
  });
});
