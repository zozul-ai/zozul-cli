import http from "node:http";
import type { SessionRepo } from "../storage/repo.js";
import { ingestSessionFile } from "../parser/ingest.js";
import { handleOtlpMetrics, handleOtlpLogs } from "../otel/receiver.js";
import { dashboardHtml, dashboardHtmlWithToggle } from "../dashboard/html.js";
import { getActiveContext, clearActiveContext } from "../context/index.js";
import { ZozulApiClient } from "../sync/client.js";
import { syncSingleSession, runSync } from "../sync/index.js";

export interface HookServerOptions {
  port: number;
  repo: SessionRepo;
  verbose?: boolean;
  syncClient?: ZozulApiClient;
}

/**
 * Unified HTTP server that handles:
 *  - Hook events from Claude Code (POST /hook/*)
 *  - OTLP metrics and logs (POST /v1/metrics, POST /v1/logs)
 *  - Dashboard API (GET /api/*)
 *  - Web dashboard (GET /dashboard)
 */
export function createHookServer(opts: HookServerOptions): http.Server {
  const { repo, verbose, syncClient } = opts;
  // Track last SessionEnd time per session to suppress rapid duplicates (Claude Code
  // sometimes fires two SessionEnd events within seconds for the same session).
  const lastSessionEnd = new Map<string, number>();

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      // ── OTLP receiver ──
      if (method === "POST" && url === "/v1/metrics") {
        const body = await readBody(req);
        const count = handleOtlpMetrics(body, repo, verbose);
        if (verbose) log(`otel metrics: ${count} data points`);
        sendJson(res, 200, {});
        return;
      }

      if (method === "POST" && url === "/v1/logs") {
        const body = await readBody(req);
        const count = handleOtlpLogs(body, repo, verbose);
        if (verbose) log(`otel logs: ${count} events`);
        sendJson(res, 200, {});
        return;
      }

      // ── Hook events ──
      if (method === "POST" && url.startsWith("/hook")) {
        await handleHookEvent(url, req, repo, res, verbose, lastSessionEnd, syncClient);
        return;
      }

      // ── Dashboard ──
      if (method === "GET" && (url === "/dashboard" || url === "/")) {
        const apiUrl = process.env.ZOZUL_API_URL;
        const apiKey = process.env.ZOZUL_API_KEY;
        const html = apiUrl && apiKey
          ? dashboardHtmlWithToggle({ apiUrl, apiKey }, "local")
          : dashboardHtml();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }

      // ── API routes ──
      if (method === "GET" && url.startsWith("/api/")) {
        handleApiRoute(url, repo, res);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (verbose) process.stderr.write(`  error: ${err}\n`);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  return server;
}

// ── Hook handler ──

const SESSION_END_DEDUP_MS = 60_000;

async function handleHookEvent(
  url: string,
  req: http.IncomingMessage,
  repo: SessionRepo,
  res: http.ServerResponse,
  verbose?: boolean,
  lastSessionEnd?: Map<string, number>,
  syncClient?: ZozulApiClient,
): Promise<void> {
  const body = await readBody(req);

  try {
    const payload = JSON.parse(body);
    const eventName = routeToEventName(url);

    if (verbose) log(`hook: ${eventName} session=${payload.session_id ?? "?"}`);

    // Suppress duplicate SessionEnd events for the same session within the dedup window
    if (eventName === "SessionEnd" && payload.session_id && lastSessionEnd) {
      const last = lastSessionEnd.get(payload.session_id) ?? 0;
      const now = Date.now();
      if (now - last < SESSION_END_DEDUP_MS) {
        if (verbose) log(`  -> suppressed duplicate SessionEnd for ${payload.session_id}`);
        sendJson(res, 200, { ok: true, deduplicated: true });
        return;
      }
      lastSessionEnd.set(payload.session_id, now);
    }

    repo.insertHookEvent({
      session_id: payload.session_id ?? null,
      event_name: eventName,
      timestamp: new Date().toISOString(),
      payload: body,
    });

    if (eventName === "SessionEnd" && payload.transcript_path) {
      try {
        const projectPath = decodeProjectPathFromTranscript(payload.transcript_path);
        await ingestSessionFile(repo, payload.transcript_path, projectPath ?? undefined);
        if (verbose) log(`  -> ingested transcript: ${payload.transcript_path}${projectPath ? ` (project: ${projectPath})` : ""}`);
      } catch (err) {
        if (verbose) log(`  -> transcript ingest failed: ${err}`);
      }

      // Sync session immediately, then do a delayed sweep to catch trailing OTEL data
      if (syncClient && payload.session_id) {
        syncSingleSession(repo, syncClient, payload.session_id, { verbose }).catch(() => {});
        setTimeout(() => runSync(repo, syncClient, { verbose }).catch(() => {}), 90_000);
      }
    }

    // On Stop: sync the current session immediately
    if (eventName === "Stop" && payload.session_id && syncClient) {
      syncSingleSession(repo, syncClient, payload.session_id, { verbose }).catch(() => {});
    }

    // Auto-clear context when Claude runs git commit or git push
    if (eventName === "PostToolUse" && payload.tool_name === "Bash") {
      const cmd = payload.tool_input?.command ?? "";
      if (/\bgit\s+(commit|push)\b/.test(cmd)) {
        const ctx = getActiveContext();
        if (ctx?.active && ctx.active.length > 0) {
          clearActiveContext();
          if (verbose) log(`  -> cleared task context after: ${cmd.slice(0, 60)}`);
        }
      }
    }

    sendJson(res, 200, { ok: true });
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
  }
}

// ── API handler ──

function handleApiRoute(url: string, repo: SessionRepo, res: http.ServerResponse): void {
  const path = url.replace(/\?.*$/, "");

  if (path === "/api/stats") {
    const stats = repo.getAggregateStats();
    sendJson(res, 200, stats ?? {});
    return;
  }

  if (path === "/api/sessions") {
    const qs = new URL(url, "http://x").searchParams;
    const limit = Math.min(500, Math.max(1, parseInt(qs.get("limit") ?? "50", 10)));
    const offset = Math.max(0, parseInt(qs.get("offset") ?? "0", 10));
    const sessions = repo.listSessions(limit, offset);
    const total = repo.countSessions();
    sendJson(res, 200, { sessions, total, limit, offset });
    return;
  }

  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const session = repo.getSession(sessionMatch[1]);
    if (!session) { sendJson(res, 404, { error: "Session not found" }); return; }
    sendJson(res, 200, session);
    return;
  }

  const turnsMatch = path.match(/^\/api\/sessions\/([^/]+)\/turns$/);
  if (turnsMatch) {
    const turns = repo.getSessionTurns(turnsMatch[1]);
    sendJson(res, 200, turns);
    return;
  }

  if (path === "/api/metrics/tokens") {
    const { from, to, stepSeconds } = parseTimeRange(url);
    sendJson(res, 200, repo.getTokenTimeSeries(from, to, stepSeconds));
    return;
  }

  if (path === "/api/metrics/cost") {
    const { from, to, stepSeconds } = parseTimeRange(url);
    sendJson(res, 200, repo.getCostTimeSeries(from, to, stepSeconds));
    return;
  }

  if (path === "/api/metrics/tools") {
    sendJson(res, 200, repo.getToolUsageBreakdown());
    return;
  }

  if (path === "/api/metrics/models") {
    sendJson(res, 200, repo.getModelBreakdown());
    return;
  }

  if (path === "/api/context") {
    const ctx = getActiveContext();
    sendJson(res, 200, ctx ?? { active: null });
    return;
  }

  if (path === "/api/tasks") {
    const tasks = repo.listTasks();
    sendJson(res, 200, tasks);
    return;
  }

  if (path === "/api/tasks/stats") {
    const qs = new URL(url, "http://x").searchParams;
    const tagsParam = qs.get("tags") ?? "";
    const tags = tagsParam.split(",").map(t => t.trim()).filter(Boolean);
    if (tags.length === 0) {
      sendJson(res, 400, { error: "tags parameter required" });
      return;
    }
    const mode = qs.get("mode") === "any" ? "any" as const : "all" as const;
    const from = qs.get("from") ?? undefined;
    const to = qs.get("to") ?? undefined;
    const stats = repo.getStatsByTasks(tags, mode, from, to);
    sendJson(res, 200, stats ?? {});
    return;
  }

  const turnBlockMatch = path.match(/^\/api\/turns\/(\d+)\/block$/);
  if (turnBlockMatch) {
    const turnId = parseInt(turnBlockMatch[1], 10);
    const block = repo.getTurnBlock(turnId);
    sendJson(res, 200, block);
    return;
  }

  if (path === "/api/tasks/turns") {
    const qs = new URL(url, "http://x").searchParams;
    const tagsParam = qs.get("tags") ?? "";
    const tags = tagsParam ? tagsParam.split(",").map(t => t.trim()).filter(Boolean) : undefined;
    const mode = qs.get("mode") === "all" ? "all" as const : "any" as const;
    const from = qs.get("from") ?? undefined;
    const to = qs.get("to") ?? undefined;
    const limit = Math.min(200, Math.max(1, parseInt(qs.get("limit") ?? "50", 10)));
    const offset = Math.max(0, parseInt(qs.get("offset") ?? "0", 10));
    const turns = repo.getTaggedTurns({ tags, mode, from, to, limit, offset });
    sendJson(res, 200, turns);
    return;
  }

  const taskTurnsMatch = path.match(/^\/api\/tasks\/([^/]+)\/turns$/);
  if (taskTurnsMatch) {
    const taskName = decodeURIComponent(taskTurnsMatch[1]);
    const qs = new URL(url, "http://x").searchParams;
    const limit = Math.min(500, Math.max(1, parseInt(qs.get("limit") ?? "50", 10)));
    const offset = Math.max(0, parseInt(qs.get("offset") ?? "0", 10));
    const turns = repo.getTurnsByTask(taskName, limit, offset);
    sendJson(res, 200, turns);
    return;
  }

  const taskStatsMatch = path.match(/^\/api\/tasks\/([^/]+)\/stats$/);
  if (taskStatsMatch) {
    const taskName = decodeURIComponent(taskStatsMatch[1]);
    const stats = repo.getStatsByTask(taskName);
    sendJson(res, 200, stats ?? {});
    return;
  }

  sendJson(res, 404, { error: "Unknown API route" });
}

// ── Helpers ──

function routeToEventName(url: string): string {
  const segment = url.replace(/^\/hooks?\/?/, "").replace(/\/$/, "");
  if (!segment) return "unknown";

  const mapped: Record<string, string> = {
    "session-start": "SessionStart",
    "session-end": "SessionEnd",
    "post-tool-use": "PostToolUse",
    "pre-tool-use": "PreToolUse",
    "stop": "Stop",
    "user-prompt": "UserPromptSubmit",
    "notification": "Notification",
  };
  return mapped[segment] ?? segment;
}

interface TimeRange {
  from: string;
  to: string;
  stepSeconds: number;
}

function autoStep(rangeMs: number): number {
  const hours = rangeMs / 3_600_000;
  if (hours <= 1) return 60;
  if (hours <= 6) return 300;
  if (hours <= 24) return 900;
  if (hours <= 168) return 3600;
  return 86400;
}

function parseStepParam(step: string): number {
  const m = step.match(/^(\d+)(m|h|d)$/);
  if (!m) return 3600;
  const n = parseInt(m[1], 10);
  if (m[2] === "m") return n * 60;
  if (m[2] === "h") return n * 3600;
  return n * 86400;
}

/**
 * Parse time-range query params.
 * Supports presets (?range=7d) and custom (?from=ISO&to=ISO&step=5m).
 */
function parseTimeRange(url: string): TimeRange {
  const qs = new URL(url, "http://x").searchParams;

  if (qs.has("from") && qs.has("to")) {
    const from = qs.get("from")!;
    const to = qs.get("to")!;
    const rangeMs = new Date(to).getTime() - new Date(from).getTime();
    const stepSeconds = qs.has("step") && qs.get("step") !== "auto"
      ? parseStepParam(qs.get("step")!)
      : autoStep(rangeMs);
    return { from, to, stepSeconds };
  }

  const rangeMatch = url.match(/[?&]range=(\d+)(h|d)/);
  const now = new Date();
  if (!rangeMatch) {
    const from = new Date(now.getTime() - 30 * 24 * 3_600_000).toISOString();
    return { from, to: now.toISOString(), stepSeconds: 86400 };
  }

  const n = parseInt(rangeMatch[1], 10);
  const unit = rangeMatch[2];
  const ms = unit === "h" ? n * 3_600_000 : n * 24 * 3_600_000;
  const from = new Date(now.getTime() - ms).toISOString();
  return { from, to: now.toISOString(), stepSeconds: autoStep(ms) };
}

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

/**
 * Extract the project path from a transcript file path.
 * Claude Code stores transcripts at:
 *   ~/.claude/projects/<encoded-path>/<uuid>.jsonl
 * where <encoded-path> is the absolute path with "/" replaced by "-".
 * Returns null if the path doesn't match the expected structure.
 */
function decodeProjectPathFromTranscript(transcriptPath: string): string | null {
  const match = transcriptPath.match(/projects\/([^/]+)\/[0-9a-f-]{36}\.jsonl$/i);
  if (!match) return null;
  return match[1].replace(/-/g, "/");
}
