import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const CONTEXT_PATH = path.join(os.homedir(), ".zozul", "context.json");

export interface TaskContext {
  active: string[];
  set_at: string;
}

export function getActiveContext(): TaskContext | null {
  if (!fs.existsSync(CONTEXT_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(CONTEXT_PATH, "utf-8"));
    // Support legacy single-string format
    if (typeof data.active === "string") {
      return { active: [data.active], set_at: data.set_at ?? "" };
    }
    if (Array.isArray(data.active) && data.active.length > 0) {
      return { active: data.active, set_at: data.set_at ?? "" };
    }
    return null;
  } catch {
    return null;
  }
}

export function setActiveContext(tasks: string[]): TaskContext {
  const tags = tasks.map(t => t.trim()).filter(Boolean);
  if (tags.length === 0) throw new Error("At least one tag is required");
  const ctx: TaskContext = { active: tags, set_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(CONTEXT_PATH), { recursive: true });
  fs.writeFileSync(CONTEXT_PATH, JSON.stringify(ctx, null, 2) + "\n");
  return ctx;
}

export function clearActiveContext(): void {
  if (fs.existsSync(CONTEXT_PATH)) {
    fs.unlinkSync(CONTEXT_PATH);
  }
}
