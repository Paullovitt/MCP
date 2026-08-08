const DEFAULT_PROVIDER = "cloudflare";

export function normalizeMcpUrl(value) {
  if (!value) {
    return null;
  }

  const url = new URL(String(value).trim());
  const cleanPath = url.pathname.replace(/\/+$/, "");

  // A URL cadastrada no ChatGPT deve apontar diretamente para o endpoint MCP.
  url.pathname = cleanPath === "/mcp" || cleanPath.endsWith("/mcp") ? cleanPath : `${cleanPath}/mcp`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";

  return url.toString();
}

function baseUrlFromMcpUrl(mcpUrl) {
  if (!mcpUrl) {
    return null;
  }

  const url = new URL(mcpUrl);
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "") || "/";
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
}

export function createTunnelController({ publicMcpUrl = null, provider = DEFAULT_PROVIDER }) {
  const officialMcpUrl = normalizeMcpUrl(publicMcpUrl);

  function getStatus() {
    if (!officialMcpUrl) {
      return {
        connected: false,
        url: null,
        mcpUrl: null,
        error: "PUBLIC_MCP_URL nao configurada. Configure a rota publica do Cloudflare Tunnel.",
        provider
      };
    }

    return {
      connected: true,
      url: baseUrlFromMcpUrl(officialMcpUrl),
      mcpUrl: officialMcpUrl,
      error: null,
      provider
    };
  }

  async function start() {
    return getStatus();
  }

  async function stop() {
    return getStatus();
  }

  async function restart() {
    return getStatus();
  }

  return { start, stop, restart, getStatus };
}
