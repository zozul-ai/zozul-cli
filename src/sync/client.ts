import type { SessionSyncPayload, ApiOtelMetric, ApiOtelEvent } from "./transform.js";

export interface SyncClientConfig {
  apiUrl: string;
  apiKey: string;
  timeout?: number;
}

export interface SessionSyncResponse {
  session_id: string;
  turns_synced: number;
  tool_uses_synced: number;
  task_tags_synced: number;
  hook_events_synced: number;
}

export class ZozulApiClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(config: SyncClientConfig) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30_000;
  }

  async syncSession(sessionId: string, payload: SessionSyncPayload): Promise<SessionSyncResponse> {
    return this.post(`/api/v1/sessions/${sessionId}/sync`, payload);
  }

  async postOtelMetricsBulk(metrics: ApiOtelMetric[]): Promise<void> {
    await this.post("/api/v1/otel/metrics/bulk", metrics);
  }

  async postOtelEventsBulk(events: ApiOtelEvent[]): Promise<void> {
    await this.post("/api/v1/otel/events/bulk", events);
  }

  private async post<T = void>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST ${path} failed: ${res.status} ${res.statusText} — ${text}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await res.json()) as T;
    }
    return undefined as T;
  }
}
