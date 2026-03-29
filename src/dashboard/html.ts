import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function rawHtml(): string {
  return readFileSync(join(__dirname, "index.html"), "utf-8");
}

/** Local-only dashboard (no remote toggle). */
export function dashboardHtml(): string {
  return rawHtml();
}

/**
 * Dashboard with a Local / Remote toggle.
 * When remote config is provided, the user can switch between local SQLite
 * and the remote backend API via a toggle in the header.
 * `mode` sets the initial active source.
 */
export function dashboardHtmlWithToggle(remote: { apiUrl: string; apiKey: string }, mode: "local" | "remote" = "local"): string {
  const baseUrl = remote.apiUrl.replace(/\/+$/, "") + "/api/v1";
  let html = rawHtml();

  const configScript = `
<script>
const ZOZUL_CONFIG = {
  remote: { baseUrl: ${JSON.stringify(baseUrl)}, apiKey: ${JSON.stringify(remote.apiKey)} },
  mode: ${JSON.stringify(mode)},
};
</script>`;

  html = html.replace("<script>\nlet chartInstances", configScript + "\n<script>\nlet chartInstances");

  // Replace fetchJson to route based on active mode
  html = html.replace(
    `async function fetchJson(path) {\n  const res = await fetch(path);\n  if (!res.ok) throw new Error(res.status + ' ' + path);\n  return res.json();\n}`,
    `async function fetchJson(path) {
  if (ZOZUL_CONFIG && ZOZUL_CONFIG.mode === 'remote') {
    const url = ZOZUL_CONFIG.remote.baseUrl + path.replace('/api/', '/');
    const res = await fetch(url, { headers: { 'X-API-Key': ZOZUL_CONFIG.remote.apiKey } });
    if (!res.ok) throw new Error(res.status + ' ' + url);
    return res.json();
  }
  const res = await fetch(path);
  if (!res.ok) throw new Error(res.status + ' ' + path);
  return res.json();
}`,
  );

  // Inject toggle button into the header-right div
  const toggleHtml = `
    <div style="display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;font-size:12px">
      <button id="src-local" onclick="switchSource('local')"
        style="padding:4px 12px;border:none;cursor:pointer;font-size:12px;font-family:inherit;transition:all 0.15s">Local</button>
      <button id="src-remote" onclick="switchSource('remote')"
        style="padding:4px 12px;border:none;cursor:pointer;font-size:12px;font-family:inherit;transition:all 0.15s">Remote</button>
    </div>`;

  html = html.replace(
    '<div class="header-right">',
    '<div class="header-right">' + toggleHtml,
  );

  // Inject switchSource function and initial toggle state
  const switchScript = `
function switchSource(mode) {
  ZOZUL_CONFIG.mode = mode;
  const local = document.getElementById('src-local');
  const remote = document.getElementById('src-remote');
  const activeStyle = 'background:var(--accent);color:#fff;';
  const inactiveStyle = 'background:var(--surface);color:var(--text-dim);';
  local.style.cssText += (mode === 'local' ? activeStyle : inactiveStyle);
  remote.style.cssText += (mode === 'remote' ? activeStyle : inactiveStyle);
  document.title = 'zozul — ' + (mode === 'local' ? 'Local' : 'Remote') + ' Dashboard';
  loadDashboard();
}

// Set initial toggle state on load
document.addEventListener('DOMContentLoaded', () => switchSource(ZOZUL_CONFIG.mode));
`;

  // Must target the top-level bootstrap call (last occurrence), not the one inside manualRefresh()
  const bootstrapCall = "loadDashboard().then(scheduleAutoRefresh);";
  const lastIdx = html.lastIndexOf(bootstrapCall);
  html = html.slice(0, lastIdx) + switchScript + "\n" + bootstrapCall + html.slice(lastIdx + bootstrapCall.length);

  return html;
}

/**
 * Remote-only dashboard (no local API available).
 */
export function remoteDashboardHtml(apiUrl: string, apiKey: string): string {
  return dashboardHtmlWithToggle({ apiUrl, apiKey }, "remote");
}
