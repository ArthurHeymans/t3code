import {
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type ChatAttachment,
  type EnvironmentId,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
} from "@t3tools/client-runtime/state/attachments";
import { create } from "zustand";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assetEnvironment } from "../state/assets";
import { attachmentEnvironment } from "../state/attachments";
import { readPreparedConnection } from "../state/session";
import type { AttachmentUploadState, ReadyAttachmentUpload } from "./attachmentUploadState";

const MAX_UPLOADS_PER_ENVIRONMENT = 3;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

interface AttachmentUploadStore {
  readonly uploadsByImageId: Readonly<Record<string, AttachmentUploadState>>;
}

export const useAttachmentUploadStore = create<AttachmentUploadStore>(() => ({
  uploadsByImageId: {},
}));

interface UploadJob {
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
  readonly environmentId: EnvironmentId;
  readonly previous?: ReadyAttachmentUpload;
  readonly persistedAttachmentId?: string;
  readonly settled: Promise<void>;
  resolveSettled: () => void;
  attachmentId: string | null;
  cancelled: boolean;
  abort: (() => void) | null;
}

const jobsByImageId = new Map<string, UploadJob>();
const queue: UploadJob[] = [];
const activeUploadsByEnvironment = new Map<EnvironmentId, number>();

function setUploadState(imageId: string, upload: AttachmentUploadState): void {
  useAttachmentUploadStore.setState((state) => ({
    uploadsByImageId: { ...state.uploadsByImageId, [imageId]: upload },
  }));
}

function clearUploadState(imageId: string): void {
  useAttachmentUploadStore.setState((state) => {
    if (!(imageId in state.uploadsByImageId)) {
      return state;
    }
    const uploadsByImageId = { ...state.uploadsByImageId };
    delete uploadsByImageId[imageId];
    return { uploadsByImageId };
  });
}

export function readAttachmentUpload(imageId: string): AttachmentUploadState | undefined {
  return useAttachmentUploadStore.getState().uploadsByImageId[imageId];
}

function deletePendingUpload(environmentId: EnvironmentId, attachmentId: string): void {
  deletePendingAttachmentUpload({
    registry: appAtomRegistry,
    remove: attachmentEnvironment.remove,
    environmentId,
    attachmentId,
  });
}

function uploadBytes(input: {
  readonly url: string;
  readonly file: File;
  readonly onProgress: (progress: number) => void;
}): { readonly done: Promise<void>; readonly abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open("POST", input.url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", input.file.type);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload rejected (${xhr.status})`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(input.file);
  });

  return { done, abort: () => xhr.abort() };
}

async function runUpload(job: UploadJob): Promise<void> {
  if (job.persistedAttachmentId) {
    const verification = await verifyPersistedAttachmentUpload({
      registry: appAtomRegistry,
      createAssetUrl: assetEnvironment.createUrl,
      environmentId: job.environmentId,
      attachmentId: job.persistedAttachmentId,
    });
    if (job.cancelled) {
      return;
    }
    if (verification.status === "verified") {
      setUploadState(job.image.id, {
        status: "ready",
        environmentId: job.environmentId,
        attachmentId: job.persistedAttachmentId,
      });
      return;
    }
    if (verification.status === "failed" || !job.image.file) {
      setUploadState(job.image.id, {
        status: "failed",
        environmentId: job.environmentId,
        attachmentId: job.persistedAttachmentId,
        reason:
          verification.status === "missing"
            ? "Uploaded file expired. Remove it and attach it again."
            : "Uploaded file could not be verified. Retry when the server reconnects.",
        ...(job.previous ? { previous: job.previous } : {}),
      });
      return;
    }
  }

  const mimeType =
    job.image.type === "file"
      ? job.image.mimeType.toLowerCase()
      : PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
          (supportedMimeType) => supportedMimeType === job.image.mimeType.toLowerCase(),
        );
  if (!mimeType) {
    setUploadState(job.image.id, {
      status: "failed",
      environmentId: job.environmentId,
      reason: "Unsupported image type",
      ...(job.previous ? { previous: job.previous } : {}),
    });
    return;
  }
  const file = job.image.file;
  if (!file) {
    setUploadState(job.image.id, {
      status: "failed",
      environmentId: job.environmentId,
      reason: "Original file is no longer available",
      ...(job.previous ? { previous: job.previous } : {}),
    });
    return;
  }

  let lastStep = -1;
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId: job.environmentId,
    upload: {
      ...(job.image.type === "file" ? { type: "file" as const } : {}),
      name: job.image.name,
      mimeType,
      sizeBytes: file.size,
    },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(job.environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) =>
      uploadBytes({
        url,
        file,
        onProgress: (progress) => {
          const step = Math.floor(progress * 20);
          if (step === lastStep || job.cancelled) {
            return;
          }
          lastStep = step;
          setUploadState(job.image.id, {
            status: "uploading",
            environmentId: job.environmentId,
            progress,
            ...(job.previous ? { previous: job.previous } : {}),
          });
        },
      }),
    onMinted: (attachmentId) => {
      if (job.cancelled) {
        return "cancel";
      }
      job.attachmentId = attachmentId;
      return "continue";
    },
    onTransferStart: (abort) => {
      job.abort = abort;
    },
  });
  job.abort = null;
  if (result.status === "cancelled" || job.cancelled) {
    return;
  }
  if (result.status === "uploaded") {
    setUploadState(job.image.id, {
      status: "ready",
      environmentId: job.environmentId,
      attachmentId: result.attachmentId,
    });
    if (job.previous) {
      deletePendingUpload(job.previous.environmentId, job.previous.attachmentId);
    }
    return;
  }
  setUploadState(job.image.id, {
    status: "failed",
    environmentId: job.environmentId,
    reason:
      result.step === "mint"
        ? "Upload could not start"
        : result.step === "resolve-url"
          ? "Not connected"
          : result.error instanceof Error
            ? result.error.message
            : "Upload failed",
    ...(result.attachmentId ? { attachmentId: result.attachmentId } : {}),
    ...(job.previous ? { previous: job.previous } : {}),
  });
}

function pumpUploads(): void {
  for (let index = 0; index < queue.length; ) {
    const job = queue[index]!;
    const active = activeUploadsByEnvironment.get(job.environmentId) ?? 0;
    if (active >= MAX_UPLOADS_PER_ENVIRONMENT) {
      index += 1;
      continue;
    }

    queue.splice(index, 1);
    if (job.cancelled) {
      continue;
    }
    activeUploadsByEnvironment.set(job.environmentId, active + 1);
    void runUpload(job)
      .catch(() => {
        if (!job.cancelled) {
          setUploadState(job.image.id, {
            status: "failed",
            environmentId: job.environmentId,
            reason: "Upload failed",
            ...(job.previous ? { previous: job.previous } : {}),
          });
        }
      })
      .finally(() => {
        if (jobsByImageId.get(job.image.id) === job) {
          jobsByImageId.delete(job.image.id);
        }
        const remaining = (activeUploadsByEnvironment.get(job.environmentId) ?? 1) - 1;
        if (remaining > 0) {
          activeUploadsByEnvironment.set(job.environmentId, remaining);
        } else {
          activeUploadsByEnvironment.delete(job.environmentId);
        }
        job.resolveSettled();
        pumpUploads();
      });
  }
}

export function startAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
}): void {
  const existingJob = jobsByImageId.get(input.image.id);
  if (existingJob?.environmentId === input.environmentId) {
    return;
  }

  const existing = readAttachmentUpload(input.image.id);
  if (existing?.status === "ready" && existing.environmentId === input.environmentId) {
    return;
  }
  if (existing?.status === "failed" && existing.environmentId === input.environmentId) {
    return;
  }
  if (
    existing &&
    "previous" in existing &&
    existing.previous?.environmentId === input.environmentId
  ) {
    cancelAttachmentUpload(input.image.id);
    if (existing.status === "failed" && existing.attachmentId) {
      deletePendingUpload(existing.environmentId, existing.attachmentId);
    }
    setUploadState(input.image.id, existing.previous);
    return;
  }

  if (existingJob) {
    cancelAttachmentUpload(input.image.id);
  }
  const previous = existing?.status === "ready" ? existing : existing?.previous;
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const job: UploadJob = {
    image: input.image,
    environmentId: input.environmentId,
    ...(previous ? { previous } : {}),
    ...(input.image.type === "file" &&
    input.image.uploadEnvironmentId === input.environmentId &&
    input.image.uploadedAttachmentId
      ? { persistedAttachmentId: input.image.uploadedAttachmentId }
      : {}),
    settled,
    resolveSettled,
    attachmentId:
      input.image.type === "file" && input.image.uploadEnvironmentId === input.environmentId
        ? (input.image.uploadedAttachmentId ?? null)
        : null,
    cancelled: false,
    abort: null,
  };

  jobsByImageId.set(input.image.id, job);
  queue.push(job);
  setUploadState(input.image.id, {
    status: "uploading",
    environmentId: input.environmentId,
    progress: 0,
    ...(previous ? { previous } : {}),
  });
  pumpUploads();
}

export function cancelAttachmentUpload(imageId: string): void {
  const job = jobsByImageId.get(imageId);
  if (!job) {
    return;
  }
  job.cancelled = true;
  jobsByImageId.delete(imageId);
  const queuedIndex = queue.indexOf(job);
  if (queuedIndex !== -1) {
    queue.splice(queuedIndex, 1);
  }
  job.abort?.();
  if (job.attachmentId) {
    deletePendingUpload(job.environmentId, job.attachmentId);
  }
  job.resolveSettled();
}

export function releaseAttachmentUpload(imageId: string): void {
  const upload = readAttachmentUpload(imageId);
  cancelAttachmentUpload(imageId);
  if (upload?.status === "ready") {
    deletePendingUpload(upload.environmentId, upload.attachmentId);
  } else if (upload) {
    if (upload.status === "failed" && upload.attachmentId) {
      deletePendingUpload(upload.environmentId, upload.attachmentId);
    }
    if (upload.previous) {
      deletePendingUpload(upload.previous.environmentId, upload.previous.attachmentId);
    }
  }
  clearUploadState(imageId);
}

export function releasePersistedAttachmentUpload(input: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}): void {
  const job = jobsByImageId.get(input.id);
  if (
    job?.environmentId === input.environmentId &&
    job.persistedAttachmentId === input.attachmentId
  ) {
    releaseAttachmentUpload(input.id);
    return;
  }
  const upload = readAttachmentUpload(input.id);
  if (
    upload?.status === "ready" &&
    upload.environmentId === input.environmentId &&
    upload.attachmentId === input.attachmentId
  ) {
    releaseAttachmentUpload(input.id);
    return;
  }
  deletePendingUpload(input.environmentId, input.attachmentId);
}

export function retryAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
}): void {
  const previous = readAttachmentUpload(input.image.id);
  cancelAttachmentUpload(input.image.id);
  if (previous?.status === "failed" && previous.attachmentId) {
    deletePendingUpload(previous.environmentId, previous.attachmentId);
  }
  if (previous && "previous" in previous && previous.previous) {
    setUploadState(input.image.id, previous.previous);
  } else {
    clearUploadState(input.image.id);
  }
  startAttachmentUpload(input);
}

export async function awaitAttachmentUploads(imageIds: ReadonlyArray<string>): Promise<void> {
  await Promise.all(imageIds.map((imageId) => jobsByImageId.get(imageId)?.settled));
}

export function getUploadedAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly images: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
}): ChatAttachment[] | null {
  const attachments: ChatAttachment[] = [];
  for (const image of input.images) {
    const upload = readAttachmentUpload(image.id);
    if (upload?.status !== "ready" || upload.environmentId !== input.environmentId) {
      return null;
    }
    attachments.push({
      type: image.type,
      id: upload.attachmentId,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    });
  }
  return attachments;
}

/**
 * The one owner for discarding a draft attachment's server-side upload. The
 * queue-keyed release only sees in-memory state, so after a reload it finds
 * nothing and the pending upload leaks. When the draft carries a persisted
 * `uploadedAttachmentId` (which survives reloads), route through the persisted
 * release; it still prefers the queue path when the queue owns that same
 * attachment. Every draft discard path must funnel through here.
 */
export function releaseDraftAttachment(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
): void {
  if (
    attachment.type === "file" &&
    attachment.uploadedAttachmentId !== undefined &&
    attachment.uploadEnvironmentId !== undefined
  ) {
    releasePersistedAttachmentUpload({
      id: attachment.id,
      environmentId: attachment.uploadEnvironmentId,
      attachmentId: attachment.uploadedAttachmentId,
    });
    // A failed re-upload after verification can hold a newer minted
    // attachment under the queue key. Release whatever is left so neither
    // copy stays behind. (The pending delete is idempotent server-side.)
    if (jobsByImageId.has(attachment.id) || readAttachmentUpload(attachment.id)) {
      releaseAttachmentUpload(attachment.id);
    }
    return;
  }
  releaseAttachmentUpload(attachment.id);
}

export function releaseDraftAttachments(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): void {
  for (const attachment of attachments) {
    releaseDraftAttachment(attachment);
  }
}
