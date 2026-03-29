import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../storage/db.js";
import { SessionRepo } from "../storage/repo.js";
import { ZozulApiClient } from "./client.js";
import { runSync } from "./index.js";

// ── Mock server that collects POSTed payloads ──

function createMockServer() {
  const received: Record<string, unknown[]> = {};

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    const route = req.url!;
    if (!received[route]) received[route] = [];

    if (Array.isArray(body)) {
      received[route].push(...body);
    } else {
      received[route].push(body);
    }

    // Return a sync-style response for session sync endpoints
    if (route.includes("/sync")) {
      const payload = body as { turns?: unknown[]; tool_uses?: unknown[]; task_tags?: unknown[]; hook_events?: unknown[] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        session_id: route.split("/")[4], // /api/v1/sessions/{id}/sync
        turns_synced: payload.turns?.length ?? 0,
        tool_uses_synced: payload.tool_uses?.length ?? 0,
        task_tags_synced: payload.task_tags?.length ?? 0,
        hook_events_synced: payload.hook_events?.length ?? 0,
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  return { server, received };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── Test suite ──

describe("zozul sync e2e", () => {
  let dbPath: string;
  let repo: SessionRepo;
  let db: ReturnType<typeof getDb>;
  let server: http.Server;
  let received: Record<string, unknown[]>;
  let client: ZozulApiClient;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `zozul-test-${Date.now()}.db`);
    db = getDb(dbPath);
    repo = new SessionRepo(db);

    const mock = createMockServer();
    server = mock.server;
    received = mock.received;
    const port = await listen(server);
    client = new ZozulApiClient({
      apiUrl: `http://127.0.0.1:${port}`,
      apiKey: "test-key",
    });
  });

  afterEach(async () => {
    db.close();
    await close(server);
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + "-wal"); } catch {}
    try { fs.unlinkSync(dbPath + "-shm"); } catch {}
  });

  it("syncs a session with all child data in one request", async () => {
    // Seed session
    repo.upsertSession({
      id: "sess-001",
      project_path: "/projects/test",
      started_at: "2026-03-28T10:00:00Z",
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cache_read_tokens: 20,
      total_cache_creation_tokens: 5,
      total_cost_usd: 0.01,
      total_turns: 2,
      total_duration_ms: 5000,
      model: "claude-sonnet-4-6",
    });

    // Seed turns
    const turnId = repo.insertTurn({
      session_id: "sess-001",
      turn_index: 0,
      role: "human",
      timestamp: "2026-03-28T10:00:01Z",
      input_tokens: 50,
      output_tokens: 0,
      cache_read_tokens: 10,
      cache_creation_tokens: 0,
      cost_usd: 0.005,
      duration_ms: 1000,
      model: "claude-sonnet-4-6",
      content_text: "Hello",
      tool_calls: null,
      is_real_user: 1,
    });

    repo.insertTurn({
      session_id: "sess-001",
      turn_index: 1,
      role: "assistant",
      timestamp: "2026-03-28T10:00:02Z",
      input_tokens: 50,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_creation_tokens: 5,
      cost_usd: 0.005,
      duration_ms: 4000,
      model: "claude-sonnet-4-6",
      content_text: "Hi there!",
      tool_calls: JSON.stringify([{ toolName: "Read", toolInput: { path: "/tmp" } }]),
      is_real_user: 0,
    });

    // Seed tool use
    repo.insertToolUse({
      session_id: "sess-001",
      turn_id: turnId,
      tool_name: "Read",
      tool_input: JSON.stringify({ path: "/tmp" }),
      tool_result: "file contents",
      success: 1,
      duration_ms: 200,
      timestamp: "2026-03-28T10:00:02Z",
    });

    // Seed hook event
    repo.insertHookEvent({
      session_id: "sess-001",
      event_name: "UserPromptSubmit",
      timestamp: "2026-03-28T10:00:01Z",
      payload: JSON.stringify({ prompt: "Hello" }),
    });

    // Seed otel metric
    repo.insertOtelMetric({
      name: "claude_code.token.usage",
      value: 100,
      attributes: JSON.stringify({ type: "input" }),
      session_id: "sess-001",
      model: "claude-sonnet-4-6",
      timestamp: "2026-03-28T10:00:02Z",
    });

    // Seed otel event
    repo.insertOtelEvent({
      event_name: "claude_code.conversation.turn",
      attributes: JSON.stringify({ role: "human" }),
      session_id: "sess-001",
      prompt_id: "prompt-001",
      timestamp: "2026-03-28T10:00:01Z",
    });

    // Seed task tag
    repo.tagTurn(turnId, "FEAT-123");

    // ── Run sync ──
    const result = await runSync(repo, client, { verbose: false });

    // ── Verify counts ──
    expect(result.sessions.synced).toBe(1);
    expect(result.sessions.failed).toBe(0);
    expect(result.otel_metrics.synced).toBe(1);
    expect(result.otel_events.synced).toBe(1);

    // ── Verify session sync payload ──
    const syncPayloads = received["/api/v1/sessions/sess-001/sync"];
    expect(syncPayloads).toHaveLength(1);
    const payload = syncPayloads[0] as Record<string, unknown>;

    // Session
    expect(payload.session).toMatchObject({ id: "sess-001", model: "claude-sonnet-4-6" });

    // Turns — uses turn_index, no session_id (session is implicit)
    const turns = payload.turns as Record<string, unknown>[];
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ turn_index: 0, is_real_user: true });
    expect(turns[1]).toMatchObject({ turn_index: 1, is_real_user: false });
    expect(turns[1].tool_calls).toEqual([{ toolName: "Read", toolInput: { path: "/tmp" } }]);

    // Tool uses — uses turn_index instead of turn_id
    const toolUses = payload.tool_uses as Record<string, unknown>[];
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({ tool_name: "Read", success: true, turn_index: 0 });
    expect(toolUses[0].tool_input).toEqual({ path: "/tmp" });
    expect(toolUses[0]).not.toHaveProperty("turn_id");
    expect(toolUses[0]).not.toHaveProperty("session_id");

    // Hook events
    const hookEvents = payload.hook_events as Record<string, unknown>[];
    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0]).toMatchObject({ event_name: "UserPromptSubmit" });
    expect(hookEvents[0].payload).toEqual({ prompt: "Hello" });

    // Task tags — uses turn_index
    const taskTags = payload.task_tags as Record<string, unknown>[];
    expect(taskTags).toHaveLength(1);
    expect(taskTags[0]).toMatchObject({ task: "FEAT-123", turn_index: 0 });

    // OTel sent separately
    const otelMetrics = received["/api/v1/otel/metrics/bulk"] as Record<string, unknown>[];
    expect(otelMetrics).toHaveLength(1);
    expect(otelMetrics[0]).toMatchObject({ name: "claude_code.token.usage", value: 100 });

    const otelEvents = received["/api/v1/otel/events/bulk"] as Record<string, unknown>[];
    expect(otelEvents).toHaveLength(1);
    expect(otelEvents[0]).toMatchObject({ event_name: "claude_code.conversation.turn" });
  });

  it("is idempotent — second sync sends nothing", async () => {
    repo.upsertSession({
      id: "sess-002",
      project_path: null,
      started_at: "2026-03-28T11:00:00Z",
      total_input_tokens: 10,
      total_output_tokens: 10,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cost_usd: 0.001,
      total_turns: 1,
      total_duration_ms: 500,
      model: "claude-haiku-4-5",
    });

    repo.insertTurn({
      session_id: "sess-002",
      turn_index: 0,
      role: "human",
      timestamp: "2026-03-28T11:00:01Z",
      input_tokens: 10,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0.001,
      duration_ms: 500,
      model: "claude-haiku-4-5",
      content_text: "test",
      tool_calls: null,
      is_real_user: 1,
    });

    // First sync
    const r1 = await runSync(repo, client, {});
    expect(r1.sessions.synced).toBe(1);

    // Clear received payloads
    for (const key of Object.keys(received)) delete received[key];

    // Second sync
    const r2 = await runSync(repo, client, {});
    expect(r2.sessions.synced).toBe(0);
    expect(r2.otel_metrics.synced).toBe(0);
    expect(r2.otel_events.synced).toBe(0);
    expect(Object.keys(received)).toHaveLength(0);
  });

  it("incremental sync picks up only new sessions", async () => {
    repo.upsertSession({
      id: "sess-A",
      project_path: null,
      started_at: "2026-03-28T12:00:00Z",
      total_input_tokens: 10,
      total_output_tokens: 10,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cost_usd: 0.001,
      total_turns: 1,
      total_duration_ms: 100,
      model: null,
    });
    repo.insertTurn({
      session_id: "sess-A",
      turn_index: 0,
      role: "human",
      timestamp: "2026-03-28T12:00:01Z",
      input_tokens: 10,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0.001,
      duration_ms: 100,
      model: null,
      content_text: "first",
      tool_calls: null,
      is_real_user: 1,
    });

    await runSync(repo, client, {});
    for (const key of Object.keys(received)) delete received[key];

    // Add second session
    repo.upsertSession({
      id: "sess-B",
      project_path: "/new",
      started_at: "2026-03-28T13:00:00Z",
      total_input_tokens: 20,
      total_output_tokens: 20,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cost_usd: 0.002,
      total_turns: 1,
      total_duration_ms: 200,
      model: "claude-opus-4-6",
    });
    repo.insertTurn({
      session_id: "sess-B",
      turn_index: 0,
      role: "human",
      timestamp: "2026-03-28T13:00:01Z",
      input_tokens: 20,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0.002,
      duration_ms: 200,
      model: "claude-opus-4-6",
      content_text: "second",
      tool_calls: null,
      is_real_user: 1,
    });

    const r2 = await runSync(repo, client, {});
    expect(r2.sessions.synced).toBe(1);

    // Only sess-B should have been synced
    expect(received["/api/v1/sessions/sess-B/sync"]).toHaveLength(1);
    expect(received["/api/v1/sessions/sess-A/sync"]).toBeUndefined();
  });

  it("dry-run does not send data or update watermarks", async () => {
    repo.upsertSession({
      id: "sess-dry",
      project_path: null,
      started_at: "2026-03-28T14:00:00Z",
      total_input_tokens: 5,
      total_output_tokens: 5,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cost_usd: 0.0005,
      total_turns: 1,
      total_duration_ms: 50,
      model: null,
    });
    repo.insertTurn({
      session_id: "sess-dry",
      turn_index: 0,
      role: "human",
      timestamp: "2026-03-28T14:00:01Z",
      input_tokens: 5,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0.0005,
      duration_ms: 50,
      model: null,
      content_text: "dry",
      tool_calls: null,
      is_real_user: 1,
    });

    const result = await runSync(repo, client, { dryRun: true });
    expect(result.sessions.synced).toBe(1);
    expect(Object.keys(received)).toHaveLength(0);
    expect(repo.getSyncWatermark("sessions")).toBe(0);

    // Real sync after dry run should still work
    const r2 = await runSync(repo, client, {});
    expect(r2.sessions.synced).toBe(1);
    expect(received["/api/v1/sessions/sess-dry/sync"]).toHaveLength(1);
  });

  it("handles server errors gracefully", async () => {
    repo.upsertSession({
      id: "sess-err",
      project_path: null,
      started_at: "2026-03-28T15:00:00Z",
      total_input_tokens: 10,
      total_output_tokens: 10,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cost_usd: 0.001,
      total_turns: 1,
      total_duration_ms: 100,
      model: null,
    });
    repo.insertTurn({
      session_id: "sess-err",
      turn_index: 0,
      role: "human",
      timestamp: "2026-03-28T15:00:01Z",
      input_tokens: 10,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0.001,
      duration_ms: 100,
      model: null,
      content_text: "error test",
      tool_calls: null,
      is_real_user: 1,
    });

    await close(server);

    const result = await runSync(repo, client, {});
    expect(result.sessions.failed).toBe(1);
    expect(repo.getSyncWatermark("sessions")).toBe(0);
  });
});
