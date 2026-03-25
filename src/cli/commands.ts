import { Command } from "commander";
import { getDb } from "../storage/db.js";
import { SessionRepo } from "../storage/repo.js";
import { createHookServer } from "../hooks/server.js";
import { installHooksToSettings, uninstallHooksFromSettings, generateHooksConfig } from "../hooks/config.js";
import { installOtelToSettings, uninstallOtelFromSettings, generateOtelShellExports } from "../otel/config.js";
import { ingestAllSessions } from "../parser/ingest.js";
import { watchSessionFiles } from "../parser/watcher.js";
import { formatSessionList, formatSessionDetail, formatStats } from "./format.js";
import { installService, uninstallService, serviceStatus, restartService } from "../service/index.js";

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
      const server = createHookServer({ port, repo, verbose });

      server.listen(port, async () => {
        console.log(`zozul listening on http://localhost:${port}`);
        console.log(`  Dashboard:     http://localhost:${port}/dashboard`);
        console.log(`  Hooks:         http://localhost:${port}/hook/<event>`);
        console.log(`  OTLP receiver: http://localhost:${port}/v1/metrics & /v1/logs`);
        console.log(`  API:           http://localhost:${port}/api/*`);
        console.log("\nPress Ctrl+C to stop.\n");

        const stopWatcher = await watchSessionFiles({ repo, verbose, catchUp: true });

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
    .description("Install hooks and OTEL config into Claude Code settings.json")
    .option("-p, --port <port>", "Hook server port", envPort())
    .option("--otel-endpoint <endpoint>", "OTLP endpoint", envOtelEndpoint())
    .option("--otel-protocol <protocol>", "OTLP protocol", envOtelProtocol())
    .option("--no-otel", "Skip OTEL configuration")
    .option("--no-hooks", "Skip hooks configuration")
    .option("--service", "Also install zozul as a background service (starts on login)")
    .action((opts) => {
      const port = parseInt(opts.port, 10);

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

      console.log("Launch Claude Code normally with: claude");
    });

  program
    .command("uninstall")
    .description("Remove zozul hooks and OTEL config from Claude Code settings.json")
    .option("-p, --port <port>", "Hook server port (to match installed hooks)", envPort())
    .option("--service", "Also stop and remove the background service")
    .action((opts) => {
      const port = parseInt(opts.port, 10);

      const hooksRemoved = uninstallHooksFromSettings({ port });
      const otelRemoved = uninstallOtelFromSettings();

      if (hooksRemoved) console.log("Hooks removed from Claude Code settings.");
      if (otelRemoved) console.log("OTEL config removed from Claude Code settings.");
      if (!hooksRemoved && !otelRemoved) console.log("Nothing to remove.");

      if (opts.service) {
        const result = uninstallService();
        if (result.removed) {
          console.log("Background service stopped and removed.");
        } else {
          console.log("No background service found.");
        }
      }
    });

  program
    .command("service-status")
    .description("Show whether the zozul background service is installed and running")
    .action(() => {
      console.log(`Service status: ${serviceStatus()}`);
    });

  program
    .command("restart")
    .description("Restart the zozul background service")
    .action(() => {
      try {
        restartService();
        console.log("Service restarted.");
        console.log(`  Status: ${serviceStatus()}`);
      } catch (err) {
        console.error(`Restart failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  program
    .command("ingest")
    .description("Parse all Claude Code session JSONL files into the local database")
    .option("-f, --force", "Re-ingest sessions that already exist in the database")
    .action(async (opts) => {
      const db = getDb(envDbPath());
      const repo = new SessionRepo(db);

      console.log("Scanning for Claude Code session files...");
      const result = await ingestAllSessions(repo, { force: opts.force });
      console.log(`Ingested: ${result.ingested}  Skipped: ${result.skipped}`);
      db.close();
    });

  program
    .command("sessions")
    .description("List recorded sessions")
    .option("-n, --limit <n>", "Number of sessions to show", "20")
    .action((opts) => {
      const db = getDb(envDbPath());
      const repo = new SessionRepo(db);

      const sessions = repo.listSessions(parseInt(opts.limit, 10));
      console.log(formatSessionList(sessions));
      db.close();
    });

  program
    .command("session <id>")
    .description("Show details for a specific session")
    .action((id: string) => {
      const db = getDb(envDbPath());
      const repo = new SessionRepo(db);

      const session = repo.getSession(id);
      if (!session) {
        console.error(`Session not found: ${id}`);
        process.exit(1);
      }

      const turns = repo.getSessionTurns(id);
      console.log(formatSessionDetail(session, turns));
      db.close();
    });

  program
    .command("stats")
    .description("Show aggregate statistics across all sessions")
    .action(() => {
      const db = getDb(envDbPath());
      const repo = new SessionRepo(db);

      const stats = repo.getAggregateStats() as Record<string, unknown>;
      console.log(formatStats(stats));
      db.close();
    });

  program
    .command("db-clean")
    .description("Remove known invalid/test rows from the database")
    .option("--session <id>", "Remove all data for a specific session ID")
    .action((opts) => {
      const db = getDb(envDbPath());

      if (opts.session) {
        const id: string = opts.session;
        db.transaction(() => {
          for (const table of ["otel_metrics", "otel_events", "hook_events", "tool_uses", "turns"] as const) {
            db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
          }
          db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
        })();
        console.log(`Removed all data for session: ${id}`);
      } else {
        // Remove rows where the timestamp is clearly from the wrong year
        // or the session_id looks like a test fixture
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

  program
    .command("show-config")
    .description("Print the hooks and OTEL configuration that would be installed")
    .option("-p, --port <port>", "Hook server port", envPort())
    .option("--otel-endpoint <endpoint>", "OTLP endpoint", envOtelEndpoint())
    .action((opts) => {
      const port = parseInt(opts.port, 10);

      console.log("── Hooks Config (for ~/.claude/settings.json) ──\n");
      console.log(JSON.stringify(generateHooksConfig({ port }), null, 2));

      console.log("\n── OTEL Environment Variables ──\n");
      console.log(generateOtelShellExports({ endpoint: opts.otelEndpoint }));
    });

  return program;
}
