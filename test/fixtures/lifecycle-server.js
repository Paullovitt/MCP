import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadOrCreateConfig } from "../../src/config.js";
import { startMcpHttpServer } from "../../src/mcp-server.js";
import { TerminalSessionManager } from "../../src/terminal/session-manager.js";
import { WorkerTeamManager } from "../../src/workers/team-manager.js";
import { runShellCommand, stopShellCommands } from "../../src/tools/shell.js";

// Servidor descartavel em porta aleatoria: exercita os componentes reais sem tocar no MCP instalado.
const directory = process.argv[2];
const mode = process.argv[3];
const root = fileURLToPath(new URL("../../", import.meta.url));
const config = await loadOrCreateConfig(directory);
config.SERVER_PORT = 0;
const manager = new TerminalSessionManager({ projectRoot: directory });
const workers = new WorkerTeamManager({ projectRoot: root, databasePath: path.join(directory, "fixture.sqlite") });
const token = randomBytes(32).toString("base64url");
let server;
const shutdown = async () => {
  if (mode !== "graceful") return;
  server.beginShutdown();
  await manager.stop();
  await stopShellCommands();
  await workers.stop();
  await server.stop();
  await fs.writeFile(path.join(directory, "graceful.txt"), "cleanup completed");
  await fs.rm(path.join(directory, "data", "runtime.json"), { force: true });
  process.exit(0);
};
server = await startMcpHttpServer({
  config, teamManager: workers, terminalManager: manager,
  tunnelController: { getStatus: () => ({ connected: false }) },
  shutdown: { token, onRequest: () => { void shutdown(); } }
});
config.SERVER_PORT = server.port;
const pids = [];
if (mode !== "foreign") {
  const projectPath = path.join(directory, "project");
  await fs.mkdir(projectPath);
  const team = await workers.createTeam({ projectPath });
  pids.push(...team.workers.map((worker) => worker.pid));
  const terminal = await manager.start({ shell: "node", args: ["-e", "setInterval(()=>{},1000)"] });
  pids.push(terminal.pid, manager.get(terminal.sessionId).host.pid);
  // Um shell direto em andamento tambem deve ser cancelado durante a parada normal.
  void runShellCommand({ command: process.platform === "win32" ? "Start-Sleep -Seconds 60" : "sleep 60" }, { projectRoot: directory });
}
await fs.writeFile(path.join(directory, "data", "runtime.json"), JSON.stringify({
  pid: process.pid, port: server.port, projectRoot: mode === "foreign" ? path.join(directory, "other") : directory,
  startedAt: new Date().toISOString(), shutdownToken: token
}));
if (mode === "foreign") {
  // A resposta HTTP nao corresponde a identidade configurada em disco.
  config.INSTALL_ID = "different-installation";
}
await fs.writeFile(path.join(directory, "ready.json"), JSON.stringify({ port: server.port, pids }));
