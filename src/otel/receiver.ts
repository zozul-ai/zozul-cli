import type { SessionRepo } from "../storage/repo.js";

/**
 * Parse OTLP JSON metrics export and store in SQLite.
 *
 * Claude Code sends metrics in the standard OTLP JSON format:
 * { resourceMetrics: [{ scopeMetrics: [{ metrics: [...] }] }] }
 *
 * Each metric has data points with attributes, timestamps, and values.
 */
type SessionDelta = {
  costDelta: number;
  inputDelta: number;
  outputDelta: number;
  cacheReadDelta: number;
  cacheCreationDelta: number;
  durationMsDelta: number;
  latestTimestamp: string;
  model: string | null;
};

export function handleOtlpMetrics(body: string, repo: SessionRepo, verbose?: boolean): number {
  const payload = JSON.parse(body);
  const resourceMetrics = payload.resourceMetrics ?? [];
  const batch: Parameters<typeof repo.insertOtelMetricBatch>[0] = [];
  const sessionDeltas = new Map<string, SessionDelta>();

  for (const rm of resourceMetrics) {
    const resourceAttrs = flattenAttributes(rm.resource?.attributes);

    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        const metricName: string = metric.name ?? "unknown";
        const dataPoints = extractDataPoints(metric);

        for (const dp of dataPoints) {
          const attrs = flattenAttributes(dp.attributes as unknown[] | undefined);
          const merged = { ...resourceAttrs, ...attrs };

          const rawValue = dp.asDouble ?? dp.asInt ?? dp.value ?? 0;
          const value = typeof rawValue === "string" ? parseFloat(rawValue) : Number(rawValue);
          const ts = nanoToIso(dp.timeUnixNano as string | number | undefined ?? dp.startTimeUnixNano as string | number | undefined);

          batch.push({
            name: metricName,
            value,
            attributes: JSON.stringify(merged),
            session_id: merged["session.id"] ?? null,
            model: merged["model"] ?? null,
            timestamp: ts,
          });

          // Accumulate per-session deltas to keep sessions table current
          const sid = merged["session.id"];
          if (sid) {
            if (!sessionDeltas.has(sid)) {
              sessionDeltas.set(sid, {
                costDelta: 0, inputDelta: 0, outputDelta: 0,
                cacheReadDelta: 0, cacheCreationDelta: 0, durationMsDelta: 0,
                latestTimestamp: ts, model: merged["model"] ?? null,
              });
            }
            const d = sessionDeltas.get(sid)!;
            if (ts > d.latestTimestamp) d.latestTimestamp = ts;
            if (merged["model"]) d.model = merged["model"];

            if (metricName === "claude_code.cost.usage") {
              d.costDelta += value;
            } else if (metricName === "claude_code.token.usage") {
              const type = merged["type"];
              if (type === "input")         d.inputDelta += value;
              else if (type === "output")   d.outputDelta += value;
              else if (type === "cacheRead") d.cacheReadDelta += value;
              else if (type === "cacheCreation") d.cacheCreationDelta += value;
            } else if (metricName === "claude_code.active_time.total") {
              d.durationMsDelta += value * 1000; // seconds → ms
            }
          }
        }
      }
    }
  }

  if (batch.length > 0) {
    repo.insertOtelMetricBatch(batch);
    for (const [sessionId, deltas] of sessionDeltas) {
      repo.updateSessionFromOtel(sessionId, deltas);
    }
    if (verbose) {
      process.stderr.write(`  otel: stored ${batch.length} metric data points across ${sessionDeltas.size} session(s)\n`);
    }
  }

  return batch.length;
}

/**
 * Parse OTLP JSON logs/events export and store in SQLite.
 *
 * Claude Code sends events in the standard OTLP JSON logs format:
 * { resourceLogs: [{ scopeLogs: [{ logRecords: [...] }] }] }
 */
export function handleOtlpLogs(body: string, repo: SessionRepo, verbose?: boolean): number {
  const payload = JSON.parse(body);
  const resourceLogs = payload.resourceLogs ?? [];
  const batch: Parameters<typeof repo.insertOtelEventBatch>[0] = [];

  for (const rl of resourceLogs) {
    const resourceAttrs = flattenAttributes(rl.resource?.attributes);

    for (const sl of rl.scopeLogs ?? []) {
      for (const record of sl.logRecords ?? []) {
        const attrs = flattenAttributes(record.attributes);
        const merged = { ...resourceAttrs, ...attrs };

        const eventName = merged["event.name"]
          ?? record.body?.stringValue
          ?? "unknown";
        const ts = nanoToIso(record.timeUnixNano ?? record.observedTimeUnixNano);

        batch.push({
          event_name: eventName,
          attributes: JSON.stringify(merged),
          session_id: merged["session.id"] ?? null,
          prompt_id: merged["prompt.id"] ?? null,
          timestamp: ts,
        });
      }
    }
  }

  if (batch.length > 0) {
    repo.insertOtelEventBatch(batch);
    if (verbose) {
      process.stderr.write(`  otel: stored ${batch.length} log events\n`);
    }
  }

  return batch.length;
}

/**
 * OTLP metrics contain data inside different structures depending on type.
 * Extract the data points array from whichever wrapper is present.
 */
function extractDataPoints(metric: Record<string, unknown>): Record<string, unknown>[] {
  if (metric.sum) return (metric.sum as Record<string, unknown>).dataPoints as Record<string, unknown>[] ?? [];
  if (metric.gauge) return (metric.gauge as Record<string, unknown>).dataPoints as Record<string, unknown>[] ?? [];
  if (metric.histogram) return (metric.histogram as Record<string, unknown>).dataPoints as Record<string, unknown>[] ?? [];
  if (metric.summary) return (metric.summary as Record<string, unknown>).dataPoints as Record<string, unknown>[] ?? [];
  return [];
}

/**
 * OTLP attributes are arrays of { key, value: { stringValue|intValue|... } }.
 * Flatten them into a plain { key: value } object.
 */
function flattenAttributes(attrs: unknown[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(attrs)) return result;

  for (const attr of attrs) {
    const a = attr as { key: string; value?: Record<string, unknown> };
    if (!a.key || !a.value) continue;

    const v = a.value.stringValue
      ?? a.value.intValue
      ?? a.value.doubleValue
      ?? a.value.boolValue;

    if (v !== undefined && v !== null) {
      result[a.key] = String(v);
    }
  }

  return result;
}

function nanoToIso(nanos: string | number | undefined): string {
  if (!nanos) return new Date().toISOString();
  const ms = typeof nanos === "string" ? parseInt(nanos, 10) / 1_000_000 : nanos / 1_000_000;
  return new Date(ms).toISOString();
}
