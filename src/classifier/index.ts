import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionRepo } from "../storage/repo.js";
import type { TurnRow } from "../storage/db.js";
import { ingestSessionFile } from "../parser/ingest.js";

export interface ClassifyCommitOptions {
  verbose?: boolean;
  model?: string;
}

export interface ClassifyCommitResult {
  commitSha: string;
  commitMessage: string;
  projectPath: string;
  turnCount: number;
  summary: string;
  type: string;
  area: string;
  tags: string[];
  classifierModel: string;
  classifierInputTokens: number;
  classifierOutputTokens: number;
  classifierCostUsd: number;
}

interface CommitInfo {
  sha: string;
  message: string;
  timestamp: string;
  prevTimestamp: string | null;
  changedFiles: string[];
  diff: string;
}

function getCommitInfo(cwd: string): CommitInfo {
  // Get last 2 commits: sha, ISO timestamp, full message body
  const log = execSync(
    "git log -2 --format=%H%x00%aI%x00%B%x01",
    { cwd, encoding: "utf-8" }
  ).trim();

  const entries = log.split("\x01").map(s => s.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("No commits found");

  const [sha, timestamp, ...messageParts] = entries[0].split("\x00");
  const message = messageParts.join("\x00").trim();
  const prevTimestamp = entries.length > 1 ? entries[1].split("\x00")[1] : null;

  let changedFiles: string[] = [];
  let diff = "";
  try {
    changedFiles = execSync("git diff HEAD~1 HEAD --name-only", { cwd, encoding: "utf-8" })
      .trim().split("\n").filter(Boolean);
    diff = execSync("git diff HEAD~1 HEAD", { cwd, encoding: "utf-8" });
  } catch {
    // First commit or shallow clone — skip
  }

  return { sha, message, timestamp, prevTimestamp, changedFiles, diff };
}

/**
 * Find and ingest session files for the given project that were modified
 * within the last 24 hours. This catches the live session at commit time.
 */
async function ingestRecentSessions(
  repo: SessionRepo,
  cwd: string,
  _toTimestamp: string,
  verbose?: boolean,
): Promise<void> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return;

  // Encode the cwd to find the matching project directory
  const encodedCwd = cwd.replace(/\//g, "-");
  const projectDir = path.join(projectsDir, encodedCwd);
  if (!fs.existsSync(projectDir)) return;

  const cutoff = Date.now() - 24 * 3_600_000;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

  for (const file of fs.readdirSync(projectDir)) {
    if (!UUID_RE.test(file)) continue;
    const filePath = path.join(projectDir, file);
    const mtime = fs.statSync(filePath).mtimeMs;
    if (mtime < cutoff) continue;

    try {
      await ingestSessionFile(repo, filePath, cwd, { noTag: true });
      if (verbose) process.stderr.write(`[classifier] ingested: ${file}\n`);
    } catch (err) {
      if (verbose) process.stderr.write(`[classifier] ingest failed for ${file}: ${err}\n`);
    }
  }
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
    case "Write":
      return String(input.file_path ?? input.path ?? "");
    case "Edit":
      return String(input.file_path ?? input.path ?? "");
    case "Bash":
      return String(input.command ?? "");
    case "Grep":
      return `"${String(input.pattern ?? "")}"${input.path ? ` in ${String(input.path)}` : ""}`;
    case "Glob":
      return String(input.pattern ?? "");
    case "WebSearch":
      return String(input.query ?? "");
    case "WebFetch":
      return String(input.url ?? "");
    default:
      return JSON.stringify(input);
  }
}

// Marker that identifies our own classifier prompts so we can skip those turns
const CLASSIFIER_MARKER = "You are documenting a block of AI-assisted engineering work";

function computeSessionStats(turns: TurnRow[]): {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number;
} {
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const t of turns) {
    totalCostUsd += t.cost_usd ?? 0;
    totalInputTokens += t.input_tokens ?? 0;
    totalOutputTokens += t.output_tokens ?? 0;
  }

  const timestamps = turns.map(t => new Date(t.timestamp).getTime()).filter(n => !isNaN(n));
  const durationMs = timestamps.length >= 2
    ? Math.max(...timestamps) - Math.min(...timestamps)
    : 0;

  return { totalCostUsd, totalInputTokens, totalOutputTokens, durationMs };
}

export function computeToolFrequency(turns: TurnRow[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const t of turns) {
    if (!t.tool_calls) continue;
    try {
      const calls = JSON.parse(t.tool_calls) as { toolName: string }[];
      for (const c of calls) {
        freq[c.toolName] = (freq[c.toolName] ?? 0) + 1;
      }
    } catch { /* skip */ }
  }
  return freq;
}

function buildPrompt(commit: CommitInfo, turns: TurnRow[]): string {
  const lines: string[] = [];

  lines.push("You are documenting a block of AI-assisted engineering work that occurred between two git commits.");
  lines.push("Your goal is to produce a rich, accurate record that will be useful when reviewing this work later —");
  lines.push("including what was tried, what failed, what was learned, and what was ultimately shipped.");
  lines.push("");

  // ── Commit context ──
  lines.push("## Commit");
  lines.push(`SHA: ${commit.sha.slice(0, 12)}`);
  lines.push(`Message:\n${commit.message}`);
  lines.push("");

  // ── Session stats ──
  const stats = computeSessionStats(turns);
  const durationMin = Math.round(stats.durationMs / 60_000);
  lines.push("## Session Stats");
  lines.push(`  Turns: ${turns.length}  Duration: ~${durationMin}m  Cost: $${stats.totalCostUsd.toFixed(4)}`);
  lines.push(`  Tokens: ${stats.totalInputTokens} in / ${stats.totalOutputTokens} out`);
  lines.push("");

  if (commit.diff) {
    lines.push("## Code Changes (git diff)");
    lines.push(commit.diff);
    lines.push("");
  } else if (commit.changedFiles.length > 0) {
    lines.push("## Changed Files");
    for (const f of commit.changedFiles) lines.push(`  - ${f}`);
    lines.push("");
  }

  // ── Interaction log — skip turns that are the classifier's own prompts ──
  const workTurns = turns.filter(t =>
    !(t.is_real_user && (t.content_text ?? "").trimStart().startsWith(CLASSIFIER_MARKER))
  );

  lines.push(`## Interaction Log (${workTurns.length} turns)`);
  lines.push("");

  let i = 0;
  while (i < workTurns.length) {
    const turn = workTurns[i];

    if (turn.is_real_user) {
      const text = (turn.content_text ?? "").trim();
      if (text) lines.push(`User: "${text}"`);
      i++;

      const toolCalls: string[] = [];
      const reasoning: string[] = [];

      while (i < workTurns.length && !workTurns[i].is_real_user) {
        const t = workTurns[i];
        if (t.role === "assistant") {
          if (t.tool_calls) {
            try {
              const calls = JSON.parse(t.tool_calls) as { toolName: string; toolInput: Record<string, unknown> }[];
              for (const c of calls) {
                toolCalls.push(`${c.toolName}(${formatToolInput(c.toolName, c.toolInput ?? {})})`);
              }
            } catch { /* skip */ }
          }
          const txt = (t.content_text ?? "").trim();
          if (txt) reasoning.push(txt);
        }
        i++;
      }

      if (toolCalls.length > 0) {
        lines.push(`  Tools: ${toolCalls.join(", ")}`);
      }
      for (const r of reasoning) {
        lines.push(`  Claude: "${r}"`);
      }
      lines.push("");
    } else {
      i++;
    }
  }

  // ── Output schema ──
  lines.push("## Your Task");
  lines.push("Produce a JSON document capturing what happened in this work session. Be specific and detailed.");
  lines.push("");
  lines.push("Fields:");
  lines.push('  "summary": 2-4 sentences. What was the goal, what approach was taken, what was the outcome.');
  lines.push('  "narrative": Full prose account (5-10 sentences). Include the progression of the work, pivots,');
  lines.push('               failed attempts, key debugging moments, and final resolution. This is the main record.');
  lines.push('  "type": One of: bugfix | feature | refactor | exploration | docs | chore | other');
  lines.push('  "area": Primary system/module affected (e.g. "storage", "dashboard", "auth", "classifier")');
  lines.push('  "components": Array of all distinct files/modules/systems touched');
  lines.push('  "approach": One sentence on the technical approach or strategy used');
  lines.push('  "dead_ends": Array of approaches tried that did not work, with brief reason why');
  lines.push('  "learnings": Array of non-obvious insights, discoveries, or gotchas uncovered during the work');
  lines.push('  "tags": Array of high-level semantic tags. Think components, systems, and technologies touched —');
  lines.push('          not implementation details or one-off actions. Tags should be reusable across commits.');
  lines.push('          Good: "storage", "classifier", "dashboard", "git-hooks", "sqlite", "otel", "haiku"');
  lines.push('          Too specific: "truncation-removal", "self-reference-filtering", "circular-prompt-contamination"');
  lines.push('          Avoid: "code", "fix", "work", "session", "claude", "feature", "refactor"');
  lines.push('          Aim for 4-8 tags that would apply to similar work in the future.');
  lines.push("");
  lines.push("Return ONLY valid JSON, no markdown fences, no prose before or after:");
  lines.push(`{
  "summary": "...",
  "narrative": "...",
  "type": "...",
  "area": "...",
  "components": ["..."],
  "approach": "...",
  "dead_ends": ["..."],
  "learnings": ["..."],
  "tags": ["..."]
}`);

  return lines.join("\n");
}

interface ClaudeOutput {
  result: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

function runClaude(prompt: string, model: string, verbose?: boolean): ClaudeOutput {
  if (verbose) process.stderr.write(`[classifier] spawning claude -p (${model})\n`);

  const result = spawnSync(
    "claude",
    ["-p", prompt, "--model", model, "--output-format", "json"],
    { encoding: "utf-8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`claude exited ${result.status}: ${(result.stderr ?? "").slice(0, 200)}`);
  }

  const raw = (result.stdout ?? "").trim();

  // Try to parse the outer claude CLI JSON envelope
  try {
    const envelope = JSON.parse(raw);
    const text: string = envelope.result ?? envelope.content ?? raw;
    const costUsd: number = envelope.total_cost_usd ?? envelope.cost_usd ?? 0;

    // Try to extract token counts if available
    const inputTokens: number = envelope.usage?.input_tokens ?? 0;
    const outputTokens: number = envelope.usage?.output_tokens ?? 0;

    return { result: text, costUsd, inputTokens, outputTokens, model };
  } catch {
    // Plain text output — no cost tracking possible
    return { result: raw, costUsd: 0, inputTokens: 0, outputTokens: 0, model };
  }
}

interface ClassifierJson {
  summary?: string;
  narrative?: string;
  type?: string;
  area?: string;
  components?: unknown[];
  approach?: string;
  dead_ends?: unknown[];
  learnings?: unknown[];
  tags?: unknown[];
}

function parseClassifierOutput(text: string): ClassifierJson {
  // Strip markdown fences if present
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  // Find JSON object in the output
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON found in output: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]) as ClassifierJson;
}

export async function classifyCommit(
  repo: SessionRepo,
  cwd: string,
  opts: ClassifyCommitOptions = {},
): Promise<ClassifyCommitResult | null> {
  const model = opts.model ?? "claude-haiku-4-5-20251001";

  // 1. Get commit info
  let commit: CommitInfo;
  try {
    commit = getCommitInfo(cwd);
  } catch (err) {
    if (opts.verbose) process.stderr.write(`[classifier] git info failed: ${err}\n`);
    return null;
  }

  if (opts.verbose) {
    process.stderr.write(`[classifier] commit ${commit.sha.slice(0, 12)}: ${commit.message}\n`);
    const fromUtc = new Date(commit.prevTimestamp ?? 0).toISOString();
    const toUtc = new Date(commit.timestamp).toISOString();
    process.stderr.write(`[classifier] window: ${fromUtc} → ${toUtc}\n`);
  }

  // 2. Ingest any recent session files for this project that haven't been captured yet.
  // The current session is still live at commit time, so the watcher may not have
  // ingested the latest turns yet. We do a force-ingest of recently modified files.
  await ingestRecentSessions(repo, cwd, commit.timestamp, opts.verbose);

  // 3. Query turns in the window — resolve the stored project_path form of cwd
  const projectPath = repo.resolveProjectPath(cwd);
  if (opts.verbose) process.stderr.write(`[classifier] project_path: ${projectPath}\n`);
  // Normalize to UTC — git outputs local time with offset (e.g. 2026-03-30T01:54-04:00)
  // but DB timestamps are UTC (2026-03-30T05:54Z). String comparison fails without this.
  const fromTs = new Date(commit.prevTimestamp ?? 0).toISOString();
  const toTs = new Date(commit.timestamp).toISOString();
  const turns = repo.getTurnsInWindow(projectPath, fromTs, toTs);

  if (turns.length === 0) {
    if (opts.verbose) process.stderr.write("[classifier] no turns in window, skipping\n");
    return null;
  }

  if (opts.verbose) process.stderr.write(`[classifier] found ${turns.length} turns in window\n`);

  // 3. Compute tool frequency mechanically before building prompt
  const toolFrequency = computeToolFrequency(turns);

  // 4. Build prompt and run classifier
  const prompt = buildPrompt(commit, turns);
  let claudeOut: ClaudeOutput;
  try {
    claudeOut = runClaude(prompt, model, opts.verbose);
  } catch (err) {
    if (opts.verbose) process.stderr.write(`[classifier] claude call failed: ${err}\n`);
    return null;
  }

  // 4. Parse output
  let parsed: ClassifierJson;
  try {
    parsed = parseClassifierOutput(claudeOut.result);
  } catch (err) {
    if (opts.verbose) process.stderr.write(`[classifier] parse failed: ${err}\nRaw: ${claudeOut.result.slice(0, 300)}\n`);
    return null;
  }

  const toStrArray = (v: unknown) =>
    Array.isArray(v) ? v.map(x => String(x)).filter(Boolean) : [];

  const summary    = String(parsed.summary ?? "").trim();
  const narrative  = String(parsed.narrative ?? "").trim();
  const type       = String(parsed.type ?? "other").trim();
  const area       = String(parsed.area ?? "").trim();
  const components = toStrArray(parsed.components);
  const approach   = String(parsed.approach ?? "").trim();
  const dead_ends  = toStrArray(parsed.dead_ends);
  const learnings  = toStrArray(parsed.learnings);
  const tags       = toStrArray(parsed.tags);

  // 5. Store work segment
  repo.insertWorkSegment({
    commit_sha: commit.sha,
    commit_message: commit.message,
    project_path: projectPath,
    changed_files: JSON.stringify(commit.changedFiles),
    from_timestamp: fromTs,
    to_timestamp: toTs,
    turn_count: turns.length,
    summary,
    narrative,
    type,
    area,
    components: JSON.stringify(components),
    approach,
    dead_ends: JSON.stringify(dead_ends),
    learnings: JSON.stringify(learnings),
    tags: JSON.stringify(tags),
    tool_frequency: JSON.stringify(toolFrequency),
    classifier_model: claudeOut.model,
    classifier_input_tokens: claudeOut.inputTokens,
    classifier_output_tokens: claudeOut.outputTokens,
    classifier_cost_usd: claudeOut.costUsd,
    created_at: new Date().toISOString(),
  });

  if (opts.verbose) {
    process.stderr.write(`[classifier] stored: ${summary}\n`);
    if (dead_ends.length > 0) process.stderr.write(`[classifier] dead ends: ${dead_ends.join("; ")}\n`);
    if (learnings.length > 0) process.stderr.write(`[classifier] learnings: ${learnings.join("; ")}\n`);
  }

  return {
    commitSha: commit.sha,
    commitMessage: commit.message,
    projectPath: projectPath,
    turnCount: turns.length,
    summary,
    type,
    area,
    tags,
    classifierModel: claudeOut.model,
    classifierInputTokens: claudeOut.inputTokens,
    classifierOutputTokens: claudeOut.outputTokens,
    classifierCostUsd: claudeOut.costUsd,
  };
}
