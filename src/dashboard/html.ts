import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function rawHtml(): string {
  return readFileSync(join(__dirname, "index.html"), "utf-8");
}

/** Local-only dashboard (no remote config). */
export function dashboardHtml(): string {
  return rawHtml();
}

/**
 * Dashboard with remote API config injected for auto-fallback.
 * The dashboard auto-detects whether remote is available (health check)
 * and falls back to local if not.
 */
export function dashboardHtmlWithToggle(remote: { apiUrl: string; apiKey: string }, _mode: "local" | "remote" = "local"): string {
  const baseUrl = remote.apiUrl.replace(/\/+$/, "") + "/api/v1";
  let html = rawHtml();

  const configScript = `
<script>
const ZOZUL_CONFIG = {
  remote: { baseUrl: ${JSON.stringify(baseUrl)}, apiKey: ${JSON.stringify(remote.apiKey)} },
};
</script>`;

  // Inject config before the main script block
  html = html.replace("<script>\n// ── State ──", configScript + "\n<script>\n// ── State ──");

  return html;
}

/**
 * Remote-only dashboard (no local API available).
 */
export function remoteDashboardHtml(apiUrl: string, apiKey: string): string {
  return dashboardHtmlWithToggle({ apiUrl, apiKey }, "remote");
}
