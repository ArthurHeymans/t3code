// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  listPiSessions,
  readPiSessionSummary,
  readPiSessionTranscript,
  validatePiSessionPath,
} from "./PiSessions.ts";

const temporaryDirectories: string[] = [];

async function makeAgentDirectory(): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-sessions-"));
  temporaryDirectories.push(directory);
  await NodeFSP.mkdir(NodePath.join(directory, "sessions", "--workspace--"), { recursive: true });
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("PiSessions", () => {
  it("lists nested sessions newest first with bounded metadata", async () => {
    const agentDirectory = await makeAgentDirectory();
    const older = NodePath.join(agentDirectory, "sessions", "--workspace--", "older.jsonl");
    const newer = NodePath.join(agentDirectory, "sessions", "--workspace--", "newer.jsonl");
    await NodeFSP.writeFile(
      older,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "older-id",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/workspace",
        }),
        JSON.stringify({ type: "session_info", name: "Older session" }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "First prompt" }] },
        }),
      ].join("\n"),
    );
    await NodeFSP.writeFile(
      newer,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "newer-id",
        timestamp: "2026-01-02T00:00:00.000Z",
        cwd: "/workspace",
      }),
    );
    const now = new Date();
    await NodeFSP.utimes(older, new Date(now.getTime() - 10_000), new Date(now.getTime() - 10_000));
    await NodeFSP.utimes(newer, now, now);

    const sessions = await listPiSessions({
      environment: { PI_CODING_AGENT_DIR: agentDirectory },
    });

    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["newer-id", "older-id"],
    );
    assert.equal(sessions[1]?.name, "Older session");
    assert.equal(sessions[1]?.firstUserText, "First prompt");
  });

  it("reads only the active message branch and ignores non-conversation entries", async () => {
    const agentDirectory = await makeAgentDirectory();
    const sessionPath = NodePath.join(
      agentDirectory,
      "sessions",
      "--workspace--",
      "branched.jsonl",
    );
    const longAssistantText = "Current branch ".repeat(40).trim();
    await NodeFSP.writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-id",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/workspace",
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "Start" },
        }),
        JSON.stringify({
          type: "message",
          id: "abandoned",
          parentId: "user-1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Old branch" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Hidden" },
              { type: "text", text: longAssistantText },
              { type: "toolCall", id: "tool-1", name: "bash", arguments: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "custom_message",
          id: "notification",
          parentId: "assistant-1",
          content: "Process finished",
        }),
        JSON.stringify({
          type: "message",
          id: "tool-result",
          parentId: "notification",
          message: { role: "toolResult", content: [{ type: "text", text: "output" }] },
        }),
      ].join("\n"),
    );

    const transcript = await readPiSessionTranscript(sessionPath);

    assert.deepEqual(
      transcript.map(({ entryId, role, text, ordinal }) => ({ entryId, role, text, ordinal })),
      [
        { entryId: "user-1", role: "user", text: "Start", ordinal: 1 },
        {
          entryId: "assistant-1",
          role: "assistant",
          text: longAssistantText,
          ordinal: 2,
        },
      ],
    );
  });

  it("rejects malformed sessions and paths outside the sessions root", async () => {
    const agentDirectory = await makeAgentDirectory();
    const malformed = NodePath.join(agentDirectory, "sessions", "--workspace--", "bad.jsonl");
    const outside = NodePath.join(agentDirectory, "outside.jsonl");
    await NodeFSP.writeFile(malformed, "not json\n");
    await NodeFSP.writeFile(
      outside,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "outside-id",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/workspace",
      }),
    );
    const environment = { PI_CODING_AGENT_DIR: agentDirectory };

    assert.isNull(await readPiSessionSummary(malformed));
    assert.isNull(await validatePiSessionPath(outside, environment));
    assert.deepEqual(await listPiSessions({ environment }), []);
  });
});
