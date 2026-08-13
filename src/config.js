import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const REQUIRED_SERVER_PORT = 4194;
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 2 * 365 * 24 * 60 * 60;

const CONFIG_DEFAULTS = {
  TUNNEL_PROVIDER: "cloudflare",
  ALLOW_UNAUTHENTICATED_MCP: false,
  SERVER_PORT: REQUIRED_SERVER_PORT,
  MCP_PORT: REQUIRED_SERVER_PORT,
  PUBLIC_MCP_URL: null,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS: DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  WORKER_COUNT: 3,
  WORKER_TASK_TIMEOUT_MS: 120_000,
  FILE_LOCK_TTL_MS: 30_000
};

function createInstallId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function createLoginPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

function createSharedTokenSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function getRuntimeSharedTokenSecret() {
  const value = process.env.MCP_OAUTH_SHARED_TOKEN_SECRET?.trim();
  return value || null;
}

export function getConfigPath(projectRoot = process.cwd()) {
  return path.join(projectRoot, "data", "config.json");
}

async function writeConfig(configPath, config) {
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function normalizeConfig(rawConfig, projectRoot) {
  const config = { ...rawConfig };
  let changed = false;

  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    if (!(key in config)) {
      config[key] = value;
      changed = true;
    }
  }

  const forcedValues = {
    TUNNEL_PROVIDER: "cloudflare",
    ALLOW_UNAUTHENTICATED_MCP: false,
    SERVER_PORT: REQUIRED_SERVER_PORT,
    MCP_PORT: REQUIRED_SERVER_PORT,
    WORKER_COUNT: 3
  };

  for (const [key, value] of Object.entries(forcedValues)) {
    if (config[key] !== value) {
      config[key] = value;
      changed = true;
    }
  }

  if (!config.INSTALL_ID) {
    config.INSTALL_ID = createInstallId();
    changed = true;
  }

  if ("MCP_ACCESS_TOKEN" in config) {
    delete config.MCP_ACCESS_TOKEN;
    changed = true;
  }

  if (!config.OAUTH_LOGIN_PASSWORD) {
    config.OAUTH_LOGIN_PASSWORD = createLoginPassword();
    changed = true;
  }

  const runtimeSharedTokenSecret = getRuntimeSharedTokenSecret();
  if (runtimeSharedTokenSecret && config.OAUTH_SHARED_TOKEN_SECRET !== runtimeSharedTokenSecret) {
    config.OAUTH_SHARED_TOKEN_SECRET = runtimeSharedTokenSecret;
    changed = true;
  } else if (!config.OAUTH_SHARED_TOKEN_SECRET) {
    config.OAUTH_SHARED_TOKEN_SECRET = createSharedTokenSecret();
    changed = true;
  }

  if (typeof config.OAUTH_SHARED_TOKEN_SECRET !== "string" || config.OAUTH_SHARED_TOKEN_SECRET.length < 32) {
    throw new Error("OAUTH_SHARED_TOKEN_SECRET deve conter pelo menos 32 caracteres.");
  }

  if (Number(config.OAUTH_ACCESS_TOKEN_TTL_SECONDS) < DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS) {
    config.OAUTH_ACCESS_TOKEN_TTL_SECONDS = DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS;
    changed = true;
  }

  if (Number(config.OAUTH_REFRESH_TOKEN_TTL_SECONDS) < DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS) {
    config.OAUTH_REFRESH_TOKEN_TTL_SECONDS = DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS;
    changed = true;
  }

  if (Number(config.WORKER_TASK_TIMEOUT_MS) < 1000) {
    config.WORKER_TASK_TIMEOUT_MS = CONFIG_DEFAULTS.WORKER_TASK_TIMEOUT_MS;
    changed = true;
  }

  if (Number(config.FILE_LOCK_TTL_MS) < 3000) {
    config.FILE_LOCK_TTL_MS = CONFIG_DEFAULTS.FILE_LOCK_TTL_MS;
    changed = true;
  }

  if (config.PROJECT_ROOT !== projectRoot) {
    config.PROJECT_ROOT = projectRoot;
    changed = true;
  }

  return { config, changed };
}

export async function loadOrCreateConfig(projectRoot = process.cwd()) {
  const absoluteRoot = path.resolve(projectRoot);
  const dataDir = path.join(absoluteRoot, "data");
  const configPath = getConfigPath(absoluteRoot);

  await fs.mkdir(dataDir, { recursive: true });

  try {
    const rawConfig = await fs.readFile(configPath, "utf8");
    const { config, changed } = normalizeConfig(JSON.parse(rawConfig), absoluteRoot);

    if (changed) {
      config.updatedAt = new Date().toISOString();
      await writeConfig(configPath, config);
    }

    return config;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Falha ao ler data/config.json: ${error.message}`);
    }
  }

  const now = new Date().toISOString();
  const config = {
    INSTALL_ID: createInstallId(),
    OAUTH_LOGIN_PASSWORD: createLoginPassword(),
    OAUTH_SHARED_TOKEN_SECRET: getRuntimeSharedTokenSecret() || createSharedTokenSecret(),
    ...CONFIG_DEFAULTS,
    PROJECT_ROOT: absoluteRoot,
    createdAt: now,
    updatedAt: now
  };

  await writeConfig(configPath, config);
  return config;
}

export async function savePublicMcpUrl(projectRoot, publicMcpUrl) {
  const configPath = getConfigPath(path.resolve(projectRoot));
  const rawConfig = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(rawConfig);

  if (config.PUBLIC_MCP_URL) {
    return {
      saved: false,
      publicMcpUrl: config.PUBLIC_MCP_URL
    };
  }

  config.PUBLIC_MCP_URL = publicMcpUrl;
  config.updatedAt = new Date().toISOString();
  await writeConfig(configPath, config);

  return {
    saved: true,
    publicMcpUrl
  };
}
