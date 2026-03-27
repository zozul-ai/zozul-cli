import type Database from "better-sqlite3";
import type { SessionRow, TurnRow } from "./db.js";

export class SessionRepo {
  constructor(private db: Database.Database) {}

  upsertSession(session: Omit<SessionRow, "ended_at"> & { ended_at?: string | null }): void {
    this.db.prepare(`
      INSERT INTO sessions (id, project_path, started_at, ended_at, total_input_tokens,
        total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
        total_cost_usd, total_turns, total_duration_ms, model)
      VALUES (@id, @project_path, @started_at, @ended_at, @total_input_tokens,
        @total_output_tokens, @total_cache_read_tokens, @total_cache_creation_tokens,
        @total_cost_usd, @total_turns, @total_duration_ms, @model)
      ON CONFLICT(id) DO UPDATE SET
        started_at    = MIN(started_at, @started_at),
        project_path  = COALESCE(@project_path, project_path),
        ended_at      = COALESCE(@ended_at, ended_at),
        total_turns   = @total_turns,
        model         = COALESCE(@model, model),
        -- Use MAX so that OTEL-accumulated values are never clobbered by a JSONL re-ingest
        total_input_tokens          = MAX(total_input_tokens, @total_input_tokens),
        total_output_tokens         = MAX(total_output_tokens, @total_output_tokens),
        total_cache_read_tokens     = MAX(total_cache_read_tokens, @total_cache_read_tokens),
        total_cache_creation_tokens = MAX(total_cache_creation_tokens, @total_cache_creation_tokens),
        total_cost_usd              = MAX(total_cost_usd, @total_cost_usd),
        total_duration_ms           = MAX(total_duration_ms, @total_duration_ms)
    `).run({
      ...session,
      ended_at: session.ended_at ?? null,
    });
  }

  /**
   * Accumulate metric deltas from a single OTEL export batch into the sessions row.
   * Creates a stub session row if none exists yet (OTEL may arrive before JSONL ingest).
   * All numeric fields are additive deltas — never a full replacement.
   */
  updateSessionFromOtel(sessionId: string, deltas: {
    costDelta: number;
    inputDelta: number;
    outputDelta: number;
    cacheReadDelta: number;
    cacheCreationDelta: number;
    durationMsDelta: number;
    latestTimestamp: string;
    model: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO sessions (id, started_at, ended_at, total_cost_usd, total_input_tokens,
        total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
        total_duration_ms, model)
      VALUES (@id, @ts, @ts, @cost, @input, @output, @cache_read, @cache_creation, @duration_ms, @model)
      ON CONFLICT(id) DO UPDATE SET
        total_cost_usd              = total_cost_usd + @cost,
        total_input_tokens          = total_input_tokens + @input,
        total_output_tokens         = total_output_tokens + @output,
        total_cache_read_tokens     = total_cache_read_tokens + @cache_read,
        total_cache_creation_tokens = total_cache_creation_tokens + @cache_creation,
        total_duration_ms           = total_duration_ms + @duration_ms,
        ended_at = CASE WHEN @ts > COALESCE(ended_at, '') THEN @ts ELSE ended_at END,
        model    = COALESCE(@model, model)
    `).run({
      id:          sessionId,
      ts:          deltas.latestTimestamp,
      cost:        deltas.costDelta,
      input:       deltas.inputDelta,
      output:      deltas.outputDelta,
      cache_read:  deltas.cacheReadDelta,
      cache_creation: deltas.cacheCreationDelta,
      duration_ms: deltas.durationMsDelta,
      model:       deltas.model,
    });
  }

  insertTurn(turn: Omit<TurnRow, "id">): number {
    // Use RETURNING so we get the correct id on both INSERT and ON CONFLICT UPDATE
    const row = this.db.prepare(`
      INSERT INTO turns (session_id, turn_index, role, timestamp, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, model, content_text, tool_calls, is_real_user)
      VALUES (@session_id, @turn_index, @role, @timestamp, @input_tokens, @output_tokens,
        @cache_read_tokens, @cache_creation_tokens, @cost_usd, @duration_ms, @model, @content_text, @tool_calls, @is_real_user)
      ON CONFLICT(session_id, turn_index) DO UPDATE SET
        content_text = @content_text,
        tool_calls = @tool_calls,
        input_tokens = @input_tokens,
        output_tokens = @output_tokens,
        cost_usd = MAX(cost_usd, @cost_usd),
        duration_ms = MAX(duration_ms, @duration_ms),
        is_real_user = @is_real_user
      RETURNING id
    `).get(turn) as { id: number } | undefined;
    return row?.id ?? 0;
  }

  insertToolUse(toolUse: {
    session_id: string;
    turn_id: number | null;
    tool_name: string;
    tool_input: string | null;
    tool_result: string | null;
    success: number | null;
    duration_ms: number;
    timestamp: string;
  }): void {
    this.db.prepare(`
      INSERT INTO tool_uses (session_id, turn_id, tool_name, tool_input, tool_result, success, duration_ms, timestamp)
      VALUES (@session_id, @turn_id, @tool_name, @tool_input, @tool_result, @success, @duration_ms, @timestamp)
    `).run(toolUse);
  }

  /**
   * Replace all tool uses for a given turn in a single transaction.
   * Deletes existing rows first to prevent duplication on re-ingest.
   */
  replaceToolUsesForTurn(turnId: number, toolUses: {
    session_id: string;
    turn_id: number | null;
    tool_name: string;
    tool_input: string | null;
    tool_result: string | null;
    success: number | null;
    duration_ms: number;
    timestamp: string;
  }[]): void {
    const del = this.db.prepare(`DELETE FROM tool_uses WHERE turn_id = ?`);
    const ins = this.db.prepare(`
      INSERT INTO tool_uses (session_id, turn_id, tool_name, tool_input, tool_result, success, duration_ms, timestamp)
      VALUES (@session_id, @turn_id, @tool_name, @tool_input, @tool_result, @success, @duration_ms, @timestamp)
    `);
    this.db.transaction(() => {
      del.run(turnId);
      for (const row of toolUses) ins.run(row);
    })();
  }

  insertHookEvent(event: {
    session_id: string | null;
    event_name: string;
    timestamp: string;
    payload: string;
  }): void {
    this.db.prepare(`
      INSERT INTO hook_events (session_id, event_name, timestamp, payload)
      VALUES (@session_id, @event_name, @timestamp, @payload)
    `).run(event);
  }

  listSessions(limit = 50, offset = 0): SessionRow[] {
    return this.db.prepare(`
      SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as SessionRow[];
  }

  countSessions(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM sessions`).get() as { n: number };
    return row.n;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  }

  getSessionTurns(sessionId: string): TurnRow[] {
    return this.db.prepare(`
      SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC
    `).all(sessionId) as TurnRow[];
  }

  getSessionToolUses(sessionId: string) {
    return this.db.prepare(`
      SELECT * FROM tool_uses WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sessionId);
  }

  getSessionHookEvents(sessionId: string) {
    return this.db.prepare(`
      SELECT * FROM hook_events WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sessionId);
  }

  getAggregateStats() {
    return this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions) as total_sessions,
        (SELECT SUM(total_input_tokens)          FROM sessions) as total_input_tokens,
        (SELECT SUM(total_output_tokens)         FROM sessions) as total_output_tokens,
        (SELECT SUM(total_cache_read_tokens)     FROM sessions) as total_cache_read_tokens,
        (SELECT SUM(total_cost_usd)              FROM sessions) as total_cost_usd,
        (SELECT SUM(total_turns)                 FROM sessions) as total_turns,
        (SELECT SUM(total_duration_ms)           FROM sessions) as total_duration_ms,
        (SELECT COUNT(*) FROM hook_events WHERE event_name = 'UserPromptSubmit') as total_user_prompts,
        (SELECT COUNT(*) FROM hook_events WHERE event_name = 'Stop') as total_interruptions
    `).get();
  }

  // ── OTEL data ──

  insertOtelMetric(metric: {
    name: string;
    value: number;
    attributes: string | null;
    session_id: string | null;
    model: string | null;
    timestamp: string;
  }): void {
    this.db.prepare(`
      INSERT INTO otel_metrics (name, value, attributes, session_id, model, timestamp)
      VALUES (@name, @value, @attributes, @session_id, @model, @timestamp)
    `).run(metric);
  }

  insertOtelMetricBatch(metrics: {
    name: string;
    value: number;
    attributes: string | null;
    session_id: string | null;
    model: string | null;
    timestamp: string;
  }[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO otel_metrics (name, value, attributes, session_id, model, timestamp)
      VALUES (@name, @value, @attributes, @session_id, @model, @timestamp)
    `);
    const tx = this.db.transaction((rows: typeof metrics) => {
      for (const row of rows) stmt.run(row);
    });
    tx(metrics);
  }

  insertOtelEvent(event: {
    event_name: string;
    attributes: string | null;
    session_id: string | null;
    prompt_id: string | null;
    timestamp: string;
  }): void {
    this.db.prepare(`
      INSERT INTO otel_events (event_name, attributes, session_id, prompt_id, timestamp)
      VALUES (@event_name, @attributes, @session_id, @prompt_id, @timestamp)
    `).run(event);
  }

  insertOtelEventBatch(events: {
    event_name: string;
    attributes: string | null;
    session_id: string | null;
    prompt_id: string | null;
    timestamp: string;
  }[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO otel_events (event_name, attributes, session_id, prompt_id, timestamp)
      VALUES (@event_name, @attributes, @session_id, @prompt_id, @timestamp)
    `);
    const tx = this.db.transaction((rows: typeof events) => {
      for (const row of rows) stmt.run(row);
    });
    tx(events);
  }

  // ── Dashboard queries ──

  getTokenTimeSeries(from: string, to: string, stepSeconds: number): { timestamp: string; input: number; output: number; cache_read: number }[] {
    return this.db.prepare(`
      SELECT
        datetime((CAST(strftime('%s', timestamp) AS INTEGER) / CAST(? AS INTEGER)) * CAST(? AS INTEGER), 'unixepoch') as timestamp,
        SUM(CASE WHEN json_extract(attributes, '$.type') = 'input' THEN value ELSE 0 END) as input,
        SUM(CASE WHEN json_extract(attributes, '$.type') = 'output' THEN value ELSE 0 END) as output,
        SUM(CASE WHEN json_extract(attributes, '$.type') = 'cacheRead' THEN value ELSE 0 END) as cache_read
      FROM otel_metrics
      WHERE name = 'claude_code.token.usage'
        AND timestamp >= ? AND timestamp <= ?
      GROUP BY 1
      ORDER BY 1 ASC
    `).all(stepSeconds, stepSeconds, from, to) as { timestamp: string; input: number; output: number; cache_read: number }[];
  }

  getCostTimeSeries(from: string, to: string, stepSeconds: number): { timestamp: string; cost: number }[] {
    return this.db.prepare(`
      SELECT
        datetime((CAST(strftime('%s', timestamp) AS INTEGER) / CAST(? AS INTEGER)) * CAST(? AS INTEGER), 'unixepoch') as timestamp,
        SUM(value) as cost
      FROM otel_metrics
      WHERE name = 'claude_code.cost.usage'
        AND timestamp >= ? AND timestamp <= ?
      GROUP BY 1
      ORDER BY 1 ASC
    `).all(stepSeconds, stepSeconds, from, to) as { timestamp: string; cost: number }[];
  }

  getToolUsageBreakdown(): { tool_name: string; count: number }[] {
    return this.db.prepare(`
      SELECT tool_name, COUNT(*) as count
      FROM tool_uses
      GROUP BY tool_name
      ORDER BY count DESC
      LIMIT 20
    `).all() as { tool_name: string; count: number }[];
  }

  getModelBreakdown(): { model: string; cost: number; tokens: number }[] {
    return this.db.prepare(`
      SELECT
        model,
        SUM(CASE WHEN name = 'claude_code.cost.usage' THEN value ELSE 0 END) as cost,
        SUM(CASE WHEN name = 'claude_code.token.usage' THEN value ELSE 0 END) as tokens
      FROM otel_metrics
      WHERE model IS NOT NULL
      GROUP BY model
      ORDER BY cost DESC
    `).all() as { model: string; cost: number; tokens: number }[];
  }

  getRecentOtelEvents(limit = 50): { event_name: string; attributes: string | null; session_id: string | null; prompt_id: string | null; timestamp: string }[] {
    return this.db.prepare(`
      SELECT event_name, attributes, session_id, prompt_id, timestamp
      FROM otel_events
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as { event_name: string; attributes: string | null; session_id: string | null; prompt_id: string | null; timestamp: string }[];
  }

  // ── Task tags ──

  tagTurn(turnId: number, task: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO task_tags (turn_id, task, tagged_at)
      VALUES (?, ?, ?)
    `).run(turnId, task, new Date().toISOString());
  }

  tagTurnsBatch(turnIds: number[], task: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO task_tags (turn_id, task, tagged_at)
      VALUES (?, ?, ?)
    `);
    const taggedAt = new Date().toISOString();
    this.db.transaction(() => {
      for (const turnId of turnIds) stmt.run(turnId, task, taggedAt);
    })();
  }

  getTasksForTurn(turnId: number): string[] {
    const rows = this.db.prepare(`
      SELECT task FROM task_tags WHERE turn_id = ? ORDER BY tagged_at ASC
    `).all(turnId) as { task: string }[];
    return rows.map(r => r.task);
  }

  getTurnsByTask(task: string, limit = 50, offset = 0): TurnRow[] {
    return this.db.prepare(`
      SELECT t.* FROM turns t
      JOIN task_tags tt ON tt.turn_id = t.id
      WHERE tt.task = ?
      ORDER BY t.timestamp DESC
      LIMIT ? OFFSET ?
    `).all(task, limit, offset) as TurnRow[];
  }

  getTaggedTurns(opts: {
    tags?: string[];
    mode?: "all" | "any";
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}): (TurnRow & { tags: string; block_input_tokens: number; block_output_tokens: number; block_cost_usd: number })[] {
    const { tags, mode = "any", from, to, limit = 50, offset = 0 } = opts;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (tags && tags.length > 0) {
      const placeholders = tags.map(() => "?").join(",");
      if (mode === "all" && tags.length > 1) {
        conditions.push(`t.id IN (
          SELECT turn_id FROM task_tags WHERE task IN (${placeholders})
          GROUP BY turn_id HAVING COUNT(DISTINCT task) = ?
        )`);
        params.push(...tags, tags.length);
      } else {
        conditions.push(`t.id IN (SELECT DISTINCT turn_id FROM task_tags WHERE task IN (${placeholders}))`);
        params.push(...tags);
      }
    } else {
      conditions.push("t.id IN (SELECT DISTINCT turn_id FROM task_tags)");
    }

    if (from && to) {
      conditions.push("t.timestamp >= ? AND t.timestamp <= ?");
      params.push(from, to);
    }

    // Only show real user turns (each row = one interaction block)
    conditions.push("t.is_real_user = 1");

    const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
    params.push(limit, offset);

    // Aggregate block stats: sum tokens/cost from this turn to the next real user turn
    return this.db.prepare(`
      SELECT t.*,
        (SELECT GROUP_CONCAT(tt2.task, ', ') FROM task_tags tt2 WHERE tt2.turn_id = t.id) as tags,
        (SELECT COALESCE(SUM(b.input_tokens), 0) FROM turns b
         WHERE b.session_id = t.session_id AND b.turn_index >= t.turn_index
           AND b.turn_index < COALESCE(
             (SELECT MIN(n.turn_index) FROM turns n WHERE n.session_id = t.session_id AND n.turn_index > t.turn_index AND n.is_real_user = 1),
             999999)
        ) as block_input_tokens,
        (SELECT COALESCE(SUM(b.output_tokens), 0) FROM turns b
         WHERE b.session_id = t.session_id AND b.turn_index >= t.turn_index
           AND b.turn_index < COALESCE(
             (SELECT MIN(n.turn_index) FROM turns n WHERE n.session_id = t.session_id AND n.turn_index > t.turn_index AND n.is_real_user = 1),
             999999)
        ) as block_output_tokens,
        (SELECT COALESCE(SUM(b.cost_usd), 0) FROM turns b
         WHERE b.session_id = t.session_id AND b.turn_index >= t.turn_index
           AND b.turn_index < COALESCE(
             (SELECT MIN(n.turn_index) FROM turns n WHERE n.session_id = t.session_id AND n.turn_index > t.turn_index AND n.is_real_user = 1),
             999999)
        ) as block_cost_usd
      FROM turns t
      ${where}
      ORDER BY t.timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...params) as (TurnRow & { tags: string; block_input_tokens: number; block_output_tokens: number; block_cost_usd: number })[];
  }

  getTurnBlock(turnId: number): TurnRow[] {
    const turn = this.db.prepare(`SELECT * FROM turns WHERE id = ?`).get(turnId) as TurnRow | undefined;
    if (!turn) return [];

    // Find the next real user turn in the same session
    const nextRealUser = this.db.prepare(`
      SELECT turn_index FROM turns
      WHERE session_id = ? AND turn_index > ? AND is_real_user = 1
      ORDER BY turn_index ASC LIMIT 1
    `).get(turn.session_id, turn.turn_index) as { turn_index: number } | undefined;

    const maxIndex = nextRealUser ? nextRealUser.turn_index : 999999;

    return this.db.prepare(`
      SELECT * FROM turns
      WHERE session_id = ? AND turn_index >= ? AND turn_index < ?
      ORDER BY turn_index ASC
    `).all(turn.session_id, turn.turn_index, maxIndex) as TurnRow[];
  }

  getStatsByTask(task: string, from?: string, to?: string) {
    const timeFilter = from && to ? " AND t.timestamp >= ? AND t.timestamp <= ?" : "";
    const params: unknown[] = [task];
    if (from && to) params.push(from, to);
    return this.db.prepare(`
      SELECT
        COUNT(*) as total_turns,
        SUM(t.is_real_user) as user_turns,
        SUM(t.input_tokens) as total_input_tokens,
        SUM(t.output_tokens) as total_output_tokens,
        SUM(t.cache_read_tokens) as total_cache_read_tokens,
        SUM(t.cost_usd) as total_cost_usd,
        SUM(t.duration_ms) as total_duration_ms
      FROM turns t
      JOIN task_tags tt ON tt.turn_id = t.id
      WHERE tt.task = ?${timeFilter}
    `).get(...params);
  }

  getStatsByTasks(tasks: string[], mode: "all" | "any" = "all", from?: string, to?: string) {
    if (tasks.length === 0) return null;
    if (tasks.length === 1) return this.getStatsByTask(tasks[0], from, to);
    const placeholders = tasks.map(() => "?").join(",");
    const timeFilter = from && to ? " AND t.timestamp >= ? AND t.timestamp <= ?" : "";
    const timeParams: unknown[] = from && to ? [from, to] : [];
    if (mode === "any") {
      return this.db.prepare(`
        SELECT
          COUNT(DISTINCT t.id) as total_turns,
          SUM(t.is_real_user) as user_turns,
          SUM(t.input_tokens) as total_input_tokens,
          SUM(t.output_tokens) as total_output_tokens,
          SUM(t.cache_read_tokens) as total_cache_read_tokens,
          SUM(t.cost_usd) as total_cost_usd,
          SUM(t.duration_ms) as total_duration_ms
        FROM turns t
        WHERE t.id IN (
          SELECT DISTINCT turn_id FROM task_tags WHERE task IN (${placeholders})
        )${timeFilter}
      `).get(...tasks, ...timeParams);
    }
    return this.db.prepare(`
      SELECT
        COUNT(*) as total_turns,
        SUM(t.is_real_user) as user_turns,
        SUM(t.input_tokens) as total_input_tokens,
        SUM(t.output_tokens) as total_output_tokens,
        SUM(t.cache_read_tokens) as total_cache_read_tokens,
        SUM(t.cost_usd) as total_cost_usd,
        SUM(t.duration_ms) as total_duration_ms
      FROM turns t
      WHERE t.id IN (
        SELECT turn_id FROM task_tags
        WHERE task IN (${placeholders})
        GROUP BY turn_id
        HAVING COUNT(DISTINCT task) = ?
      )${timeFilter}
    `).get(...tasks, tasks.length, ...timeParams);
  }

  listTasks(): { task: string; turn_count: number; first_tagged: string; last_tagged: string }[] {
    return this.db.prepare(`
      SELECT task, COUNT(*) as turn_count,
        MIN(tagged_at) as first_tagged, MAX(tagged_at) as last_tagged
      FROM task_tags
      GROUP BY task
      ORDER BY last_tagged DESC
    `).all() as { task: string; turn_count: number; first_tagged: string; last_tagged: string }[];
  }
}
