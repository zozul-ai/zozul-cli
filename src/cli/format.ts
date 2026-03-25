import type { SessionRow, TurnRow } from "../storage/db.js";

export function formatSessionList(sessions: SessionRow[]): string {
  if (sessions.length === 0) return "No sessions found.";

  const lines: string[] = [];
  lines.push(
    pad("SESSION ID", 40) +
    pad("STARTED", 22) +
    pad("TURNS", 7) +
    pad("TOKENS (in/out)", 20) +
    pad("COST", 10) +
    "MODEL",
  );
  lines.push("─".repeat(120));

  for (const s of sessions) {
    const started = formatTimestamp(s.started_at);
    const tokens = `${fmtNum(s.total_input_tokens)}/${fmtNum(s.total_output_tokens)}`;
    const cost = `$${s.total_cost_usd.toFixed(4)}`;
    const id = s.id.length > 36 ? s.id.slice(0, 36) + "…" : s.id;

    lines.push(
      pad(id, 40) +
      pad(started, 22) +
      pad(String(s.total_turns), 7) +
      pad(tokens, 20) +
      pad(cost, 10) +
      (s.model ?? "—"),
    );
  }

  return lines.join("\n");
}

export function formatSessionDetail(session: SessionRow, turns: TurnRow[]): string {
  const lines: string[] = [];

  lines.push(`Session: ${session.id}`);
  lines.push(`Project: ${session.project_path ?? "—"}`);
  lines.push(`Started: ${formatTimestamp(session.started_at)}`);
  lines.push(`Ended:   ${session.ended_at ? formatTimestamp(session.ended_at) : "—"}`);
  lines.push(`Model:   ${session.model ?? "—"}`);
  lines.push("");
  lines.push("── Token Usage ──");
  lines.push(`  Input tokens:          ${fmtNum(session.total_input_tokens)}`);
  lines.push(`  Output tokens:         ${fmtNum(session.total_output_tokens)}`);
  lines.push(`  Cache read tokens:     ${fmtNum(session.total_cache_read_tokens)}`);
  lines.push(`  Cache creation tokens: ${fmtNum(session.total_cache_creation_tokens)}`);
  lines.push(`  Total cost:            $${session.total_cost_usd.toFixed(4)}`);
  lines.push(`  Total turns:           ${session.total_turns}`);
  lines.push(`  Total duration:        ${formatDuration(session.total_duration_ms)}`);

  if (turns.length > 0) {
    lines.push("");
    lines.push("── Conversation ──");

    for (const turn of turns) {
      const role = turn.role === "assistant" ? "🤖 Assistant" : "👤 User";
      lines.push("");
      lines.push(`[${turn.turn_index}] ${role} (${formatTimestamp(turn.timestamp)})`);

      if (turn.input_tokens > 0 || turn.output_tokens > 0) {
        lines.push(
          `    tokens: ${fmtNum(turn.input_tokens)} in / ${fmtNum(turn.output_tokens)} out` +
          (turn.cost_usd > 0 ? ` | cost: $${turn.cost_usd.toFixed(4)}` : "") +
          (turn.model ? ` | model: ${turn.model}` : ""),
        );
      }

      if (turn.content_text) {
        const preview = turn.content_text.length > 500
          ? turn.content_text.slice(0, 500) + "…"
          : turn.content_text;
        lines.push(`    ${preview.replace(/\n/g, "\n    ")}`);
      }

      if (turn.tool_calls) {
        try {
          const calls = JSON.parse(turn.tool_calls);
          for (const call of calls) {
            lines.push(`    🔧 ${call.toolName}`);
          }
        } catch {
          // skip
        }
      }
    }
  }

  return lines.join("\n");
}

export function formatStats(stats: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("── Aggregate Statistics ──");
  lines.push(`  Total sessions:        ${stats.total_sessions ?? 0}`);
  lines.push(`  Total input tokens:    ${fmtNum(Number(stats.total_input_tokens ?? 0))}`);
  lines.push(`  Total output tokens:   ${fmtNum(Number(stats.total_output_tokens ?? 0))}`);
  lines.push(`  Total cache read:      ${fmtNum(Number(stats.total_cache_read_tokens ?? 0))}`);
  lines.push(`  Total cost:            $${Number(stats.total_cost_usd ?? 0).toFixed(4)}`);
  lines.push(`  Total turns:           ${stats.total_turns ?? 0}`);
  lines.push(`  Total active time:     ${formatDuration(Number(stats.total_duration_ms ?? 0))}`);
  return lines.join("\n");
}

function pad(str: string, len: number): string {
  return str.padEnd(len);
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
