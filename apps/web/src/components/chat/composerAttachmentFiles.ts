import { isProviderSendTurnSupportedImageMimeType } from "@t3tools/contracts";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { isHeicImageFile } from "../../lib/imageCompression";

type ComposerAttachmentFileKind = "image" | "file" | "unsupported-image";

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Some sources (drags from other apps, files piped through a shell) hand over
 * a `File` with an empty MIME type. Maps the extension to a provider-supported
 * image type so a plain `photo.jpg` still lands on the image path; anything
 * unrecognized stays a generic file.
 */
export function inferImageMimeTypeFromName(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

export function classifyComposerAttachmentFile(
  file: Pick<File, "name" | "type">,
): ComposerAttachmentFileKind {
  if (isHeicImageFile(file)) {
    return "image";
  }
  if (file.type === "") {
    return inferImageMimeTypeFromName(file.name) ? "image" : "file";
  }
  if (!file.type.toLowerCase().startsWith("image/")) {
    return "file";
  }
  return isProviderSendTurnSupportedImageMimeType(file.type) ? "image" : "unsupported-image";
}

/**
 * When `capabilities.attachmentUploads` flips off (reconnect, version skew),
 * only uploads whose lifecycle this composer owns are torn down: attachments
 * still backed by a local `File`. A persisted upload is the only copy of a
 * hydrated file's bytes, so a capability flap must not delete it out from
 * under the draft that still references it.
 */
export function attachmentsToReleaseOnUploadCapabilityLoss(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): Array<ComposerImageAttachment | ComposerFileAttachment> {
  return attachments.filter(
    (attachment) => !(attachment.type === "file" && attachment.uploadedAttachmentId !== undefined),
  );
}

export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
  readonly maxFileAttachmentBytes: number | null;
  readonly remainingAttachmentSlots: number;
}): boolean {
  if (input.remainingAttachmentSlots <= 0) {
    return false;
  }

  if (input.files.some((file) => classifyComposerAttachmentFile(file) === "image")) {
    return true;
  }

  const maxFileAttachmentBytes = input.maxFileAttachmentBytes;
  if (input.plainText.length > 0 || maxFileAttachmentBytes === null) {
    return false;
  }

  return input.files.some(
    (file) =>
      classifyComposerAttachmentFile(file) === "file" &&
      file.size > 0 &&
      file.size <= maxFileAttachmentBytes,
  );
}
