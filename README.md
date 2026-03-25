# zozul-cli

Observability for [Claude Code](https://code.claude.com/) — track token usage, costs, turns, and full conversation history. No external services, no Docker, no cloud.

## What it does

zozul is a single local process that captures everything Claude Code does. Data flows in from three complementary sources and lands in a SQLite database at `~/.zozul/zozul.db`. A built-in web dashboard and JSON API sit on top of that.

| Source | What it provides |
|---|---|
| **OTEL receiver** | Token counts, cost (USD), active time, API events, user prompts — streamed from Claude Code every ~60s |
| **Hooks** | Real-time session lifecycle, tool calls, user prompts — fired synchronously as events happen |
| **JSONL watcher** | Full turn content, assistant responses, per-turn token detail — read directly from Claude Code's transcript files |

Each source has different strengths. OTEL is the authoritative source for **cost and duration**. JSONL is the only source for **full conversation text**. Hooks provide **real-time signals** and trigger transcript ingestion on session end. The `sessions` table is kept in sync from all three.

## Quick start

```bash
# Install and build
npm install && npm link

# Configure Claude Code and install as a background service (recommended)
zozul install --service

# Open the dashboard
open http://localhost:7890/dashboard

# Use Claude Code normally — data appears automatically
claude
```

Or if you'd rather manage the process yourself:

```bash
zozul install          # Configure Claude Code hooks + OTEL
zozul serve            # Start the server
open http://localhost:7890/dashboard
```

## Dashboard

`http://localhost:7890/dashboard`

- **Stats bar** — sessions, user prompts, interruptions, tokens, and cost at a glance
- **Token usage chart** — daily input/output/cache token trends with time range controls
- **Cost chart** — daily spend
- **Tool usage** — which tools Claude uses most
- **Model breakdown** — cost and tokens per model
- **Sessions table** — paginated (Load More), filterable; click any session for the full conversation with per-turn token counts, expandable tool call inputs/outputs
- **Auto-refresh** — dashboard polls every 10s automatically; click the Auto button to refresh immediately

## Commands

| Command | Description |
|---|---|
| `zozul serve` | Start the server (dashboard, hooks, OTEL receiver, API) on port 7890 |
| `zozul install` | Configure Claude Code hooks and OTEL in `~/.claude/settings.json` |
| `zozul install --service` | Configure Claude Code **and** install zozul as a login service (auto-starts) |
| `zozul uninstall` | Remove zozul config from Claude Code settings |
| `zozul uninstall --service` | Also stop and remove the background service |
| `zozul restart` | Restart the background service (picks up new builds) |
| `zozul service-status` | Show whether the background service is installed and running |
| `zozul ingest` | Parse all Claude Code session JSONL files into the database |
| `zozul ingest --force` | Re-ingest sessions that already exist (picks up new turns) |
| `zozul sessions` | List recorded sessions with token/cost summaries |
| `zozul session <id>` | Show full details and conversation for a session |
| `zozul stats` | Show aggregate statistics across all sessions |
| `zozul db-clean` | Remove rows with invalid timestamps from the database |
| `zozul db-clean --session <id>` | Remove all data for a specific session |
| `zozul show-config` | Preview the Claude Code config that would be installed |

## Architecture

```
                        Claude Code
                            |
              +-------------+-------------+
              |             |             |
         OTEL export    Hook POSTs    ~/.claude/projects/
         (every ~60s)  (real-time)   <project>/<uuid>.jsonl
              |             |             |
              v             v             v
         /v1/metrics    /hook/*      fs.watch (live)
         /v1/logs           |        zozul ingest (manual)
              |             |             |
              |    updateSessionFromOtel  |
              |             |        persistSession
              +------+------+------+------+
                     |
               SQLite (WAL)
               ~/.zozul/zozul.db
                     |
              +------+------+
              |             |
         /dashboard     /api/*
         (browser)     (JSON)
```

Everything runs in a single process on port 7890.

### Data sources and ownership

Each field in the `sessions` table has a designated owner:

| Field | Owner | Notes |
|---|---|---|
| `id`, `started_at`, `project_path`, `model` | JSONL | Set from transcript filename and content |
| `total_turns` | JSONL | Count of turns parsed from transcript |
| `total_cost_usd` | OTEL | JSONL transcripts do not include cost data |
| `total_duration_ms` | OTEL | Accumulated from `claude_code.active_time.total` |
| `total_*_tokens` (session level) | OTEL (preferred) | JSONL provides seeds; OTEL accumulates via `MAX()` |
| `ended_at` | Both | OTEL keeps it current as batches arrive; JSONL sets it at ingest |

The `sessions` upsert uses `MAX()` for all metric fields so OTEL-accumulated values are never clobbered by a JSONL re-ingest that may have lower (or zero) values.

### JSONL watcher

When `zozul serve` starts it:

1. Performs a catch-up pass — ingests all JSONL files found under `~/.claude/projects/`
2. Watches that directory for changes via `fs.watch` (recursive, FSEvents on macOS)
3. Debounces per-file at 500ms and calls `ingestSessionFile` on each change

This means starting zozul after Claude Code is already running is fine — all existing turns are recovered immediately and new turns appear within ~500ms of being written.

### OTEL metrics

Claude Code exports OTLP JSON to `http://localhost:7890` on a 60s interval (metrics) and 5s interval (logs). Each batch contains **delta values** for the export window — not cumulative totals. zozul accumulates these into the `sessions` table via `updateSessionFromOtel` on every batch received.

Raw metric rows are also stored in `otel_metrics` and `otel_events` for dashboard charts and event replay.

## Background service

`zozul install --service` installs zozul as a persistent background service:

- **macOS**: writes `~/Library/LaunchAgents/com.zozul.serve.plist` and loads it via `launchctl`. Starts on login, restarts on crash.
- **Linux**: writes `~/.config/systemd/user/zozul.service` and enables it with `systemctl --user`.

The service bakes in the exact node binary path (nvm-safe) and the script path at install time, so it doesn't depend on shell PATH.

Logs write to `~/.zozul/zozul.log`.

## Configuration

Settings via `.env` in the working directory (see `.env.example`) or environment variables:

```bash
ZOZUL_PORT=7890                      # Server port (default: 7890)
ZOZUL_DB_PATH=~/.zozul/zozul.db      # Database path
ZOZUL_VERBOSE=1                      # Log every event to stderr
OTEL_ENDPOINT=http://localhost:7890  # Where Claude Code sends OTEL
OTEL_PROTOCOL=http/json              # Must be http/json
OTEL_LOG_USER_PROMPTS=1              # Include prompt text in OTEL events
OTEL_LOG_TOOL_DETAILS=1              # Include tool names in OTEL events
```

CLI flags override `.env` values.

## Data captured

| Data point | Source | Granularity |
|---|---|---|
| Token usage (input/output/cache/creation) | OTEL + JSONL | Per-session and per-turn |
| Cost (USD) | OTEL | Per-session, per-model |
| Active time | OTEL | Per-session |
| Turns / API calls | JSONL | Full content and metadata |
| User prompts | Hooks (`UserPromptSubmit`) + JSONL | Count (aggregate) + full text (per-turn) |
| Interruptions | Hooks (`Stop`) | Count (aggregate) |
| Model responses | JSONL only | Full text |
| Tool calls and results | Hooks + JSONL | Name, input, output |
| Session lifecycle | Hooks | Start, end, stop events |

## Requirements

- Node.js 18+
- Claude Code installed (`claude --version`)
- Claude Pro, Max, Teams, Enterprise, or API key
