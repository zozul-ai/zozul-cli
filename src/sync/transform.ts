import type {
  SessionRow, TurnRow, ToolUseRow, HookEventRow, TaskTagRow,
} from "../storage/db.js";

// ── API payload types (matches POST /sessions/{id}/sync) ──

export type ApiSession = {
  id: string;
  project_path: string | null;
  started_at: string;
  ended_at: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  total_turns: number;
  total_duration_ms: number;
  model: string | null;
};

export type ApiTurn = {
  turn_index: number;
  role: string;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  duration_ms: number;
  model: string | null;
  content_text: string | null;
  tool_calls: unknown[] | null;
  is_real_user: boolean;
};

export type ApiToolUse = {
  turn_index: number | null;
  tool_name: string;
  tool_input: unknown | null;
  tool_result: string | null;
  success: boolean | null;
  duration_ms: number;
  timestamp: string;
};

export type ApiHookEvent = {
  event_name: string;
  timestamp: string;
  payload: unknown;
};

export type ApiTaskTag = {
  turn_index: number | null;
  task: string;
  tagged_at: string;
};

export type ApiOtelMetric = {
  name: string;
  value: number;
  attributes: unknown | null;
  session_id: string | null;
  model: string | null;
  timestamp: string;
};

export type ApiOtelEvent = {
  event_name: string;
  attributes: unknown | null;
  session_id: string | null;
  prompt_id: string | null;
  timestamp: string;
};

export type SessionSyncPayload = {
  session: ApiSession;
  turns: ApiTurn[];
  tool_uses: ApiToolUse[];
  task_tags: ApiTaskTag[];
  hook_events: ApiHookEvent[];
};

// ── Safe JSON parse ──

function safeJsonParse(value: string | null): unknown | null {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ── Turn lookup: local turn_id → turn_index ──

export type TurnLookup = Map<number, number>; // turn_id → turn_index

// ── Transform functions ──

export function transformSession(row: SessionRow): ApiSession {
  return {
    id: row.id,
    project_path: row.project_path,
    started_at: row.started_at,
    ended_at: row.ended_at,
    total_input_tokens: row.total_input_tokens,
    total_output_tokens: row.total_output_tokens,
    total_cache_read_tokens: row.total_cache_read_tokens,
    total_cache_creation_tokens: row.total_cache_creation_tokens,
    total_cost_usd: row.total_cost_usd,
    total_turns: row.total_turns,
    total_duration_ms: row.total_duration_ms,
    model: row.model,
  };
}

export function transformTurn(row: TurnRow): ApiTurn {
  return {
    turn_index: row.turn_index,
    role: row.role,
    timestamp: row.timestamp,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    cost_usd: row.cost_usd,
    duration_ms: row.duration_ms,
    model: row.model,
    content_text: row.content_text,
    tool_calls: safeJsonParse(row.tool_calls) as unknown[] | null,
    is_real_user: row.is_real_user === 1,
  };
}

export function transformToolUse(row: ToolUseRow, turnLookup: TurnLookup): ApiToolUse {
  return {
    turn_index: row.turn_id != null ? (turnLookup.get(row.turn_id) ?? null) : null,
    tool_name: row.tool_name,
    tool_input: safeJsonParse(row.tool_input),
    tool_result: row.tool_result,
    success: row.success == null ? null : row.success === 1,
    duration_ms: row.duration_ms,
    timestamp: row.timestamp,
  };
}

export function transformHookEvent(row: HookEventRow): ApiHookEvent {
  return {
    event_name: row.event_name,
    timestamp: row.timestamp,
    payload: safeJsonParse(row.payload) ?? row.payload,
  };
}

export function transformTaskTag(row: TaskTagRow, turnLookup: TurnLookup): ApiTaskTag {
  return {
    turn_index: turnLookup.get(row.turn_id) ?? null,
    task: row.task,
    tagged_at: row.tagged_at,
  };
}

export function transformOtelMetric(row: import("../storage/db.js").OtelMetricRow): ApiOtelMetric {
  return {
    name: row.name,
    value: row.value,
    attributes: safeJsonParse(row.attributes),
    session_id: row.session_id,
    model: row.model,
    timestamp: row.timestamp,
  };
}

export function transformOtelEvent(row: import("../storage/db.js").OtelEventRow): ApiOtelEvent {
  return {
    event_name: row.event_name,
    attributes: safeJsonParse(row.attributes),
    session_id: row.session_id,
    prompt_id: row.prompt_id,
    timestamp: row.timestamp,
  };
}
