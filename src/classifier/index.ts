import { execSync, spawnSync } from "node:child_process";
import type { SessionRepo } from "../storage/repo.js";
import type { TurnRow } from "../storage/db.js";

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
}

function getCommitInfo(cwd: string): CommitInfo {
  // Get last 2 commits: sha, ISO timestamp, subject
  const log = execSync(
    "git log -2 --format=%H%x00%aI%x00%s",
    { cwd, encoding: "utf-8" }
  ).trim();

  const lines = log.split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("No commits found");

  const [sha, timestamp, message] = lines[0].split("\x00");
  const prevTimestamp = lines.length > 1 ? lines[1].split("\x00")[1] : null;

  let changedFiles: string[] = [];
  try {
    const diff = execSync("git diff HEAD~1 HEAD --name-only", { cwd, encoding: "utf-8" }).trim();
    changedFiles = diff ? diff.split("\n").filter(Boolean) : [];
  } catch {
    // First commit or shallow clone — skip
  }

  return { sha, message, timestamp, prevTimestamp, changedFiles };
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  // Return a compact representation of the tool call for the prompt
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path ?? input.path ?? "").slice(0, 80);
    case "Bash":
      return String(input.command ?? "").slice(0, 80);
    case "Grep":
      return `"${String(input.pattern ?? "").slice(0, 40)}"${input.path ? ` in ${String(input.path).slice(0, 40)}` : ""}`;
    case "Glob":
      return String(input.pattern ?? "").slice(0, 60);
    case "WebSearch":
      return String(input.query ?? "").slice(0, 60);
    case "WebFetch":
      return String(input.url ?? "").slice(0, 60);
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

function buildPrompt(commit: CommitInfo, turns: TurnRow[]): string {
  const lines: string[] = [];

  lines.push("You are classifying a block of Claude Code work that occurred between two git commits.");
  lines.push("");
  lines.push("## Commit");
  lines.push(`SHA: ${commit.sha.slice(0, 12)}`);
  lines.push(`Message: ${commit.message}`);
  if (commit.changedFiles.length > 0) {
    lines.push("Changed files:");
    for (const f of commit.changedFiles.slice(0, 20)) {
      lines.push(`  - ${f}`);
    }
  }
  lines.push("");
  lines.push(`## Work Session (${turns.length} turns)`);
  lines.push("");

  // Group turns into interaction blocks: real user turn + following assistant turns
  let i = 0;
  let blockCount = 0;
  while (i < turns.length && blockCount < 30) {
    const turn = turns[i];

    if (turn.is_real_user) {
      const text = (turn.content_text ?? "").trim().slice(0, 200);
      if (text) lines.push(`User: "${text}"`);
      i++;

      // Gather following assistant turns
      const toolNames: string[] = [];
      const reasoningParts: string[] = [];

      while (i < turns.length && !turns[i].is_real_user) {
        const t = turns[i];
        if (t.role === "assistant") {
          // Collect tool calls (name + input only, no result)
          if (t.tool_calls) {
            try {
              const calls = JSON.parse(t.tool_calls) as { toolName: string; toolInput: Record<string, unknown> }[];
              for (const c of calls) {
                const formatted = formatToolInput(c.toolName, c.toolInput ?? {});
                toolNames.push(`${c.toolName}(${formatted})`);
              }
            } catch { /* skip */ }
          }
          // Collect brief reasoning text
          const txt = (t.content_text ?? "").trim();
          if (txt && reasoningParts.length < 2) {
            reasoningParts.push(txt.slice(0, 150));
          }
        }
        i++;
      }

      if (toolNames.length > 0) {
        lines.push(`Claude used: ${toolNames.slice(0, 12).join(", ")}`);
      }
      if (reasoningParts.length > 0) {
        for (const r of reasoningParts) {
          lines.push(`Claude said: "${r}"`);
        }
      }
      lines.push("");
      blockCount++;
    } else {
      i++;
    }
  }

  lines.push("## Task");
  lines.push("Return ONLY valid JSON, no markdown fences, no explanation:");
  lines.push(`{"summary":"one sentence describing what was accomplished","type":"bugfix|feature|refactor|exploration|docs|other","area":"primary module or concern (short)","tags":["tag1","tag2"]}`);

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
  type?: string;
  area?: string;
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
    process.stderr.write(`[classifier] window: ${commit.prevTimestamp ?? "beginning"} → ${commit.timestamp}\n`);
  }

  // 2. Query turns in the window — resolve the stored project_path form of cwd
  const projectPath = repo.resolveProjectPath(cwd);
  if (opts.verbose) process.stderr.write(`[classifier] project_path: ${projectPath}\n`);
  const fromTs = commit.prevTimestamp ?? new Date(0).toISOString();
  const turns = repo.getTurnsInWindow(projectPath, fromTs, commit.timestamp);

  if (turns.length === 0) {
    if (opts.verbose) process.stderr.write("[classifier] no turns in window, skipping\n");
    return null;
  }

  if (opts.verbose) process.stderr.write(`[classifier] found ${turns.length} turns in window\n`);

  // 3. Build prompt and run classifier
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

  const summary = String(parsed.summary ?? "").trim();
  const type = String(parsed.type ?? "other").trim();
  const area = String(parsed.area ?? "").trim();
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map(t => String(t)).filter(Boolean)
    : [];

  // 5. Store work segment
  repo.insertWorkSegment({
    commit_sha: commit.sha,
    commit_message: commit.message,
    project_path: projectPath,
    changed_files: JSON.stringify(commit.changedFiles),
    from_timestamp: fromTs,
    to_timestamp: commit.timestamp,
    turn_count: turns.length,
    summary,
    type,
    area,
    tags: JSON.stringify(tags),
    classifier_model: claudeOut.model,
    classifier_input_tokens: claudeOut.inputTokens,
    classifier_output_tokens: claudeOut.outputTokens,
    classifier_cost_usd: claudeOut.costUsd,
    created_at: new Date().toISOString(),
  });

  if (opts.verbose) {
    process.stderr.write(`[classifier] stored: ${summary}\n`);
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
