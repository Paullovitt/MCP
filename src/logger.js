import fs from "node:fs";
import path from "node:path";

function serializeData(data) {
  if (data === undefined) {
    return "";
  }

  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ` ${String(data)}`;
  }
}

export function createLogger(projectRoot) {
  const logsDir = path.join(projectRoot, "logs");
  const logPath = path.join(logsDir, "server.log");
  fs.mkdirSync(logsDir, { recursive: true });

  function write(level, message, data) {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${serializeData(data)}`;
    fs.appendFileSync(logPath, `${line}\n`, "utf8");

    // Mantem o terminal operacional limpo; detalhes rotineiros permanecem no arquivo de log.
    if (level === "error") {
      console.error(line);
    }
  }

  return {
    logPath,
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data)
  };
}

export function formatStartupSummary({ localUrl, localMcpUrl, tunnelProvider, publicMcpUrl, tunnelConnected, logPath }) {
  // Centraliza a apresentacao curta para evitar linhas duplicadas durante a inicializacao.
  return [
    "MCP Worker Coordinator iniciado",
    `Interface local: ${localUrl}`,
    `Servidor MCP local: ${localMcpUrl}`,
    `Provedor do túnel: ${tunnelProvider}`,
    "Autenticação MCP: OAuth",
    `URL MCP pública: ${publicMcpUrl || "não configurada"}`,
    `Status do túnel: ${tunnelConnected ? "ligado" : "não configurado"}`,
    "Status do servidor: ligado",
    `Logs: ${logPath}`
  ].join("\n");
}
