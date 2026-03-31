import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SessionRepo } from "../storage/repo.js";
import type { TurnRow } from "../storage/db.js";

const CLASSIFIER_MARKER = "You are documenting a block of AI-assisted engineering work";

export interface TagBlocksOptions {
  projectPath?: string;
  sessionId?: string;
  model?: string;
  verbose?: boolean;
}

export interface TagBlocksResult {
  sessions: number;
  segments: number;
  turns: number;
  costUsd: number;
}

// ── Segmentation prompt ──

function buildSegmentationPrompt(userTurns: TurnRow[], existingTags: string[]): string {
  const lines: string[] = [];

  lines.push("You are analyzing a Claude Code conversation to identify natural blocks of consistent work.");
  lines.push("Group consecutive user messages that are pursuing the same goal or working in the same area.");
  lines.push("");

  if (existingTags.length > 0) {
    lines.push("Existing tags in this project (prefer reusing these):");
    lines.push("  " + existingTags.join(", "));
    lines.push("");
  }

  lines.push("User turns:");
  for (let i = 0; i < userTurns.length; i++) {
    const text = (userTurns[i].content_text ?? "").trim().replace(/\n+/g, " ");
    lines.push(`${i + 1}. "${text}"`);
  }

  lines.push("");
  lines.push("Return ONLY a valid JSON array. Each element is a segment:");
  lines.push(`[
  {"turns": [1, 2, 3], "tags": ["dashboard"]},
  {"turns": [4, 5], "tags": ["storage", "classifier"]}
]`);
  lines.push("");
  lines.push("Rules:");
  lines.push("- turns: 1-based indices, must be contiguous, every turn in exactly one segment");
  lines.push("- tags: high-level product area only — e.g. storage, dashboard, classifier, hooks, sync, cli, otel, parser");
  lines.push("- NOT techniques or patterns: debugging, refactoring, prompt-engineering, schema-migration");
  lines.push("- 1-3 tags per segment, reuse existing vocabulary where it fits");
  lines.push("- Merge short clarification turns into the surrounding segment, don't create 1-turn segments");

  return lines.join("\n");
}

// ── Claude runner (reuse same pattern as commit classifier) ──

interface ClaudeOutput {
  result: string;
  costUsd: number;
}

function runClaude(prompt: string, model: string): ClaudeOutput {
  const result = spawnSync(
    "claude",
    ["-p", prompt, "--model", model, "--output-format", "json"],
    { encoding: "utf-8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`claude exited ${result.status}: ${(result.stderr ?? "").slice(0, 200)}`);
  }

  const raw = (result.stdout ?? "").trim();
  try {
    const envelope = JSON.parse(raw);
    const text: string = envelope.result ?? envelope.content ?? raw;
    const costUsd: number = envelope.total_cost_usd ?? 0;
    return { result: text, costUsd };
  } catch {
    return { result: raw, costUsd: 0 };
  }
}

// ── Output parser ──

interface Segment {
  turns: number[];  // 1-based indices into the userTurns array
  tags: string[];
}

function parseSegments(text: string): Segment[] {
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON array found: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]) as unknown[];
  return parsed.map((s: unknown) => {
    const seg = s as { turns?: unknown; tags?: unknown };
    return {
      turns: Array.isArray(seg.turns) ? seg.turns.map(Number) : [],
      tags: Array.isArray(seg.tags) ? seg.tags.map(String).filter(Boolean) : [],
    };
  });
}

// ── Session processor ──

async function tagSession(
  repo: SessionRepo,
  sessionId: string,
  existingTags: string[],
  model: string,
  verbose?: boolean,
): Promise<{ segments: number; turns: number; costUsd: number }> {
  // Get real-user turns, filter out classifier's own prompts
  const allUserTurns = repo.getUserTurnsForSession(sessionId);
  const userTurns = allUserTurns.filter(
    t => !(t.content_text ?? "").trimStart().startsWith(CLASSIFIER_MARKER)
  );

  if (userTurns.length < 1) {
    if (verbose) process.stderr.write(`[tag-blocks] session ${sessionId.slice(0, 8)}: skipping (no real user turns)\n`);
    return { segments: 0, turns: 0, costUsd: 0 };
  }

  if (verbose) process.stderr.write(`[tag-blocks] session ${sessionId.slice(0, 8)}: ${userTurns.length} user turns\n`);

  const runId = randomUUID();
  const CHUNK_SIZE = 50;
  let totalSegments = 0;
  let totalTurns = 0;
  let totalCost = 0;

  for (let ci = 0; ci * CHUNK_SIZE < userTurns.length; ci++) {
    const chunk = userTurns.slice(ci * CHUNK_SIZE, (ci + 1) * CHUNK_SIZE);
    const prompt = buildSegmentationPrompt(chunk, existingTags);

    let output: ClaudeOutput;
    try {
      output = runClaude(prompt, model);
    } catch (err) {
      if (verbose) process.stderr.write(`[tag-blocks] claude call failed: ${err}\n`);
      continue;
    }

    let segments: Segment[];
    try {
      segments = parseSegments(output.result);
    } catch (err) {
      if (verbose) process.stderr.write(`[tag-blocks] parse failed: ${err}\n`);
      continue;
    }

    totalCost += output.costUsd;

    for (const seg of segments) {
      if (seg.tags.length === 0) continue;

      // seg.turns are 1-based indices into this chunk
      const allTurnIds = new Set<number>();
      for (const idx of seg.turns) {
        const userTurn = chunk[idx - 1];
        if (!userTurn) continue;
        const blockTurns = repo.getBlockTurns(userTurn.id);
        for (const t of blockTurns) allTurnIds.add(t.id);
      }

      const ids = Array.from(allTurnIds);
      for (const tag of seg.tags) {
        repo.tagTurnsBatch(ids, tag, runId);
      }
      totalTurns += ids.length;
      totalSegments++;

      if (verbose) {
        const preview = seg.turns.map(i => chunk[i - 1]?.content_text?.slice(0, 40) ?? "?").join(" | ");
        process.stderr.write(`  [${seg.tags.join(", ")}] turns ${seg.turns.join(",")} — ${preview}\n`);
      }
    }
  }

  return { segments: totalSegments, turns: totalTurns, costUsd: totalCost };
}

// ── Real-time: tag the most recent block in a session ──

function buildSingleBlockPrompt(contextTurns: TurnRow[], targetTurn: TurnRow, existingTags: string[]): string {
  const lines: string[] = [];

  lines.push("Classify what area of the codebase the following user message is working in.");
  lines.push("");

  if (existingTags.length > 0) {
    lines.push("Existing tags in this project (prefer reusing these):");
    lines.push("  " + existingTags.join(", "));
    lines.push("");
  }

  if (contextTurns.length > 0) {
    lines.push("Recent context (preceding turns):");
    for (const t of contextTurns) {
      const text = (t.content_text ?? "").trim().replace(/\n+/g, " ");
      lines.push(`  - "${text}"`);
    }
    lines.push("");
  }

  const target = (targetTurn.content_text ?? "").trim().replace(/\n+/g, " ");
  lines.push(`Turn to classify: "${target}"`);
  lines.push("");
  lines.push("Return ONLY valid JSON:");
  lines.push(`{"tags": ["storage"]}`);
  lines.push("");
  lines.push("Rules:");
  lines.push("- tags: high-level product area only — e.g. storage, dashboard, classifier, hooks, sync, cli, otel, parser");
  lines.push("- NOT techniques: debugging, refactoring, prompt-engineering");
  lines.push("- 1-3 tags, reuse existing vocabulary where it fits");

  return lines.join("\n");
}

/**
 * Tag the most recent real-user turn in a session. Called on every Stop event.
 * Uses the previous 4 user turns as context to improve accuracy.
 */
export async function tagLatestBlock(
  repo: SessionRepo,
  sessionId: string,
  model = "claude-haiku-4-5-20251001",
  verbose?: boolean,
): Promise<void> {
  const allUserTurns = repo.getUserTurnsForSession(sessionId);
  const userTurns = allUserTurns.filter(
    t => !(t.content_text ?? "").trimStart().startsWith(CLASSIFIER_MARKER)
  );

  if (userTurns.length === 0) return;

  const targetTurn = userTurns[userTurns.length - 1];
  const contextTurns = userTurns.slice(-5, -1); // up to 4 preceding turns

  const existingTags = repo.listTasks().map(t => t.task);
  const prompt = buildSingleBlockPrompt(contextTurns, targetTurn, existingTags);

  let output: ClaudeOutput;
  try {
    output = runClaude(prompt, model);
  } catch (err) {
    if (verbose) process.stderr.write(`[tag-latest] claude call failed: ${err}\n`);
    return;
  }

  let tags: string[];
  try {
    const cleaned = output.result.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no JSON");
    const parsed = JSON.parse(match[0]) as { tags?: unknown };
    tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : [];
  } catch (err) {
    if (verbose) process.stderr.write(`[tag-latest] parse failed: ${err}\n`);
    return;
  }

  if (tags.length === 0) return;

  const runId = randomUUID();
  const blockTurns = repo.getBlockTurns(targetTurn.id);
  const ids = blockTurns.map(t => t.id);
  for (const tag of tags) {
    repo.tagTurnsBatch(ids, tag, runId);
  }

  if (verbose) process.stderr.write(`[tag-latest] session ${sessionId.slice(0, 8)}: [${tags.join(", ")}] — ${(targetTurn.content_text ?? "").slice(0, 60)}\n`);
}

// ── Main entry point ──

export async function tagBlocks(
  repo: SessionRepo,
  opts: TagBlocksOptions = {},
): Promise<TagBlocksResult> {
  const model = opts.model ?? "claude-haiku-4-5-20251001";

  // Get existing tag vocabulary to encourage reuse
  const existingTags = repo.listTasks().map(t => t.task);

  const result: TagBlocksResult = { sessions: 0, segments: 0, turns: 0, costUsd: 0 };

  if (opts.sessionId) {
    const r = await tagSession(repo, opts.sessionId, existingTags, model, opts.verbose);
    result.sessions = 1;
    result.segments += r.segments;
    result.turns += r.turns;
    result.costUsd += r.costUsd;
    return result;
  }

  // Find sessions for the project (or all if no projectPath)
  const sessions = opts.projectPath
    ? repo.getSessionsForProject(opts.projectPath)
    : repo.getSessionsWithUserTurns();

  if (opts.verbose) process.stderr.write(`[tag-blocks] found ${sessions.length} sessions\n`);

  for (const session of sessions) {
    const r = await tagSession(repo, session.id, existingTags, model, opts.verbose);
    if (r.segments > 0) {
      result.sessions++;
      result.segments += r.segments;
      result.turns += r.turns;
      result.costUsd += r.costUsd;
    }
  }

  return result;
}
