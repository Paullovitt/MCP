import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isLocalHost(request) {
  const host = (request.get("host") || "").toLowerCase();
  const forwardedHost = request.get("x-forwarded-host");
  return !forwardedHost && (host.startsWith("127.0.0.1:") || host.startsWith("localhost:") || host === "127.0.0.1" || host === "localhost");
}

export function requireLocalRequest(request, response, next) {
  if (!isLocalHost(request)) {
    response.status(403).json({ error: "local_only", message: "Esta rota esta disponivel apenas localmente." });
    return;
  }
  next();
}

export function mountUiRoutes(app, { config, tunnelController, teamManager, serverState }) {
  const publicDir = path.join(__dirname, "public");

  app.get("/api/status", requireLocalRequest, (_request, response) => {
    const tunnel = tunnelController.getStatus();
    // Usa os mesmos estados legiveis exibidos no terminal para evitar interpretacoes diferentes.
    response.json({
      service: "mcp-worker-coordinator",
      status: serverState.isRunning() ? "ligado" : "desligado",
      serverPort: config.SERVER_PORT,
      localUrl: `http://127.0.0.1:${config.SERVER_PORT}`,
      localMcpUrl: `http://127.0.0.1:${config.SERVER_PORT}/mcp`,
      publicMcpUrl: tunnel.mcpUrl,
      tunnelProvider: tunnel.provider,
      tunnelStatus: tunnel.connected ? "ligado" : "não configurado",
      authMode: "oauth",
      oauthLoginPassword: config.OAUTH_LOGIN_PASSWORD,
      installId: config.INSTALL_ID,
      workers: teamManager.getOverview(),
      error: tunnel.error
    });
  });

  app.use("/", requireLocalRequest, express.static(publicDir, { index: "index.html" }));
}
