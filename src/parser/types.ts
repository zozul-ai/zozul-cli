/**
 * Types representing the JSONL session file format that Claude Code writes to:
 * ~/.claude/projects/<encoded-path>/sessions/<session-uuid>.jsonl
 *
 * Each line is one JSON object. The first line is typically a summary.
 * Subsequent lines are user/assistant messages with full content.
 */

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

export interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface MessagePayload {
  role: string;
  content: string | ContentBlock[];
  model?: string;
  usage?: UsageInfo;
}

export interface SessionEntry {
  type: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  message?: MessagePayload;
  requestId?: string;
  costUSD?: number;
  durationMs?: number;
  isSidechain?: boolean;

  // Summary-specific fields
  summary?: string;
  leafUuid?: string;
  numLeaves?: number;
}

export interface ParsedSession {
  sessionId: string;
  projectPath: string | null;
  startedAt: string;
  endedAt: string | null;
  model: string | null;
  turns: ParsedTurn[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
}

export interface ParsedTurn {
  turnIndex: number;
  role: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  model: string | null;
  contentText: string;
  toolCalls: ToolCallInfo[];
}

export interface ToolCallInfo {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: string;
}
