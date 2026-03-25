import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface OtelConfig {
  /** OTLP endpoint, e.g. http://localhost:4317 */
  endpoint: string;
  /** Protocol: grpc, http/json, or http/protobuf */
  protocol: "grpc" | "http/json" | "http/protobuf";
  /** Whether to log user prompt content */
  logUserPrompts: boolean;
  /** Whether to log MCP/tool detail names */
  logToolDetails: boolean;
  /** Metrics export interval in ms */
  metricsInterval: number;
  /** Logs export interval in ms */
  logsInterval: number;
  /** Optional auth header */
  authHeader?: string;
}

const DEFAULT_CONFIG: OtelConfig = {
  endpoint: "http://localhost:7890",
  protocol: "http/json",
  logUserPrompts: true,
  logToolDetails: true,
  metricsInterval: 60000,
  logsInterval: 5000,
};

/**
 * Generate the set of environment variables needed to enable
 * Claude Code's built-in OpenTelemetry export.
 */
export function generateOtelEnvVars(config: Partial<OtelConfig> = {}): Record<string, string> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: cfg.protocol,
    OTEL_EXPORTER_OTLP_ENDPOINT: cfg.endpoint,
    OTEL_METRIC_EXPORT_INTERVAL: String(cfg.metricsInterval),
    OTEL_LOGS_EXPORT_INTERVAL: String(cfg.logsInterval),
  };

  if (cfg.logUserPrompts) {
    env.OTEL_LOG_USER_PROMPTS = "1";
  }
  if (cfg.logToolDetails) {
    env.OTEL_LOG_TOOL_DETAILS = "1";
  }
  if (cfg.authHeader) {
    env.OTEL_EXPORTER_OTLP_HEADERS = cfg.authHeader;
  }

  return env;
}

/**
 * Generate a shell script that exports all required OTEL env vars.
 */
export function generateOtelShellExports(config: Partial<OtelConfig> = {}): string {
  const env = generateOtelEnvVars(config);
  const lines = Object.entries(env).map(
    ([key, value]) => `export ${key}="${value}"`,
  );
  return lines.join("\n") + "\n";
}

/**
 * Write the OTEL env vars into Claude Code's settings.json under the "env" key.
 */
export function installOtelToSettings(config: Partial<OtelConfig> = {}): { path: string } {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let existing: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const envVars = generateOtelEnvVars(config);
  const existingEnv = (existing.env ?? {}) as Record<string, string>;
  existing.env = { ...existingEnv, ...envVars };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");

  return { path: settingsPath };
}

/**
 * Remove zozul OTEL env vars from Claude Code's settings.json.
 */
export function uninstallOtelFromSettings(): boolean {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return false;

  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return false;
  }

  const env = existing.env as Record<string, string> | undefined;
  if (!env) return false;

  const otelKeys = [
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_METRIC_EXPORT_INTERVAL",
    "OTEL_LOGS_EXPORT_INTERVAL",
    "OTEL_LOG_USER_PROMPTS",
    "OTEL_LOG_TOOL_DETAILS",
    "OTEL_EXPORTER_OTLP_HEADERS",
  ];

  let removed = false;
  for (const key of otelKeys) {
    if (key in env) {
      delete env[key];
      removed = true;
    }
  }

  if (Object.keys(env).length === 0) {
    delete existing.env;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");
  return removed;
}
