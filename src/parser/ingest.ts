import type { SessionRepo } from "../storage/repo.js";
import { discoverSessionFiles, parseSessionFile } from "./jsonl.js";
import type { ParsedSession } from "./types.js";
import { getActiveContext } from "../context/index.js";

/**
 * Ingest all discovered session JSONL files into the database.
 * Skips sessions that already exist unless force=true.
 */
export async function ingestAllSessions(
  repo: SessionRepo,
  opts: { force?: boolean; noTag?: boolean } = {},
): Promise<{ ingested: number; skipped: number }> {
  const files = discoverSessionFiles();
  let ingested = 0;
  let skipped = 0;

  for (const { filePath, projectPath } of files) {
    const parsed = await parseSessionFile(filePath, projectPath);

    if (!opts.force) {
      const existing = repo.getSession(parsed.sessionId);
      if (existing) {
        skipped++;
        continue;
      }
    }

    persistSession(repo, parsed, { noTag: opts.noTag });
    ingested++;
  }

  return { ingested, skipped };
}

/**
 * Ingest a single session file by path.
 */
export async function ingestSessionFile(
  repo: SessionRepo,
  filePath: string,
  projectPath?: string,
  opts: { noTag?: boolean } = {},
): Promise<ParsedSession> {
  const parsed = await parseSessionFile(filePath, projectPath);
  persistSession(repo, parsed, opts);
  return parsed;
}

function persistSession(repo: SessionRepo, parsed: ParsedSession, opts: { noTag?: boolean } = {}): void {
  repo.upsertSession({
    id: parsed.sessionId,
    project_path: parsed.projectPath,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt,
    total_input_tokens: parsed.totalInputTokens,
    total_output_tokens: parsed.totalOutputTokens,
    total_cache_read_tokens: parsed.totalCacheReadTokens,
    total_cache_creation_tokens: parsed.totalCacheCreationTokens,
    total_cost_usd: parsed.totalCostUsd,
    total_turns: parsed.turns.length,
    total_duration_ms: parsed.totalDurationMs,
    model: parsed.model,
  });

  const turnIds: number[] = [];

  for (const turn of parsed.turns) {
    const turnId = repo.insertTurn({
      session_id: parsed.sessionId,
      turn_index: turn.turnIndex,
      role: turn.role,
      timestamp: turn.timestamp,
      input_tokens: turn.inputTokens,
      output_tokens: turn.outputTokens,
      cache_read_tokens: turn.cacheReadTokens,
      cache_creation_tokens: turn.cacheCreationTokens,
      cost_usd: turn.costUsd,
      duration_ms: turn.durationMs,
      model: turn.model,
      content_text: turn.contentText,
      tool_calls: turn.toolCalls.length > 0 ? JSON.stringify(turn.toolCalls) : null,
      is_real_user: turn.isRealUser ? 1 : 0,
    });

    turnIds.push(turnId);

    if (turn.toolCalls.length > 0) {
      // Replace tool uses for this turn atomically to avoid duplicates on re-ingest
      repo.replaceToolUsesForTurn(turnId, turn.toolCalls.map(tc => ({
        session_id: parsed.sessionId,
        turn_id: turnId,
        tool_name: tc.toolName,
        tool_input: JSON.stringify(tc.toolInput),
        tool_result: tc.toolResult ?? null,
        success: null,
        duration_ms: 0,
        timestamp: turn.timestamp,
      })));
    }
  }

  if (!opts.noTag) {
    const context = getActiveContext();
    if (context?.active && context.active.length > 0 && turnIds.length > 0) {
      // Only tag turns that occurred after the context was set
      const contextTime = context.set_at ? new Date(context.set_at).getTime() : 0;
      const eligibleIds = turnIds.filter((_, i) => {
        const turnTime = new Date(parsed.turns[i].timestamp).getTime();
        return turnTime >= contextTime;
      });
      if (eligibleIds.length > 0) {
        for (const tag of context.active) {
          repo.tagTurnsBatch(eligibleIds, tag);
        }
      }
    }
  }
}
