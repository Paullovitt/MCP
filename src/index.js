import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadOrCreateConfig, savePublicMcpUrl } from "./config.js";
import { createLogger, formatStartupSummary } from "./logger.js";
import { startMcpHttpServer } from "./mcp-server.js";
import { createTunnelController } from "./tunnel.js";
import { WorkerTeamManager } from "./workers/team-manager.js";

async function writeRuntimeFile(projectRoot, port) {
  const runtimePath = path.join(projectRoot, "data", "runtime.json");
  await fs.writeFile(
    runtimePath,
    `${JSON.stringify({ pid: process.pid, projectRoot, port, startedAt: new Date().toISOString() }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return runtimePath;
}

async function main() {
  const projectRoot = path.resolve(process.cwd());
  const config = await loadOrCreateConfig(projectRoot);
  const logger = createLogger(projectRoot);
  const tunnelController = createTunnelController({
    provider: config.TUNNEL_PROVIDER,
    publicMcpUrl: config.PUBLIC_MCP_URL,
    onPublicMcpUrlDiscovered: (publicMcpUrl) => savePublicMcpUrl(projectRoot, publicMcpUrl)
  });
  const teamManager = new WorkerTeamManager({
    projectRoot,
    databasePath: path.join(projectRoot, "data", "coordinator.sqlite"),
    logger,
    workerCount: 3,
    defaultTimeoutMs: config.WORKER_TASK_TIMEOUT_MS,
    lockTtlMs: config.FILE_LOCK_TTL_MS
  });
  // Remove historicos orfaos antes de publicar a interface e repete a verificacao a cada doze horas.
  await teamManager.cleanupMissingProjectHistories();
  teamManager.startMaintenance();

  let server = null;
  let shuttingDown = false;
  const runtimePath = path.join(projectRoot, "data", "runtime.json");

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Encerrando MCP Worker Coordinator.", { reason });
    if (server) await server.stop().catch((error) => logger.error("Falha ao parar servidor HTTP.", { error: error.message }));
    await teamManager.stop().catch((error) => logger.error("Falha ao parar coordenador.", { error: error.message }));
    await tunnelController.stop().catch(() => {});
    await fs.rm(runtimePath, { force: true }).catch(() => {});
    logger.info("MCP Worker Coordinator encerrado.");
  };

  process.once("SIGINT", () => shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => shutdown("SIGTERM").finally(() => process.exit(0)));
  process.on("uncaughtException", (error) => {
    logger.error("Excecao nao tratada.", { error: error.message, stack: error.stack });
    shutdown("uncaughtException").finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (error) => {
    logger.error("Promise rejeitada sem tratamento.", { error: error?.message || String(error), stack: error?.stack });
  });

  server = await startMcpHttpServer({ config, teamManager, tunnelController });
  const tunnelStatus = await tunnelController.start();
  await writeRuntimeFile(projectRoot, server.port);

  logger.info("MCP Worker Coordinator iniciado.", {
    pid: process.pid,
    interfaceLocal: server.localUrl,
    endpointMcp: server.localMcpUrl,
    porta: server.port,
    autenticacao: "OAuth",
    urlPublica: tunnelStatus.mcpUrl,
    banco: teamManager.databasePath,
    log: logger.logPath
  });
  // Exibe uma unica sintese operacional; os metadados completos continuam em logs/server.log.
  console.log(formatStartupSummary({
    localUrl: server.localUrl,
    localMcpUrl: server.localMcpUrl,
    tunnelProvider: tunnelStatus.provider,
    publicMcpUrl: tunnelStatus.mcpUrl,
    tunnelConnected: tunnelStatus.connected,
    logPath: logger.logPath
  }));
}

main().catch((error) => {
  console.error(`Falha ao iniciar MCP Worker Coordinator: ${error.message}`);
  process.exit(1);
});
