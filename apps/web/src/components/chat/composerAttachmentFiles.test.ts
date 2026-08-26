import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  classifyComposerAttachmentFile,
  inferImageMimeTypeFromName,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  it("keeps supported images and HEIC photos on the image path", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.png", type: "image/png" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "photo.heic", type: "" })).toBe("image");
  });

  it("rejects unsupported image types instead of attaching them as generic files", () => {
    expect(classifyComposerAttachmentFile({ name: "diagram.svg", type: "image/svg+xml" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "photo.tiff", type: "image/tiff" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "report.pdf", type: "application/pdf" })).toBe(
      "file",
    );
  });

  it("preserves text paste when an application adds a synthetic generic file", () => {
    const file = new File(["clipboard"], "clipboard.rtf", { type: "application/rtf" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file],
        plainText: "Copied text",
        maxFileAttachmentBytes: 50 * 1024 * 1024,
      }),
    ).toBe(false);
  });

  it("only claims generic file pastes accepted by the current server", () => {
    const file = new File(["report"], "report.pdf", { type: "application/pdf" });
    const input = {
      files: [file],
      plainText: "",
    };

    expect(shouldHandleComposerAttachmentPaste({ ...input, maxFileAttachmentBytes: null })).toBe(
      false,
    );
    expect(shouldHandleComposerAttachmentPaste({ ...input, maxFileAttachmentBytes: 1 })).toBe(
      false,
    );
    expect(shouldHandleComposerAttachmentPaste({ ...input, maxFileAttachmentBytes: 10 })).toBe(
      true,
    );
  });

  it("falls back to the extension when an image arrives without a MIME type", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.jpg", type: "" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "shot.PNG", type: "" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "archive.zip", type: "" })).toBe("file");
    expect(classifyComposerAttachmentFile({ name: "no-extension", type: "" })).toBe("file");
    expect(inferImageMimeTypeFromName("photo.jpg")).toBe("image/jpeg");
    expect(inferImageMimeTypeFromName("archive.zip")).toBeNull();
  });

  it("keeps persisted hydrated uploads when the upload capability flips off", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const image: ComposerImageAttachment = {
      type: "image",
      id: "image-1",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUrl: "blob:photo",
      file: new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }),
    };
    const uploadingFile: ComposerFileAttachment = {
      type: "file",
      id: "file-uploading",
      name: "fresh.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: new File([new Uint8Array([1, 2, 3])], "fresh.pdf", { type: "application/pdf" }),
    };
    const hydratedFile: ComposerFileAttachment = {
      type: "file",
      id: "file-hydrated",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: null,
      uploadedAttachmentId: "pending-report-pdf",
      uploadEnvironmentId: environmentId,
    };

    const released = attachmentsToReleaseOnUploadCapabilityLoss([
      image,
      uploadingFile,
      hydratedFile,
    ]);

    expect(released.map((attachment) => attachment.id)).toEqual(["image-1", "file-uploading"]);
  });

  it("claims image pastes even when clipboard text is present", () => {
    const image = new File(["image"], "photo.heic", { type: "image/heic" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [image],
        plainText: "Image caption",
        maxFileAttachmentBytes: null,
      }),
    ).toBe(true);
  });
});
