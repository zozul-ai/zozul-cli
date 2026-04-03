import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import type {
  SessionEntry,
  ParsedSession,
  ParsedTurn,
  ToolCallInfo,
  ContentBlock,
} from "./types.js";
import { computeTurnCost } from "../pricing/index.js";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

// Claude Code stores session files as:
//   ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
// Session UUIDs match the standard UUID v4 format.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * Discover all session JSONL files across all projects.
 * Files are stored directly in each project directory (not in a sessions/ subdir).
 */
export type DiscoveredFile = {
  filePath: string;
  projectPath: string;
  parentSessionId?: string;
  agentType?: string;
};

export function discoverSessionFiles(): DiscoveredFile[] {
  const results: DiscoveredFile[] = [];

  if (!fs.existsSync(PROJECTS_DIR)) return results;

  for (const projectDir of fs.readdirSync(PROJECTS_DIR)) {
    const projectDirPath = path.join(PROJECTS_DIR, projectDir);
    const stat = fs.statSync(projectDirPath);
    if (!stat.isDirectory()) continue;

    const decodedProject = decodeProjectPath(projectDir);

    for (const file of fs.readdirSync(projectDirPath)) {
      // Main session JSONL files
      if (UUID_RE.test(file)) {
        results.push({
          filePath: path.join(projectDirPath, file),
          projectPath: decodedProject,
        });
      }

      // Check for subagents directory inside UUID-named session dirs
      const uuidDirMatch = file.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      if (uuidDirMatch) {
        const subagentsDir = path.join(projectDirPath, file, "subagents");
        if (fs.existsSync(subagentsDir)) {
          const parentSessionId = uuidDirMatch[1];
          for (const agentFile of fs.readdirSync(subagentsDir)) {
            if (!agentFile.endsWith(".jsonl")) continue;
            let agentType: string | undefined;
            try {
              const metaPath = path.join(subagentsDir, agentFile.replace(".jsonl", ".meta.json"));
              const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
              agentType = meta.agentType;
            } catch { /* no meta or invalid JSON */ }
            results.push({
              filePath: path.join(subagentsDir, agentFile),
              projectPath: decodedProject,
              parentSessionId,
              agentType,
            });
          }
        }
      }
    }
  }

  return results.sort((a, b) => {
    const aStat = fs.statSync(a.filePath);
    const bStat = fs.statSync(b.filePath);
    return bStat.mtimeMs - aStat.mtimeMs;
  });
}

/**
 * Parse a single session JSONL file into a structured ParsedSession.
 */
export async function parseSessionFile(
  filePath: string,
  projectPath?: string,
  opts?: { parentSessionId?: string; agentType?: string },
): Promise<ParsedSession> {
  const entries = await readJsonlFile(filePath);
  const sessionId = path.basename(filePath, ".jsonl");

  const turns: ParsedTurn[] = [];
  let turnIndex = 0;
  let model: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;

  // Track whether each entry is a real user prompt or an automatic tool-result
  const entryIsRealUser: boolean[] = [];

  for (const entry of entries) {
    if (!entry.message) continue;
    const msg = entry.message;
    const timestamp = entry.timestamp ?? new Date().toISOString();

    if (!startedAt) startedAt = timestamp;
    endedAt = timestamp;

    if (msg.model) model = msg.model;

    const usage = msg.usage ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const costUsd = entry.costUSD ?? computeTurnCost(
      msg.model ?? model,
      inputTokens,
      outputTokens,
      cacheRead,
      cacheCreation,
    );
    const durationMs = entry.durationMs ?? 0;

    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCacheReadTokens += cacheRead;
    totalCacheCreationTokens += cacheCreation;
    totalCostUsd += costUsd;

    const { text, toolCalls } = extractContent(msg.content);

    const realUser = msg.role === "user" && !entry.sourceToolAssistantUUID;
    entryIsRealUser.push(realUser);

    turns.push({
      turnIndex,
      role: msg.role,
      timestamp,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      costUsd,
      durationMs,
      model: msg.model ?? null,
      contentText: text,
      toolCalls,
      isRealUser: realUser,
    });

    turnIndex++;
  }

  // Compute processing duration: for each real user prompt, find the last
  // assistant turn before the next real user prompt. Duration = that gap.
  // Only assigned to the real user turn (the one that triggered processing).
  const realUserTurnIndices: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (entryIsRealUser[i]) realUserTurnIndices.push(i);
  }

  for (let ri = 0; ri < realUserTurnIndices.length; ri++) {
    const userIdx = realUserTurnIndices[ri];
    const nextUserIdx = ri + 1 < realUserTurnIndices.length
      ? realUserTurnIndices[ri + 1]
      : turns.length;

    let lastAssistantTs: string | null = null;
    for (let j = userIdx + 1; j < nextUserIdx; j++) {
      if (turns[j].role === "assistant") {
        lastAssistantTs = turns[j].timestamp;
      }
    }

    if (lastAssistantTs && turns[userIdx].durationMs === 0) {
      const userTime = new Date(turns[userIdx].timestamp).getTime();
      const assistantTime = new Date(lastAssistantTs).getTime();
      const gap = assistantTime - userTime;
      if (gap > 0) turns[userIdx].durationMs = gap;
    }
  }

  totalDurationMs = turns.reduce((sum, t) => sum + t.durationMs, 0);

  return {
    sessionId,
    projectPath: projectPath ?? null,
    parentSessionId: opts?.parentSessionId ?? null,
    agentType: opts?.agentType ?? null,
    startedAt: startedAt ?? new Date().toISOString(),
    endedAt,
    model,
    turns,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalCostUsd,
    totalDurationMs,
  };
}

/**
 * Extract text content and tool calls from a message's content field.
 */
function extractContent(
  content: string | ContentBlock[] | undefined,
): { text: string; toolCalls: ToolCallInfo[] } {
  if (!content) return { text: "", toolCalls: [] };
  if (typeof content === "string") return { text: content, toolCalls: [] };

  const textParts: string[] = [];
  const toolCalls: ToolCallInfo[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "tool_use" && block.name) {
      toolCalls.push({
        toolName: block.name,
        toolInput: (block.input as Record<string, unknown>) ?? {},
      });
    } else if (block.type === "tool_result") {
      const resultText = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text)
              .join("\n")
          : "";

      const matchingCall = toolCalls.find((tc) => !tc.toolResult);
      if (matchingCall) {
        matchingCall.toolResult = resultText;
      }
    }
  }

  return { text: textParts.join("\n"), toolCalls };
}

async function readJsonlFile(filePath: string): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

function decodeProjectPath(encoded: string): string {
  return encoded.replace(/-/g, "/");
}
