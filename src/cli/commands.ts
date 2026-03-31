import { Command } from "commander";
import { getDb } from "../storage/db.js";
import { SessionRepo } from "../storage/repo.js";
import { createHookServer } from "../hooks/server.js";
import { installHooksToSettings, uninstallHooksFromSettings, generateHooksConfig } from "../hooks/config.js";
import { installOtelToSettings, uninstallOtelFromSettings, generateOtelShellExports } from "../otel/config.js";
import { ingestAllSessions } from "../parser/ingest.js";
import { watchSessionFiles } from "../parser/watcher.js";
import { installService, uninstallService, serviceStatus, restartService } from "../service/index.js";
import { getActiveContext, setActiveContext, clearActiveContext } from "../context/index.js";
import { installGitHook, uninstallGitHook } from "../hooks/git.js";
import { runSync } from "../sync/index.js";
import { ZozulApiClient } from "../sync/client.js";

function envPort(): string {
  return process.env.ZOZUL_PORT ?? "7890";
}
function envOtelEndpoint(): string {
  return process.env.OTEL_ENDPOINT ?? "http://localhost:7890";
}
function envOtelProtocol(): string {
  return process.env.OTEL_PROTOCOL ?? "http/json";
}
function envVerbose(): boolean {
  return process.env.ZOZUL_VERBOSE === "true" || process.env.ZOZUL_VERBOSE === "1";
}
function envDbPath(): string | undefined {
  return process.env.ZOZUL_DB_PATH || undefined;
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name("zozul")
    .description("Observability for Claude Code — track tokens, costs, turns, and conversations")
    .version("0.1.0");

  program
    .command("serve")
    .description("Start the hooks HTTP server to receive real-time events from Claude Code")
    .option("-p, --port <port>", "Port to listen on", envPort())
    .option("-v, --verbose", "Print events to stderr as they arrive")
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);
      const verbose = opts.verbose || envVerbose();
      const db = getDb(envDbPath());
      const repo = new SessionRepo(db);

      const apiUrl = process.env.ZOZUL_API_URL;
      const apiKey = process.env.ZOZUL_API_KEY;
      const syncClient = apiUrl && apiKey ? new ZozulApiClient({ apiUrl, apiKey }) : undefined;

      const server = createHookServer({ port, repo, verbose, syncClient });

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(`Port ${port} is already in use. Is zozul already running?`);
          console.error("  Check with: lsof -ti :" + port);
          db.close();
          process.exit(0); // clean exit so launchd/systemd won't respawn
        }
        throw err;
      });

      server.listen(port, async () => {
        console.log(`zozul listening on http://localhost:${port}`);
        console.log(`  Dashboard:     http://localhost:${port}/dashboard`);
        console.log(`  Hooks:         http://localhost:${port}/hook/<event>`);
        console.log(`  OTLP receiver: http://localhost:${port}/v1/metrics & /v1/logs`);
        console.log(`  API:           http://localhost:${port}/api/*`);
        console.log("\nPress Ctrl+C to stop.\n");

        const stopWatcher = await watchSessionFiles({ repo, verbose, catchUp: true });

        // Catch-up sync on start, then sync after every Stop/SessionEnd (wired in server)
        if (syncClient) {
          if (verbose) console.log("  Remote sync: enabled");
          runSync(repo, syncClient, { verbose }).catch(() => {});
        }

        process.on("SIGINT", () => {
          stopWatcher();
          server.close();
          db.close();
          process.exit(0);
        });
      });
    });

  program
    .command("install")
    .description("Install hooks, OTEL config, and optionally the background service")
    .option("-p, --port <port>", "Hook server port", envPort())
    .option("--otel-endpoint <endpoint>", "OTLP endpoint", envOtelEndpoint())
    .option("--otel-protocol <protocol>", "OTLP protocol", envOtelProtocol())
    .option("--no-otel", "Skip OTEL configuration")
    .option("--no-hooks", "Skip hooks configuration")
    .option("--service", "Also install zozul as a background service (starts on login)")
    .option("--status", "Show background service status")
    .option("--restart", "Restart the background service")
    .option("--dry-run", "Print the config that would be installed without writing")
    .action((opts) => {
      if (opts.status) {
        console.log(`Service status: ${serviceStatus()}`);
        return;
      }

      if (opts.restart) {
        try {
          restartService();
          console.log("Service restarted.");
          console.log(`  Status: ${serviceStatus()}`);
        } catch (err) {
          console.error(`Restart failed: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
        return;
      }

      const port = parseInt(opts.port, 10);

      if (opts.dryRun) {
        console.log("── Hooks Config (for ~/.claude/settings.json) ──\n");
        console.log(JSON.stringify(generateHooksConfig({ port }), null, 2));
        console.log("\n── OTEL Environment Variables ──\n");
        console.log(generateOtelShellExports({ endpoint: opts.otelEndpoint }));
        return;
      }

      if (opts.hooks !== false) {
        const result = installHooksToSettings({ port });
        console.log(`Hooks installed to ${result.path}`);
        if (result.merged) console.log("  (merged with existing hooks)");
      }

      if (opts.otel !== false) {
        const result = installOtelToSettings({
          endpoint: opts.otelEndpoint,
          protocol: opts.otelProtocol,
        });
        console.log(`OTEL config installed to ${result.path}`);
      }

      if (opts.service) {
        try {
          const result = installService({ port, dbPath: envDbPath() });
          console.log(`Service installed: ${result.servicePath}`);
          console.log("  zozul is now running in the background and will start automatically on login.");
        } catch (err) {
          console.error(`Service install failed: ${err instanceof Error ? err.message : err}`);
          console.error("  Run 'zozul serve' manually as a fallback.");
        }
      } else {
        console.log("\nDone. Start the server with: zozul serve");
        console.log("Or install as a background service with: zozul install --service");
      }

      const gitResult = installGitHook();
      if (gitResult) {
        if (gitResult.created) {
          console.log(`Git post-commit hook installed: ${gitResult.path}`);
          console.log("  (auto-clears task context on commit)");
        } else {
          console.log("Git post-commit hook already installed.");
        }
      }

      console.log("Launch Claude Code normally with: claude");
    });

  program
    .command("uninstall")
    .description("Remove zozul hooks, OTEL config, and background service")
    .option("-p, --port <port>", "Hook server port (to match installed hooks)", envPort())
    .action((opts) => {
      const port = parseInt(opts.port, 10);

      const hooksRemoved = uninstallHooksFromSettings({ port });
      const otelRemoved = uninstallOtelFromSettings();
      const gitRemoved = uninstallGitHook();

      if (hooksRemoved) console.log("Hooks removed from Claude Code settings.");
      if (otelRemoved) console.log("OTEL config removed from Claude Code settings.");
      if (gitRemoved) console.log("Git post-commit hook removed.");

      const serviceResult = uninstallService();
      if (serviceResult.removed) {
        console.log("Background service stopped and removed.");
      }

      if (!hooksRemoved && !otelRemoved && !gitRemoved && !serviceResult.removed) {
        console.log("Nothing to remove.");
      }
    });

  program
    .command("context [tags...]")
    .description("Set, view, or clear the active task tags for tagging turns")
    .option("--clear", "Clear the active task context")
    .option("--list", "List all tasks that have been used")
    .action((tags: string[], opts: { clear?: boolean; list?: boolean }) => {
      if (opts.clear) {
        clearActiveContext();
        console.log("Task context cleared.");
        return;
      }

      if (opts.list) {
        const db = getDb(envDbPath());
        const repo = new SessionRepo(db);
        const tasks = repo.listTasks();
        if (tasks.length === 0) {
          console.log("No tasks found.");
        } else {
          for (const t of tasks) {
            console.log(`  ${t.task}  (${t.turn_count} turns, last tagged: ${t.last_tagged})`);
          }
        }
        db.close();
        return;
      }

      if (tags.length > 0) {
        const ctx = setActiveContext(tags);
        console.log(`Active tags: ${ctx.active.join(", ")}`);
        console.log(`  Set at: ${ctx.set_at}`);
        return;
      }

      // No arguments: show current context
      const ctx = getActiveContext();
      if (ctx?.active && ctx.active.length > 0) {
        console.log(`Active tags: ${ctx.active.join(", ")}`);
        console.log(`  Set at: ${ctx.set_at}`);
      } else {
        console.log("No active task context.");
        console.log('Set one with: zozul context "UI" "Feature"');
      }
    });

  program
    .command("sync")
    .description("Sync local data to the remote zozul backend")
    .option("--dry-run", "Show what would be synced without sending data")
    .option("-v, --verbose", "Print detailed progress")
    .action(async (opts) => {
      const apiUrl = process.env.ZOZUL_API_URL;
      const apiKey = process.env.ZOZUL_API_KEY;

      if (!apiUrl || !apiKey) {
        console.error("Missing required environment variables:");
        if (!apiUrl) console.error("  ZOZUL_API_URL — base URL of the zozul backend");
        if (!apiKey) console.error("  ZOZUL_API_KEY — API key for authentication");
        console.error("\nSet them in .env or export them in your shell.");
        process.exit(1);
      }

      const db = getDb(envDbPath());
      const repo = new SessionRepo(db);
      const client = new ZozulApiClient({ apiUrl, apiKey });

      if (opts.dryRun) {
        console.log(`Dry run — checking what would sync to ${apiUrl}...\n`);
      } else {
        console.log(`Syncing to ${apiUrl}...\n`);
      }

      const result = await runSync(repo, client, {
        verbose: opts.verbose || envVerbose(),
        dryRun: opts.dryRun,
      });

      console.log("── Sync Summary ──");
      const label = opts.dryRun ? "pending" : "synced";
      for (const [table, counts] of Object.entries(result)) {
        const status = counts.failed > 0 ? "PARTIAL" : "OK";
        console.log(`  ${table.padEnd(15)} ${counts.synced} ${label}, ${counts.failed} failed  [${status}]`);
      }

      const totalFailed = Object.values(result).reduce((s, c) => s + c.failed, 0);
      if (totalFailed > 0) {
        console.error(`\n${totalFailed} items failed to sync. Re-run 'zozul sync' to retry.`);
        db.close();
        process.exit(1);
      }

      db.close();
    });

  // ── Hidden maintenance commands ──

  program
    .command("ingest", { hidden: true })
    .description("Re-ingest all Claude Code session files (backfill)")
    .option("-f, --force", "Re-ingest sessions that already exist in the database")
    .option("--no-tag", "Skip tagging turns with the active task context")
    .action(async (opts) => {
      const db = getDb(envDbPath());
      const repo = new SessionRepo(db);

      console.log("Scanning for Claude Code session files...");
      const result = await ingestAllSessions(repo, { force: opts.force, noTag: opts.tag === false });
      console.log(`Ingested: ${result.ingested}  Skipped: ${result.skipped}`);
      db.close();
    });

  program
    .command("db-clean", { hidden: true })
    .description("Remove invalid/test rows from the database")
    .option("--session <id>", "Remove all data for a specific session ID")
    .action((opts) => {
      const db = getDb(envDbPath());

      if (opts.session) {
        const id: string = opts.session;
        db.transaction(() => {
          db.prepare(`DELETE FROM task_tags WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)`).run(id);
          for (const table of ["otel_metrics", "otel_events", "hook_events", "tool_uses", "turns"] as const) {
            db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
          }
          db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
        })();
        console.log(`Removed all data for session: ${id}`);
      } else {
        const minDate = "2025-01-01";
        const result = db.prepare(`
          SELECT COUNT(*) as n FROM otel_metrics WHERE timestamp < ?
        `).get(minDate) as { n: number };
        if (result.n === 0) {
          console.log("Nothing to clean.");
        } else {
          db.prepare(`DELETE FROM otel_metrics WHERE timestamp < ?`).run(minDate);
          db.prepare(`DELETE FROM otel_events  WHERE timestamp < ?`).run(minDate);
          console.log(`Removed ${result.n} row(s) with timestamps before ${minDate}.`);
        }
      }

      db.close();
    });

  return program;
}
