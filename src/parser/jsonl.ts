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
export function discoverSessionFiles(): { filePath: string; projectPath: string }[] {
  const results: { filePath: string; projectPath: string }[] = [];

  if (!fs.existsSync(PROJECTS_DIR)) return results;

  for (const projectDir of fs.readdirSync(PROJECTS_DIR)) {
    const projectDirPath = path.join(PROJECTS_DIR, projectDir);
    const stat = fs.statSync(projectDirPath);
    if (!stat.isDirectory()) continue;

    const decodedProject = decodeProjectPath(projectDir);

    for (const file of fs.readdirSync(projectDirPath)) {
      if (!UUID_RE.test(file)) continue;
      results.push({
        filePath: path.join(projectDirPath, file),
        projectPath: decodedProject,
      });
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
    const costUsd = entry.costUSD ?? 0;
    const durationMs = entry.durationMs ?? 0;

    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCacheReadTokens += cacheRead;
    totalCacheCreationTokens += cacheCreation;
    totalCostUsd += costUsd;
    totalDurationMs += durationMs;

    const { text, toolCalls } = extractContent(msg.content);

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
    });

    turnIndex++;
  }

  return {
    sessionId,
    projectPath: projectPath ?? null,
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
