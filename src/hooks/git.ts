import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const HOOK_MARKER = "# zozul: auto-clear context on commit";

function getGitHookPath(hookName: string): string | null {
  try {
    const gitDir = execSync("git rev-parse --git-dir", { encoding: "utf-8" }).trim();
    return path.join(gitDir, "hooks", hookName);
  } catch {
    return null;
  }
}

const HOOK_SCRIPT = `
${HOOK_MARKER}
if command -v zozul >/dev/null 2>&1; then
  zozul context --clear 2>/dev/null
fi
`;

export function installGitHook(): { path: string; created: boolean } | null {
  const hookPath = getGitHookPath("post-commit");
  if (!hookPath) return null;

  fs.mkdirSync(path.dirname(hookPath), { recursive: true });

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, "utf-8");
    if (existing.includes(HOOK_MARKER)) {
      return { path: hookPath, created: false };
    }
    // Append to existing hook
    fs.appendFileSync(hookPath, "\n" + HOOK_SCRIPT);
  } else {
    fs.writeFileSync(hookPath, "#!/bin/sh\n" + HOOK_SCRIPT);
  }

  fs.chmodSync(hookPath, 0o755);
  return { path: hookPath, created: true };
}

export function uninstallGitHook(): boolean {
  const hookPath = getGitHookPath("post-commit");
  if (!hookPath || !fs.existsSync(hookPath)) return false;

  const content = fs.readFileSync(hookPath, "utf-8");
  if (!content.includes(HOOK_MARKER)) return false;

  // Remove the zozul block
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.includes(HOOK_MARKER)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.trim() === "fi") {
      inBlock = false;
      continue;
    }
    if (inBlock) continue;
    filtered.push(line);
  }

  const remaining = filtered.join("\n").trim();
  if (remaining === "#!/bin/sh" || remaining === "") {
    fs.unlinkSync(hookPath);
  } else {
    fs.writeFileSync(hookPath, remaining + "\n");
    fs.chmodSync(hookPath, 0o755);
  }

  return true;
}
