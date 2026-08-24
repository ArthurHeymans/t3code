// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import type { PiSessionSummary } from "@t3tools/contracts";

const SESSION_READ_LIMIT = 256 * 1024;
const DEFAULT_LIST_LIMIT = 200;

function piAgentDirectory(environment: NodeJS.ProcessEnv): string | null {
  const configured = environment["PI_CODING_AGENT_DIR"];
  if (configured?.trim()) return NodePath.resolve(configured);
  const home = environment["HOME"] ?? environment["USERPROFILE"];
  return home?.trim() ? NodePath.resolve(home, ".pi", "agent") : null;
}

export function piSessionsRoot(environment: NodeJS.ProcessEnv = process.env): string | null {
  const agentDirectory = piAgentDirectory(environment);
  return agentDirectory === null ? null : NodePath.resolve(agentDirectory, "sessions");
}

function textFromContent(content: unknown, maxLength?: number): string | null {
  if (typeof content === "string") {
    const text = content.trim();
    if (text.length === 0) return null;
    return maxLength === undefined ? text : text.slice(0, maxLength);
  }
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((block) => {
      if (typeof block !== "object" || block === null) return [];
      const value = (block as Record<string, unknown>)["text"];
      return typeof value === "string" ? [value] : [];
    })
    .join("\n")
    .trim();
  if (text.length === 0) return null;
  return maxLength === undefined ? text : text.slice(0, maxLength);
}

export async function readPiSessionSummary(sessionPath: string): Promise<PiSessionSummary | null> {
  const info = await NodeFSP.stat(sessionPath).catch(() => null);
  if (info === null || !info.isFile()) return null;

  const handle = await NodeFSP.open(sessionPath, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const buffer = Buffer.alloc(Math.min(SESSION_READ_LIMIT, Math.max(1, info.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    const header = JSON.parse(lines[0] ?? "null") as unknown;
    if (typeof header !== "object" || header === null) return null;
    const headerRecord = header as Record<string, unknown>;
    const sessionId = headerRecord["id"];
    const cwd = headerRecord["cwd"];
    const timestamp = headerRecord["timestamp"];
    if (
      headerRecord["type"] !== "session" ||
      typeof sessionId !== "string" ||
      typeof cwd !== "string" ||
      !NodePath.isAbsolute(cwd) ||
      typeof timestamp !== "string" ||
      Number.isNaN(Date.parse(timestamp))
    ) {
      return null;
    }

    let name: string | null = null;
    let firstUserText: string | null = null;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (record["type"] === "session_info" && typeof record["name"] === "string") {
        const candidate = record["name"].trim();
        if (candidate) name = candidate;
      }
      if (firstUserText === null && record["type"] === "message") {
        const message = record["message"];
        if (typeof message === "object" && message !== null) {
          const messageRecord = message as Record<string, unknown>;
          if (messageRecord["role"] === "user") {
            firstUserText = textFromContent(messageRecord["content"], 300);
          }
        }
      }
      if (name !== null && firstUserText !== null) break;
    }

    return {
      sessionPath,
      sessionId,
      cwd,
      name,
      firstUserText,
      createdAt: new Date(timestamp).toISOString(),
      updatedAt: info.mtime.toISOString(),
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function collectJsonlFiles(directory: string): Promise<string[]> {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = NodePath.resolve(directory, entry.name);
      if (entry.isDirectory()) return collectJsonlFiles(path);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    }),
  );
  return nested.flat();
}

export async function listPiSessions(
  input: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly limit?: number;
  } = {},
): Promise<ReadonlyArray<PiSessionSummary>> {
  const root = piSessionsRoot(input.environment);
  if (root === null) return [];
  const files = await collectJsonlFiles(root);
  const summaries = (await Promise.all(files.map(readPiSessionSummary))).filter(
    (summary): summary is PiSessionSummary => summary !== null,
  );
  summaries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return summaries.slice(0, Math.min(500, Math.max(1, input.limit ?? DEFAULT_LIST_LIMIT)));
}

export interface PiSessionTranscriptMessage {
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly ordinal: number;
}

interface PiSessionEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string | null;
  readonly message: unknown;
}

function entryTimestamp(record: Record<string, unknown>, message: unknown): string | null {
  const timestamp = record["timestamp"];
  if (typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp))) {
    return new Date(timestamp).toISOString();
  }
  if (typeof message === "object" && message !== null) {
    const messageTimestamp = (message as Record<string, unknown>)["timestamp"];
    if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
      return new Date(messageTimestamp).toISOString();
    }
  }
  return null;
}

export async function readPiSessionTranscript(
  sessionPath: string,
): Promise<ReadonlyArray<PiSessionTranscriptMessage>> {
  const entries = new Map<string, PiSessionEntry>();
  let leafId: string | null = null;
  const lines = NodeReadline.createInterface({
    input: NodeFS.createReadStream(sessionPath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "string") continue;
    const parentId = record["parentId"];
    const message = record["type"] === "message" ? record["message"] : null;
    entries.set(id, {
      id,
      parentId: typeof parentId === "string" ? parentId : null,
      timestamp: entryTimestamp(record, message),
      message,
    });
    leafId = id;
  }

  const branch: PiSessionEntry[] = [];
  const visited = new Set<string>();
  let entryId = leafId;
  while (entryId !== null && !visited.has(entryId)) {
    visited.add(entryId);
    const entry = entries.get(entryId);
    if (entry === undefined) break;
    branch.push(entry);
    entryId = entry.parentId;
  }
  branch.reverse();

  const fallbackTimestamp = (await NodeFSP.stat(sessionPath)).mtime.toISOString();
  return branch
    .flatMap((entry) => {
      if (typeof entry.message !== "object" || entry.message === null) return [];
      const message = entry.message as Record<string, unknown>;
      const role = message["role"];
      if (role !== "user" && role !== "assistant") return [];
      const text = textFromContent(message["content"]);
      if (text === null) return [];
      return [
        {
          entryId: entry.id,
          role: role as "user" | "assistant",
          text,
          createdAt: entry.timestamp ?? fallbackTimestamp,
        },
      ];
    })
    .map((message, index) => ({ ...message, ordinal: index + 1 }));
}

export async function validatePiSessionPath(
  sessionPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PiSessionSummary | null> {
  const root = piSessionsRoot(environment);
  if (root === null) return null;
  const [canonicalRoot, canonicalPath] = await Promise.all([
    NodeFSP.realpath(root).catch(() => null),
    NodeFSP.realpath(sessionPath).catch(() => null),
  ]);
  if (canonicalRoot === null || canonicalPath === null) return null;
  const withinRoot = NodePath.relative(canonicalRoot, canonicalPath);
  if (withinRoot.startsWith("..") || NodePath.isAbsolute(withinRoot)) return null;
  return readPiSessionSummary(canonicalPath);
}
