import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionRepo } from "../storage/repo.js";
import { ingestSessionFile } from "./ingest.js";
import { discoverSessionFiles } from "./jsonl.js";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const DEBOUNCE_MS = 500;

export interface WatcherOptions {
  repo: SessionRepo;
  verbose?: boolean;
  /** Re-ingest all existing JSONL files on startup to catch up on missed sessions. Default true. */
  catchUp?: boolean;
}

/**
 * Watch ~/.claude/projects for JSONL session file changes and ingest them
 * into the database as they are written. Returns a stop function.
 *
 * On startup, performs an initial catch-up pass so that sessions written
 * while zozul was not running are immediately available.
 */
export async function watchSessionFiles(opts: WatcherOptions): Promise<() => void> {
  const { repo, verbose } = opts;
  const catchUp = opts.catchUp ?? true;

  // ── Initial catch-up pass ──
  if (catchUp) {
    const files = discoverSessionFiles();
    let caught = 0;
    for (const { filePath, projectPath } of files) {
      try {
        await ingestSessionFile(repo, filePath, projectPath);
        caught++;
      } catch {
        // Ignore parse errors on individual files
      }
    }
    if (verbose && caught > 0) {
      process.stderr.write(`[watcher] catch-up: ingested ${caught} session file(s)\n`);
    }
  }

  if (!fs.existsSync(PROJECTS_DIR)) {
    if (verbose) {
      process.stderr.write(`[watcher] ${PROJECTS_DIR} not found, watching skipped\n`);
    }
    return () => {};
  }

  // ── Per-file debounce ──
  const timers = new Map<string, NodeJS.Timeout>();

  function scheduleIngest(filePath: string) {
    const existing = timers.get(filePath);
    if (existing) clearTimeout(existing);

    timers.set(filePath, setTimeout(async () => {
      timers.delete(filePath);
      try {
        const projectPath = decodeProjectPath(filePath);
        await ingestSessionFile(repo, filePath, projectPath ?? undefined);
        if (verbose) {
          process.stderr.write(`[watcher] ingested: ${filePath}\n`);
        }
      } catch (err) {
        if (verbose) {
          process.stderr.write(`[watcher] ingest failed (${filePath}): ${err}\n`);
        }
      }
    }, DEBOUNCE_MS));
  }

  // ── fs.watch with recursive ──
  // recursive: true uses FSEvents on macOS and ReadDirectoryChangesW on Windows.
  const watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (!filename.endsWith(".jsonl")) return;

    // filename is relative to PROJECTS_DIR on macOS/Windows
    const filePath = path.join(PROJECTS_DIR, filename);

    // Only act if the file actually exists (ignore delete events)
    if (!fs.existsSync(filePath)) return;

    scheduleIngest(filePath);
  });

  watcher.on("error", (err) => {
    if (verbose) process.stderr.write(`[watcher] error: ${err}\n`);
  });

  if (verbose) {
    process.stderr.write(`[watcher] watching ${PROJECTS_DIR}\n`);
  }

  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}

/**
 * Extract the decoded project path from an absolute JSONL file path.
 * ~/.claude/projects/<encoded>/<uuid>.jsonl
 * where <encoded> has "/" replaced with "-".
 */
function decodeProjectPath(filePath: string): string | null {
  // Match project dir directly containing the UUID file
  const match = filePath.match(/projects\/([^/]+)\/[0-9a-f-]{36}\.jsonl$/i);
  if (!match) return null;
  return match[1].replace(/-/g, "/");
}
