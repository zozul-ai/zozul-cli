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
    commands.ts         All CLI commands (5 top-level + hidden utilities)
    format.ts           Terminal output formatters
  storage/
    db.ts               SQLite setup, schema migration, row types
    repo.ts             All DB queries — SessionRepo class
  hooks/
    server.ts           HTTP server: hook handler, API routes, OTEL receiver dispatch
    config.ts           Read/write ~/.claude/settings.json for hooks
    git.ts              Install/uninstall git post-commit hook (auto-clears context)
  otel/
    receiver.ts         Parse OTLP JSON payloads → DB + session accumulation
    config.ts           Read/write ~/.claude/settings.json for OTEL env vars
  parser/
    jsonl.ts            Discover and parse Claude Code session JSONL files
    ingest.ts           Persist parsed sessions/turns/tool_uses to DB
    watcher.ts          fs.watch on ~/.claude/projects, debounced ingest
    types.ts            JSONL type definitions
  dashboard/
    index.html          Dashboard SPA (vanilla JS, Chart.js from CDN). Four views: Summary, Tasks, Tags, Sessions. Auto-fallback between remote and local API.
    html.ts             Reads and serves index.html; injects ZOZUL_CONFIG for remote API auto-detection when env vars are set
  context/
    index.ts            Read/write ~/.zozul/context.json — active task tags
  sync/
    client.ts           ZozulApiClient — HTTP client for backend API
    transform.ts        SQLite row → API payload converters
    index.ts            Watermark-based incremental sync (sessions + OTEL bulk tables)
    sync.test.ts        Vitest tests for sync logic
  service/
    index.ts            Install/uninstall as launchd (macOS) or systemd (Linux) service
  pricing/
    index.ts            Model pricing table for per-turn cost calculation
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

Eight tables, all in `~/.zozul/zozul.db` (WAL mode, foreign keys ON).

### `sessions`
One row per Claude Code session. Updated from both JSONL and OTEL.

```sql
id TEXT PRIMARY KEY           -- session UUID (from JSONL filename) or agent-* for sub-sessions
project_path TEXT             -- decoded from transcript path
parent_session_id TEXT        -- parent session ID for agent sub-sessions, NULL for top-level
agent_type TEXT               -- e.g. 'Explore', 'Plan', 'general-purpose' (from .meta.json)
started_at TEXT NOT NULL      -- ISO timestamp, from JSONL
ended_at TEXT                 -- kept current by OTEL batches
total_input_tokens INTEGER    -- OTEL-authoritative (recomputed from otel_metrics)
total_output_tokens INTEGER
total_cache_read_tokens INTEGER
total_cache_creation_tokens INTEGER
total_cost_usd REAL           -- OTEL-authoritative; fallback: SUM(turns.cost_usd)
total_turns INTEGER           -- from JSONL (count of parsed turns)
total_duration_ms INTEGER     -- SUM(turns.duration_ms)
model TEXT                    -- last model seen
```

Upsert semantics: `MIN(started_at)`, simple replacement for metric fields, `COALESCE` for nullable strings. After ingest, `recomputeSessionCostsFromOtel` overwrites metrics with authoritative OTEL data. Sessions without OTEL fall back to `SUM(turns.cost_usd)`.

Agent sub-sessions are discovered from `<session-uuid>/subagents/` directories. They share the parent's `project_path` and have `parent_session_id` set. Display queries filter `WHERE parent_session_id IS NULL` to show only top-level sessions. OTEL reports all cost/tokens under the parent session ID — agent sub-sessions have no OTEL data.

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
Raw OTEL metric data points, append-only. Deduplicated via unique index on `(session_id, name, timestamp, type)`.

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
name TEXT                     -- e.g. 'claude_code.token.usage'
value REAL
attributes TEXT               -- full JSON of flattened OTLP attributes
session_id TEXT               -- extracted from attributes
model TEXT                    -- extracted from attributes
timestamp TEXT
UNIQUE(session_id, name, timestamp, json_extract(attributes, '$.type'))
```

Inserts use `INSERT OR IGNORE` to skip duplicates. Dashboard charts query this table directly (not `sessions`) for time-series data.

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

### `task_tags`
Maps turns to task tag strings. Populated during JSONL ingest when a context is active.

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
turn_id INTEGER → turns(id)
task TEXT
tagged_at TEXT                -- ISO timestamp
UNIQUE(turn_id, task)
```

### `sync_watermarks`
Tracks incremental sync progress per table. Prevents re-syncing already-uploaded data.

```sql
table_name TEXT PRIMARY KEY   -- 'sessions', 'turns', 'otel_metrics', 'otel_events'
last_id INTEGER               -- highest rowid/id successfully synced
updated_at TEXT
```

---

## Key design decisions

**OTEL is the authoritative source for cost and duration.** JSONL transcripts do not reliably contain `costUSD` (it's often 0 in practice). `total_cost_usd` in `sessions` is always populated by OTEL accumulation.

**JSONL is the only source for full conversation text.** OTEL events can include prompt text when `OTEL_LOG_USER_PROMPTS=1`, but the assistant's full response is only in the JSONL transcript.

**Sessions table uses simple replacement on upsert for metric fields.** JSONL values act as initial estimates. `recomputeSessionCostsFromOtel` runs after ingest and on server startup to overwrite with authoritative OTEL data. For sessions without OTEL, cost falls back to `SUM(turns.cost_usd)`. Duration is always `SUM(turns.duration_ms)`.

**OTEL deltas are accumulated, not replaced.** `updateSessionFromOtel` does `total_cost_usd = total_cost_usd + @cost`. This is correct because OTEL sends deltas per window. Do not change this to an assignment. The accumulated values are periodically reconciled by `recomputeSessionCostsFromOtel` which recomputes from raw `otel_metrics` rows.

**OTEL metrics are deduplicated locally.** The `otel_metrics` table has a unique index on `(session_id, name, timestamp, type)` matching the backend's constraint. Without this, `SUM(value)` double-counts duplicates, inflating costs. Inserts use `INSERT OR IGNORE`.

**Tool uses are replaced, not appended, on re-ingest.** `replaceToolUsesForTurn` deletes then re-inserts. This prevents duplication when the watcher re-ingests a live session file on every new turn.

**`insertTurn` uses `RETURNING id`.** On `ON CONFLICT DO UPDATE`, `lastInsertRowid` returns 0. Using `RETURNING id` gives the correct turn ID for the FK on `tool_uses`.

**JSONL file paths use lossy encoding.** Claude Code replaces `/` with `-` in project directory names. `decodeProjectPath` reverses this, but hyphens in original paths become `/`. This is unavoidable with Claude Code's current encoding scheme.

**Proportional cost replaces `turns.cost_usd` in queries.** Since `costUSD` in JSONL is always 0, per-turn cost is estimated as `session.total_cost_usd * (turn_all_tokens / session_all_tokens)` where all_tokens includes input, output, cache_read, and cache_creation. Both the local server (`PROPORTIONAL_COST_SQL` in `repo.ts`) and the remote API compute this server-side. Coverage is ~95% — turns with no JSONL token data get $0.

**Dashboard auto-detects data source.** When `ZOZUL_API_URL` and `ZOZUL_API_KEY` are set, `html.ts` injects `ZOZUL_CONFIG` into the dashboard. On load, the dashboard health-checks the remote API at `/api/v1/health` (3s timeout). If available, it routes `fetchJson` calls to the remote; if any remote call fails, it falls back to local for that request. A badge in the header shows "Remote" or "Local".

**Dashboard has four views.** Summary (cost chart, project breakdown, stat cards), Tasks (tag-combination groups from `/task-groups`), Tags (per-tag stats), Sessions (sortable/filterable table). All views except Sessions support time window filtering (7d/30d/All) via `?from=&to=` params. The dashboard uses only endpoints that exist on both the local and remote API — no local-only endpoints.

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
| GET | `/health` | Health check — returns `{ status: "ok" }` |
| GET | `/dashboard` | Dashboard HTML (injects `ZOZUL_CONFIG` when `ZOZUL_API_URL` / `ZOZUL_API_KEY` are set) |
| GET | `/api/stats` | Aggregate stats. Accepts `?from=ISO&to=ISO` to filter by `sessions.started_at` |
| GET | `/api/sessions` | Paginated session list. Accepts `?limit=N&offset=N&from=ISO&to=ISO` |
| GET | `/api/sessions/:id` | Single session row |
| GET | `/api/sessions/:id/turns` | Turns for a session |
| GET | `/api/context` | Active task context (`~/.zozul/context.json`) |
| GET | `/api/task-groups` | Task groups by tag combination. Accepts `?from=ISO&to=ISO`. Returns `[{ tags, turn_count, human_interventions, total_duration_ms, total_cost_usd, last_seen }]`. Includes `Untagged` group |
| GET | `/api/tasks` | List distinct tags with turn counts, first/last tagged timestamps |
| GET | `/api/tasks/stats` | Multi-tag cost/token stats — `?tags=X,Y&mode=all\|any&from=ISO&to=ISO` |
| GET | `/api/tasks/turns` | Paginated turns filtered by tags — `?tags=X&mode=any&limit=N&offset=N&from=ISO&to=ISO`. Returns `block_cost_usd`, `block_cache_read_tokens`, `block_cache_creation_tokens` per turn |
| GET | `/api/tasks/:name/stats` | Per-tag cost/token breakdown |
| GET | `/api/tasks/:name/turns` | Paginated turns for a single tag |
| GET | `/api/turns/:id/block` | Turn block — all turns from a user prompt to the next. Returns `estimated_cost_usd` per turn |
| GET | `/api/metrics/tokens` | Token time-series from `otel_metrics` |
| GET | `/api/metrics/cost` | Cost time-series from `otel_metrics` |
| GET | `/api/metrics/tools` | Tool usage breakdown from `tool_uses` |
| GET | `/api/metrics/models` | Per-model cost/token breakdown from `otel_metrics` |
| POST | `/v1/metrics` | OTLP metrics receiver |
| POST | `/v1/logs` | OTLP logs receiver |
| POST | `/hook/:event` | Claude Code hook receiver |

**Pagination**: `/api/sessions` accepts `?limit=N` (default 50, max 500) and `?offset=N`. The response envelope `{ sessions, total, limit, offset }` lets the dashboard implement Load More without a separate count query.

**Time filtering**: endpoints that accept `?from=ISO&to=ISO` filter inclusively. `/api/stats` and `/api/sessions` filter on `sessions.started_at`. `/api/task-groups`, `/api/tasks/stats`, and `/api/tasks/turns` filter on `turns.timestamp`. Both params must be provided together or neither.

**Time-series**: `/api/metrics/cost` and `/api/metrics/tokens` accept `?range=7d`, `?range=24h`, or `?from=ISO&to=ISO&step=5m`. Step auto-selects based on range if omitted.

**Proportional cost**: all cost fields in task/turn queries use `session_cost * turn_all_tokens / session_all_tokens` (including cache tokens) instead of `turns.cost_usd` which is always 0 from JSONL. The remote API also computes this server-side. Locally defined as `PROPORTIONAL_COST_SQL` in `repo.ts`.

---

## CLI commands

The CLI has been consolidated to 5 top-level commands (plus hidden utilities):

| Command | Description |
|---|---|
| `zozul serve` | Start the local HTTP server (hooks + OTEL + dashboard + API) |
| `zozul install` | Configure Claude Code hooks/OTEL, install background service, install git hook |
| `zozul sync` | Push local SQLite data to remote backend (requires `ZOZUL_API_URL` + `ZOZUL_API_KEY`) |
| `zozul context [tags...]` | Set or clear active task context tags |
| `zozul install --status` | Show background service status |
| `zozul install --restart` | Restart the background service (replaces old `zozul restart`) |
| `zozul ingest` | Hidden — manually ingest a JSONL file |
| `zozul db-clean` | Hidden — remove rows with invalid timestamps |

---

## Remote sync

`zozul sync` pushes local SQLite data to the remote backend incrementally using watermarks stored in `sync_watermarks`. It syncs three data types:

1. **Sessions** — all sessions with new data since last sync (by rowid watermark)
2. **OTEL metrics** — bulk, batched at 500 rows
3. **OTEL events** — bulk, batched at 500 rows

Each session sync sends the full payload in one request: session row + all turns + tool_uses + task_tags + hook_events. The backend upserts everything atomically.

**Configuration** (via `.env` or environment):
```
ZOZUL_API_URL=http://...    # Backend base URL
ZOZUL_API_KEY=zozul_...     # API key (X-API-Key header)
```

**Source files**:
- `src/sync/client.ts` — HTTP client (`ZozulApiClient`)
- `src/sync/transform.ts` — SQLite row → API payload converters
- `src/sync/index.ts` — watermark-based incremental sync logic

**Getting an API key**: use the admin endpoints on the backend (requires `X-Admin-Key`):
```bash
# Create a user
curl -X POST $BASE/api/v1/admin/users -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"name": "Your Name", "email": "you@example.com"}'

# Generate API key for that user (returns full key once)
curl -X POST $BASE/api/v1/admin/api-keys -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"user_id": <id>}'
```

---

## Background service

`zozul install --service` writes a platform service file and loads it immediately:

- **macOS**: `~/Library/LaunchAgents/com.zozul.serve.plist` — loaded with `launchctl bootstrap gui/<uid>`
- **Linux**: `~/.config/systemd/user/zozul.service` — enabled with `systemctl --user enable --now`

The service file bakes in the absolute paths to the node binary (`process.execPath`) and the script (`process.argv[1]` resolved). This makes it nvm-safe but means you need to re-run `zozul install --service` if you upgrade node or move the project.

`zozul install --restart` kills and immediately relaunches the running service (`launchctl kickstart -k` on macOS, `systemctl --user restart` on Linux). Use this after `npm run build` to pick up code changes.

Logs: `~/.zozul/zozul.log`

---

## Task context tagging

`zozul context "tag1" "tag2"` writes `{ active: string[], set_at: string }` to `~/.zozul/context.json`. Tags are applied during JSONL ingest to all turns whose `timestamp >= set_at`. Context is cleared automatically by a git `post-commit` hook installed by `zozul install` (marker: `# zozul: auto-clear context on commit`). Also auto-cleared when Claude runs `git commit` or `git push` (via PostToolUse hook handler in `server.ts`).

Source: `src/context/index.ts` (context read/write), `src/hooks/git.ts` (hook install).

**Limitation**: manual discipline required. Tags apply to all turns after `set_at` regardless of whether they're topically related. No retroactive tagging of past sessions.

---

## Known limitations

- **No schema migrations**: `db.ts` uses `CREATE TABLE IF NOT EXISTS`. Adding columns to existing tables requires manual SQL or a proper migration system.
- **JSONL path decoding is lossy**: hyphens in project directory names decode incorrectly. No fix without changes to Claude Code.
- **OTEL cost history is unrecoverable**: if zozul wasn't running during a session, cost data for that period is permanently lost.
- **`tool_uses.success` and `tool_uses.duration_ms` are never populated**: the schema has these columns but nothing writes to them yet.

---

## Dev workflow

```bash
npm install          # Install dependencies
npm run dev          # Run via tsx (no build step needed)
npm run build        # Compile TypeScript + copy index.html to dist/
npm test             # Run vitest
```

When the service is installed, it runs `dist/index.js` directly. After code changes: `npm run build && zozul install --restart`.

The DB is at `~/.zozul/zozul.db`. Use `sqlite3 ~/.zozul/zozul.db` for ad-hoc inspection. Use `zozul db-clean` to remove rows with invalid timestamps.

For sync, set `ZOZUL_API_URL` and `ZOZUL_API_KEY` in `.env`, then `npm run dev -- sync --verbose` (or `zozul sync --verbose` if built).
