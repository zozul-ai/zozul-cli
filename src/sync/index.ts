import type { SessionRow } from "../storage/db.js";
import type { SessionRepo } from "../storage/repo.js";
import type { ZozulApiClient } from "./client.js";
import {
  transformSession, transformTurn, transformToolUse,
  transformHookEvent, transformTaskTag,
  transformOtelMetric, transformOtelEvent,
  type TurnLookup, type SessionSyncPayload,
} from "./transform.js";

const BATCH_SIZE = 500;

export interface SyncCounts {
  synced: number;
  failed: number;
}

export interface SyncResult {
  sessions: SyncCounts;
  otel_metrics: SyncCounts;
  otel_events: SyncCounts;
}

interface SyncOptions {
  verbose?: boolean;
  dryRun?: boolean;
}

function zeroCounts(): SyncCounts {
  return { synced: 0, failed: 0 };
}

/**
 * Build the sync payload for a single session — gathers all child entities
 * (turns, tool_uses, hook_events, task_tags) and transforms them.
 */
function buildSessionPayload(
  repo: SessionRepo,
  session: SessionRow,
): SessionSyncPayload {
  const turns = repo.getSessionTurns(session.id);
  const toolUses = repo.getSessionToolUses(session.id) as import("../storage/db.js").ToolUseRow[];
  const hookEvents = repo.getSessionHookEvents(session.id) as import("../storage/db.js").HookEventRow[];

  // Build turn_id → turn_index lookup for this session
  const turnLookup: TurnLookup = new Map(turns.map(t => [t.id, t.turn_index]));

  // Get task tags for all turns in this session
  const taskTags: import("../storage/db.js").TaskTagRow[] = [];
  for (const turn of turns) {
    const tags = repo.getTaskTagsForTurn(turn.id);
    taskTags.push(...tags);
  }

  return {
    session: transformSession(session),
    turns: turns.map(transformTurn),
    tool_uses: toolUses.map(row => transformToolUse(row, turnLookup)),
    task_tags: taskTags.map(row => transformTaskTag(row, turnLookup)),
    hook_events: hookEvents.map(transformHookEvent),
  };
}

export async function runSync(
  repo: SessionRepo,
  client: ZozulApiClient,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    sessions: zeroCounts(),
    otel_metrics: zeroCounts(),
    otel_events: zeroCounts(),
  };

  // ── Phase 1: Determine sessions to sync ──
  const sessionsWatermark = repo.getSyncWatermark("sessions");
  const turnsWatermark = repo.getSyncWatermark("turns");

  // New sessions (by rowid)
  const newSessions = repo.getUnsyncedSessions(sessionsWatermark);
  const sessionIdsToSync = new Set(newSessions.map(s => s.id));

  // Sessions with new turns
  const peekTurns = repo.getTurnsAfter(turnsWatermark, BATCH_SIZE);
  for (const t of peekTurns) sessionIdsToSync.add(t.session_id);

  // ── Phase 2: Sync sessions (one request per session, includes all child data) ──
  if (sessionIdsToSync.size > 0) {
    const idsFromTurns = [...sessionIdsToSync].filter(id => !newSessions.some(s => s.id === id));
    const extraSessions = repo.getSessionsByIds(idsFromTurns);
    const allSessions = [...newSessions, ...extraSessions];

    let maxSyncedRowid = sessionsWatermark;
    let maxSyncedTurnId = turnsWatermark;

    for (const session of allSessions) {
      if (opts.dryRun) {
        result.sessions.synced++;
        continue;
      }

      const payload = buildSessionPayload(repo, session);

      try {
        const resp = await client.syncSession(session.id, payload);
        result.sessions.synced++;

        // Track watermarks
        const rowid = (session as { _rowid?: number })._rowid;
        if (rowid != null && rowid > maxSyncedRowid) maxSyncedRowid = rowid;

        // Track max turn id for this session's turns
        const sessionTurns = repo.getSessionTurns(session.id);
        for (const t of sessionTurns) {
          if (t.id > maxSyncedTurnId) maxSyncedTurnId = t.id;
        }

        if (opts.verbose) {
          console.log(
            `  ${session.id}: ${resp.turns_synced} turns, ` +
            `${resp.tool_uses_synced} tool_uses, ${resp.task_tags_synced} tags, ` +
            `${resp.hook_events_synced} hook_events`
          );
        }
      } catch (err) {
        result.sessions.failed++;
        if (opts.verbose) {
          console.error(`  ${session.id}: failed — ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    if (!opts.dryRun) {
      if (maxSyncedRowid > sessionsWatermark) {
        repo.setSyncWatermark("sessions", maxSyncedRowid);
      }
      if (maxSyncedTurnId > turnsWatermark) {
        repo.setSyncWatermark("turns", maxSyncedTurnId);
      }
    }
  }

  // ── Phase 3: Sync OTel data (not session-scoped, uses separate bulk endpoints) ──
  result.otel_metrics = await syncBulkTable(
    "otel_metrics", repo,
    (minId, limit) => repo.getOtelMetricsAfter(minId, limit),
    transformOtelMetric,
    (items) => client.postOtelMetricsBulk(items),
    opts,
  );

  result.otel_events = await syncBulkTable(
    "otel_events", repo,
    (minId, limit) => repo.getOtelEventsAfter(minId, limit),
    transformOtelEvent,
    (items) => client.postOtelEventsBulk(items),
    opts,
  );

  return result;
}

/**
 * Generic helper for append-only bulk tables (otel_metrics, otel_events).
 */
async function syncBulkTable<TRow extends { id: number }, TApi>(
  tableName: string,
  repo: SessionRepo,
  readAfter: (minId: number, limit: number) => TRow[],
  transform: (row: TRow) => TApi,
  postBulk: (items: TApi[]) => Promise<void>,
  opts: SyncOptions,
): Promise<SyncCounts> {
  const counts = zeroCounts();
  let watermark = repo.getSyncWatermark(tableName);

  for (;;) {
    const rows = readAfter(watermark, BATCH_SIZE);
    if (rows.length === 0) break;

    if (opts.dryRun) {
      counts.synced += rows.length;
      watermark = rows[rows.length - 1].id;
      continue;
    }

    const payload = rows.map(transform);
    try {
      await postBulk(payload);
      const newWatermark = rows[rows.length - 1].id;
      repo.setSyncWatermark(tableName, newWatermark);
      watermark = newWatermark;
      counts.synced += rows.length;
      if (opts.verbose) {
        console.log(`  ${tableName}: synced ${rows.length} rows (watermark → ${newWatermark})`);
      }
    } catch (err) {
      counts.failed += rows.length;
      if (opts.verbose) {
        console.error(`  ${tableName}: batch failed — ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
  }

  return counts;
}
