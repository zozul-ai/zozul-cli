# Development & Agent Context

This document is the running reference for anyone (human or agent) picking up work on this codebase. It captures non-obvious design decisions, current state, known issues, and how to orient yourself quickly.

---

## Project overview

zozul-cli is a local observability sidecar for Claude Code. It ingests data from three sources (OTEL, hooks, JSONL), stores everything in SQLite, and serves a dashboard + JSON API. Single process, no external services.

---

## Source layout

```
src/
  index.ts              Entry point — loads .env, runs CLI
  cli/
    commands.ts         All CLI commands (serve, install, ingest, etc.)
    format.ts           Terminal output formatters
  storage/
    db.ts               SQLite setup, schema migration, row types
    repo.ts             All DB queries — SessionRepo class
  hooks/
    server.ts           HTTP server: hook handler, API routes, OTEL receiver dispatch
    config.ts           Read/write ~/.claude/settings.json for hooks
  otel/
    receiver.ts         Parse OTLP JSON payloads → DB + session accumulation
    config.ts           Read/write ~/.claude/settings.json for OTEL env vars
  parser/
    jsonl.ts            Discover and parse Claude Code session JSONL files
    ingest.ts           Persist parsed sessions/turns/tool_uses to DB
    watcher.ts          fs.watch on ~/.claude/projects, debounced ingest
    types.ts            JSONL type definitions
  dashboard/
    index.html          Dashboard SPA (vanilla JS, Chart.js from CDN)
    html.ts             Reads and serves index.html (thin wrapper)
  service/
    index.ts            Install/uninstall as launchd (macOS) or systemd (Linux) service
```

Build output goes to `dist/`. The build script also copies `src/dashboard/index.html` → `dist/dashboard/index.html`.

---

## Data flow

### OTEL (metrics + logs)

Claude Code sends OTLP JSON to `POST /v1/metrics` and `POST /v1/logs` on a configurable interval (default: 60s metrics, 5s logs).

**Important**: values are **deltas per export window**, not cumulative totals. Each batch represents tokens/cost/time accrued since the last export.

Flow:
1. `hooks/server.ts` receives POST, reads body (50MB cap)
2. Calls `handleOtlpMetrics` / `handleOtlpLogs` in `otel/receiver.ts`
3. Receiver builds a flat batch, inserts into `otel_metrics` / `otel_events`
4. Receiver also aggregates per-session deltas from the batch and calls `repo.updateSessionFromOtel()` for each session seen
5. `updateSessionFromOtel` does an accumulating UPSERT: `total_cost_usd += delta`, `total_*_tokens += delta`, `total_duration_ms += delta`, `ended_at = MAX(...)`

Key metric names from Claude Code:
- `claude_code.token.usage` — attribute `type` is `input` / `output` / `cacheRead` / `cacheCreation`
- `claude_code.cost.usage` — USD, no type attribute
- `claude_code.active_time.total` — seconds of active use
- `claude_code.session.count`, `claude_code.lines_of_code.count`, etc.

### Hooks

Claude Code POSTs to `/hook/<event>` synchronously as events happen. The hook handler:
1. Parses JSON body
2. Deduplicates `SessionEnd` events within 60s for the same session (Claude Code sometimes fires two)
3. Inserts into `hook_events`
4. On `SessionEnd`: decodes project path from `transcript_path`, calls `ingestSessionFile`

Hook event names: `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `PostToolUse`, `PreToolUse`, `Notification`

### JSONL

Claude Code writes session transcripts to:
```
~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
```

The encoded path replaces `/` with `-` (lossy — hyphens in directory names become `/` when decoded). Session UUID is used as the session ID everywhere.

Each line in the file is one JSON entry. Entries have `message.role`, `message.content`, `message.usage`, `costUSD`, `durationMs`. Note: `costUSD` is often `0` in practice — OTEL is the reliable cost source.

**Discovery**: `discoverSessionFiles()` in `parser/jsonl.ts` scans `~/.claude/projects/*/` for UUID-named `.jsonl` files (regex: `/^[0-9a-f]{8}-...-[0-9a-f]{12}\.jsonl$/i`). It does NOT look in `sessions/` subdirectories — the directory structure changed in Claude Code 2.x.

**Watcher**: `watchSessionFiles()` in `parser/watcher.ts` runs on `zozul serve`. It does a catch-up ingest of all files on startup, then watches for changes using `fs.watch({ recursive: true })`. Each file change is debounced 500ms before calling `ingestSessionFile`.

---

## Database schema

Six tables, all in `~/.zozul/zozul.db` (WAL mode, foreign keys ON).

### `sessions`
One row per Claude Code session. Updated from both JSONL and OTEL.

```sql
id TEXT PRIMARY KEY           -- session UUID (from JSONL filename)
project_path TEXT             -- decoded from transcript path
started_at TEXT NOT NULL      -- ISO timestamp, from JSONL
ended_at TEXT                 -- kept current by OTEL batches
total_input_tokens INTEGER    -- OTEL-accumulated (MAX with JSONL)
total_output_tokens INTEGER
total_cache_read_tokens INTEGER
total_cache_creation_tokens INTEGER
total_cost_usd REAL           -- OTEL only (JSONL always 0)
total_turns INTEGER           -- from JSONL (count of parsed turns)
total_duration_ms INTEGER     -- OTEL active_time accumulated
model TEXT                    -- last model seen
```

Upsert semantics: `MIN(started_at)`, `MAX()` for all metric fields, `COALESCE` for nullable strings. This means re-ingesting from JSONL never destroys OTEL-accumulated cost/duration.

### `turns`
One row per message turn. Unique on `(session_id, turn_index)`.

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
session_id TEXT → sessions(id)
turn_index INTEGER
role TEXT                     -- 'user' or 'assistant'
timestamp TEXT
input_tokens / output_tokens / cache_* INTEGER
cost_usd REAL                 -- often 0, from JSONL
duration_ms INTEGER
model TEXT
content_text TEXT             -- full message text
tool_calls TEXT               -- JSON array of {toolName, toolInput, toolResult}
```

### `tool_uses`
Extracted tool calls, one row per tool invocation.

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
session_id TEXT → sessions(id)
turn_id INTEGER → turns(id)   -- nullable
tool_name TEXT
tool_input TEXT               -- JSON
tool_result TEXT
success INTEGER               -- null (not yet populated)
duration_ms INTEGER           -- 0 (not yet populated)
timestamp TEXT
```

Re-ingest is safe: `persistSession` calls `replaceToolUsesForTurn(turnId, ...)` which deletes existing rows for the turn before inserting — no duplication.

### `hook_events`
Raw hook payloads, append-only.

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
session_id TEXT               -- nullable (some hooks lack it)
event_name TEXT
timestamp TEXT
payload TEXT                  -- full JSON body
```

### `otel_metrics`
Raw OTEL metric data points, append-only.

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
name TEXT                     -- e.g. 'claude_code.token.usage'
value REAL
attributes TEXT               -- full JSON of flattened OTLP attributes
session_id TEXT               -- extracted from attributes
model TEXT                    -- extracted from attributes
timestamp TEXT
```

Dashboard charts query this table directly (not `sessions`) for time-series data.

### `otel_events`
Raw OTEL log records, append-only.

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
event_name TEXT
attributes TEXT               -- full JSON
session_id TEXT
prompt_id TEXT
timestamp TEXT
```

---

## Key design decisions

**OTEL is the authoritative source for cost and duration.** JSONL transcripts do not reliably contain `costUSD` (it's often 0 in practice). `total_cost_usd` in `sessions` is always populated by OTEL accumulation.

**JSONL is the only source for full conversation text.** OTEL events can include prompt text when `OTEL_LOG_USER_PROMPTS=1`, but the assistant's full response is only in the JSONL transcript.

**Sessions table uses MAX() semantics on upsert.** This means the highest value seen from any source wins. OTEL running totals always exceed JSONL partial values, so OTEL naturally wins for metrics without any special logic.

**OTEL deltas are accumulated, not replaced.** `updateSessionFromOtel` does `total_cost_usd = total_cost_usd + @cost`. This is correct because OTEL sends deltas per window. Do not change this to an assignment.

**Tool uses are replaced, not appended, on re-ingest.** `replaceToolUsesForTurn` deletes then re-inserts. This prevents duplication when the watcher re-ingests a live session file on every new turn.

**`insertTurn` uses `RETURNING id`.** On `ON CONFLICT DO UPDATE`, `lastInsertRowid` returns 0. Using `RETURNING id` gives the correct turn ID for the FK on `tool_uses`.

**JSONL file paths use lossy encoding.** Claude Code replaces `/` with `-` in project directory names. `decodeProjectPath` reverses this, but hyphens in original paths become `/`. This is unavoidable with Claude Code's current encoding scheme.

---

## Session lifecycle

```
Claude Code starts
  → SessionStart hook fires → hook_events INSERT
  → OTEL export #1 arrives (within 60s) → otel_metrics INSERT + sessions UPSERT (stub or update)
  → turns happen → JSONL file grows → watcher fires → ingestSessionFile → sessions/turns/tool_uses UPSERT
  → OTEL exports keep arriving every 60s → cost/duration accumulate in sessions
  → User stops Claude → Stop hook fires
  → SessionEnd hook fires → ingestSessionFile called with transcript_path → final JSONL state ingested
  → OTEL export continues until session ID stops appearing in batches
```

**Late-start behaviour**: if zozul wasn't running when Claude started, the watcher's catch-up pass immediately ingests all existing JSONL files. OTEL data from before zozul started is lost (no replay). The first OTEL batch after zozul starts will include cumulative cost for that window, partially recovering missed cost data.

---

## API routes

All served by `hooks/server.ts` on port 7890.

| Method | Path | Description |
|---|---|---|
| GET | `/dashboard` | Dashboard HTML |
| GET | `/api/stats` | Aggregate stats — sessions, tokens, cost, user prompts, interruptions |
| GET | `/api/sessions` | Paginated session list — returns `{ sessions, total, limit, offset }` |
| GET | `/api/sessions/:id` | Single session row |
| GET | `/api/sessions/:id/turns` | Turns for a session |
| GET | `/api/metrics/tokens` | Token time-series from `otel_metrics` |
| GET | `/api/metrics/cost` | Cost time-series from `otel_metrics` |
| GET | `/api/metrics/tools` | Tool usage breakdown from `tool_uses` |
| GET | `/api/metrics/models` | Per-model cost/token breakdown from `otel_metrics` |
| POST | `/v1/metrics` | OTLP metrics receiver |
| POST | `/v1/logs` | OTLP logs receiver |
| POST | `/hook/:event` | Claude Code hook receiver |

`/api/sessions` accepts `?limit=N` (default 50, max 500) and `?offset=N`. The response envelope `{ sessions, total, limit, offset }` lets the dashboard implement Load More without a separate count query.

Time-series endpoints accept `?range=7d`, `?range=24h`, or `?from=ISO&to=ISO&step=5m`. Step auto-selects based on range if omitted.

---

## Background service

`zozul install --service` writes a platform service file and loads it immediately:

- **macOS**: `~/Library/LaunchAgents/com.zozul.serve.plist` — loaded with `launchctl bootstrap gui/<uid>`
- **Linux**: `~/.config/systemd/user/zozul.service` — enabled with `systemctl --user enable --now`

The service file bakes in the absolute paths to the node binary (`process.execPath`) and the script (`process.argv[1]` resolved). This makes it nvm-safe but means you need to re-run `zozul install --service` if you upgrade node or move the project.

`zozul restart` kills and immediately relaunches the running service (`launchctl kickstart -k` on macOS, `systemctl --user restart` on Linux). Use this after `npm run build` to pick up code changes without reinstalling.

Logs: `~/.zozul/zozul.log`

---

## Known limitations

- **No schema migrations**: `db.ts` uses `CREATE TABLE IF NOT EXISTS`. Adding columns to existing tables requires manual SQL or a proper migration system.
- **JSONL path decoding is lossy**: hyphens in project directory names decode incorrectly. No fix without changes to Claude Code.
- **OTEL cost history is unrecoverable**: if zozul wasn't running during a session, cost data for that period is permanently lost.
- **`tool_uses.success` and `tool_uses.duration_ms` are never populated**: the schema has these columns but nothing writes to them yet.
- **Session filter is client-side only**: the filter input searches loaded sessions; Load More fetches additional pages.

---

## Dev workflow

```bash
npm install          # Install dependencies
npm run dev          # Run via tsx (no build step needed)
npm run build        # Compile TypeScript + copy index.html to dist/
npm test             # Run vitest
```

When the service is installed, it runs `dist/index.js` directly. After code changes: `npm run build && zozul restart`.

The DB is at `~/.zozul/zozul.db`. Use `sqlite3 ~/.zozul/zozul.db` for ad-hoc inspection. Use `zozul db-clean` to remove rows with invalid timestamps.
