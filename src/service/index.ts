import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const LABEL = "com.zozul.serve";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const SYSTEMD_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const SYSTEMD_PATH = path.join(SYSTEMD_DIR, "zozul.service");
const LOG_PATH = path.join(os.homedir(), ".zozul", "zozul.log");

export interface ServiceInstallOptions {
  port: number;
  dbPath?: string;
}

export interface ServiceResult {
  platform: "macos" | "linux" | "unsupported";
  servicePath: string;
  alreadyRunning: boolean;
}

/**
 * Install and immediately start zozul as a background service.
 * Uses launchd on macOS, systemd --user on Linux.
 */
export function installService(opts: ServiceInstallOptions): ServiceResult {
  const platform = detectPlatform();
  if (platform === "unsupported") {
    throw new Error(`Service install is not supported on ${process.platform}. Run 'zozul serve' manually.`);
  }

  // Build env vars to bake into the service so it doesn't depend on .env
  const env: Record<string, string> = {
    ZOZUL_PORT: String(opts.port),
  };
  if (opts.dbPath) env.ZOZUL_DB_PATH = opts.dbPath;

  if (platform === "macos") {
    return installLaunchd(env);
  } else {
    return installSystemd(env);
  }
}

/**
 * Stop and remove the zozul background service.
 */
export function uninstallService(): { removed: boolean; platform: "macos" | "linux" | "unsupported" } {
  const platform = detectPlatform();

  if (platform === "macos") {
    let removed = false;
    if (fs.existsSync(PLIST_PATH)) {
      try {
        const uid = os.userInfo().uid;
        execSync(`launchctl bootout gui/${uid}/${LABEL}`, { stdio: "ignore" });
      } catch {
        // Not loaded — that's fine
      }
      fs.unlinkSync(PLIST_PATH);
      removed = true;
    }
    return { removed, platform };
  }

  if (platform === "linux") {
    let removed = false;
    if (fs.existsSync(SYSTEMD_PATH)) {
      try {
        execSync("systemctl --user disable --now zozul", { stdio: "ignore" });
      } catch {
        // Not enabled — that's fine
      }
      fs.unlinkSync(SYSTEMD_PATH);
      try {
        execSync("systemctl --user daemon-reload", { stdio: "ignore" });
      } catch { /* ignore */ }
      removed = true;
    }
    return { removed, platform };
  }

  return { removed: false, platform: "unsupported" };
}

/**
 * Restart the running service in-place (kills and relaunches the current process).
 * Throws if the service is not installed.
 */
export function restartService(): void {
  const platform = detectPlatform();

  if (platform === "macos") {
    if (!fs.existsSync(PLIST_PATH)) throw new Error("Service is not installed. Run 'zozul install --service' first.");
    const uid = os.userInfo().uid;
    execSync(`launchctl kickstart -k gui/${uid}/${LABEL}`, { stdio: "ignore" });
    return;
  }

  if (platform === "linux") {
    if (!fs.existsSync(SYSTEMD_PATH)) throw new Error("Service is not installed. Run 'zozul install --service' first.");
    execSync("systemctl --user restart zozul", { stdio: "ignore" });
    return;
  }

  throw new Error("Service restart is not supported on this platform.");
}

/**
 * Returns a human-readable status string for the running service.
 */
export function serviceStatus(): string {
  const platform = detectPlatform();

  if (platform === "macos") {
    if (!fs.existsSync(PLIST_PATH)) return "not installed";
    try {
      const uid = os.userInfo().uid;
      const out = execSync(`launchctl print gui/${uid}/${LABEL} 2>&1`, { encoding: "utf-8" });
      const stateMatch = out.match(/state = (.+)/);
      const state = stateMatch?.[1]?.trim() ?? "unknown";
      const pidMatch = out.match(/pid = (\d+)/);
      if (pidMatch) return `running (pid ${pidMatch[1]})`;
      if (state === "running") return "running";
      if (state === "spawn scheduled") return "installed (starting…)";
      return `installed (${state})`;
    } catch {
      return "installed (not running)";
    }
  }

  if (platform === "linux") {
    if (!fs.existsSync(SYSTEMD_PATH)) return "not installed";
    try {
      execSync("systemctl --user is-active zozul", { stdio: "ignore" });
      return "running";
    } catch {
      return "installed (not running)";
    }
  }

  return "unsupported platform";
}

// ── macOS launchd ──

function installLaunchd(env: Record<string, string>): ServiceResult {
  const nodeBin = process.execPath;
  const scriptPath = path.resolve(process.argv[1]);

  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

  const envEntries = Object.entries(env)
    .map(([k, v]) => `\t\t<key>${k}</key>\n\t\t<string>${v}</string>`)
    .join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${nodeBin}</string>
\t\t<string>${scriptPath}</string>
\t\t<string>serve</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${envEntries}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${LOG_PATH}</string>
\t<key>StandardErrorPath</key>
\t<string>${LOG_PATH}</string>
\t<key>WorkingDirectory</key>
\t<string>${path.dirname(LOG_PATH)}</string>
</dict>
</plist>
`;

  fs.writeFileSync(PLIST_PATH, plist, "utf-8");

  // Unload any previous version first, then bootstrap
  let alreadyRunning = false;
  const uid = os.userInfo().uid;
  try {
    execSync(`launchctl bootout gui/${uid}/${LABEL}`, { stdio: "ignore" });
  } catch {
    // Wasn't loaded — fine
  }
  try {
    execSync(`launchctl bootstrap gui/${uid} "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already")) {
      alreadyRunning = true;
    } else {
      throw new Error(`launchctl bootstrap failed: ${msg}`);
    }
  }

  return { platform: "macos", servicePath: PLIST_PATH, alreadyRunning };
}

// ── Linux systemd ──

function installSystemd(env: Record<string, string>): ServiceResult {
  const nodeBin = process.execPath;
  const scriptPath = path.resolve(process.argv[1]);

  fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment="${k}=${v}"`)
    .join("\n");

  const unit = `[Unit]
Description=zozul — Agent Observability
After=network.target

[Service]
ExecStart=${nodeBin} ${scriptPath} serve
${envLines}
WorkingDirectory=${path.dirname(LOG_PATH)}
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}

[Install]
WantedBy=default.target
`;

  fs.writeFileSync(SYSTEMD_PATH, unit, "utf-8");

  execSync("systemctl --user daemon-reload", { stdio: "ignore" });

  let alreadyRunning = false;
  try {
    execSync("systemctl --user enable --now zozul", { stdio: "pipe" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already")) {
      alreadyRunning = true;
    } else {
      throw new Error(`systemctl enable failed: ${msg}`);
    }
  }

  return { platform: "linux", servicePath: SYSTEMD_PATH, alreadyRunning };
}

function detectPlatform(): "macos" | "linux" | "unsupported" {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "unsupported";
}
