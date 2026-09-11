import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { normalizeMcpUrl } from "./tunnel.js";

const STORE_FILE = "oauth-store.json";
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const SIGNED_TOKEN_PREFIX = "mcp1";
const loginAttempts = new Map();

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function getTokenSigningKey(config) {
  return crypto
    .createHash("sha256")
    .update(`mcp-worker-coordinator:${config.OAUTH_SHARED_TOKEN_SECRET}`)
    .digest();
}

function createSignedToken(config, type, { clientId, resource, scope, issuedAt, expiresAt }) {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    type,
    client_id: clientId,
    resource,
    scope,
    issued_at: Math.floor(issuedAt / 1000),
    expires_at: Math.floor(expiresAt / 1000),
    token_id: crypto.randomUUID()
  })).toString("base64url");
  const valueToSign = `${SIGNED_TOKEN_PREFIX}.${payload}`;
  const signature = crypto.createHmac("sha256", getTokenSigningKey(config)).update(valueToSign).digest("base64url");

  return `${valueToSign}.${signature}`;
}

function readSignedToken(config, token, expectedType) {
  if (typeof token !== "string" || token.length > 8192) return null;

  const [prefix, encodedPayload, encodedSignature, extra] = token.split(".");
  if (prefix !== SIGNED_TOKEN_PREFIX || !encodedPayload || !encodedSignature || extra) return null;

  const expectedSignature = crypto
    .createHmac("sha256", getTokenSigningKey(config))
    .update(`${prefix}.${encodedPayload}`)
    .digest();
  let receivedSignature;
  try {
    receivedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  if (receivedSignature.length !== expectedSignature.length
    || !crypto.timingSafeEqual(receivedSignature, expectedSignature)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (payload.version !== 1
    || payload.type !== expectedType
    || typeof payload.client_id !== "string"
    || payload.client_id.length === 0
    || payload.client_id.length > 512
    || typeof payload.resource !== "string"
    || typeof payload.scope !== "string"
    || !normalizeScope(payload.scope)
    || !Number.isSafeInteger(payload.issued_at)
    || !Number.isSafeInteger(payload.expires_at)
    || payload.issued_at > nowSeconds() + 60
    || payload.expires_at <= payload.issued_at
    || payload.expires_at <= nowSeconds()) {
    return null;
  }

  return {
    client_id: payload.client_id,
    resource: payload.resource,
    scope: payload.scope,
    issuedAt: payload.issued_at * 1000,
    expiresAt: payload.expires_at * 1000
  };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function nowMs() {
  return Date.now();
}

function safeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
  const rightBuffer = Buffer.from(String(right ?? ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, Buffer.alloc(leftBuffer.length));
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getLoginKey(request) {
  return request.get("cf-connecting-ip") || request.socket?.remoteAddress || "unknown";
}

function getLoginState(request) {
  const key = getLoginKey(request);
  const current = nowMs();
  let state = loginAttempts.get(key);
  if (!state || current - state.windowStartedAt > LOGIN_WINDOW_MS) {
    state = { failures: 0, windowStartedAt: current, blockedUntil: 0 };
    loginAttempts.set(key, state);
  }
  return { key, state };
}

function isLoginBlocked(request) {
  const { state } = getLoginState(request);
  return state.blockedUntil > nowMs();
}

function registerLoginFailure(request) {
  const { key, state } = getLoginState(request);
  state.failures += 1;
  if (state.failures >= MAX_LOGIN_FAILURES) {
    state.blockedUntil = nowMs() + LOGIN_BLOCK_MS;
  }
  loginAttempts.set(key, state);
}

function clearLoginFailures(request) {
  loginAttempts.delete(getLoginKey(request));
}

function isAllowedRedirectUri(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function getOriginFromRequest(request) {
  const forwardedProto = request.get("x-forwarded-proto");
  const forwardedHost = request.get("x-forwarded-host");
  const proto = forwardedProto || request.protocol;
  const host = forwardedHost || request.get("host");

  return `${proto}://${host}`;
}

export function getPublicOrigin(config, request) {
  const publicMcpUrl = normalizeMcpUrl(config.PUBLIC_MCP_URL);

  if (publicMcpUrl) {
    return new URL(publicMcpUrl).origin;
  }

  return getOriginFromRequest(request);
}

export function getProtectedResourceUrl(config, request) {
  return normalizeMcpUrl(config.PUBLIC_MCP_URL || `${getOriginFromRequest(request)}/mcp`);
}

function getStorePath(config) {
  return path.join(config.PROJECT_ROOT || process.cwd(), "data", STORE_FILE);
}

async function readStore(config) {
  try {
    const content = await fs.readFile(getStorePath(config), "utf8");
    const store = JSON.parse(content);
    return {
      clients: store.clients || {},
      codes: store.codes || {},
      tokens: store.tokens || {},
      refreshTokens: store.refreshTokens || {}
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    return { clients: {}, codes: {}, tokens: {}, refreshTokens: {} };
  }
}

async function writeStore(config, store) {
  const storePath = getStorePath(config);

  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function cleanupStore(store) {
  const currentTime = nowMs();

  for (const [code, record] of Object.entries(store.codes)) {
    if (record.expiresAt <= currentTime || record.used) {
      delete store.codes[code];
    }
  }

  for (const [token, record] of Object.entries(store.tokens)) {
    if (record.expiresAt <= currentTime) {
      delete store.tokens[token];
    }
  }

  for (const [token, record] of Object.entries(store.refreshTokens)) {
    if (record.expiresAt <= currentTime) {
      delete store.refreshTokens[token];
    }
  }
}

function oauthError(response, status, error, description) {
  response.status(status).json({
    error,
    error_description: description
  });
}

function getClientAuth(request) {
  const authHeader = request.get("authorization") || "";

  if (authHeader.toLowerCase().startsWith("basic ")) {
    const raw = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const separator = raw.indexOf(":");

    if (separator !== -1) {
      return {
        clientId: raw.slice(0, separator),
        clientSecret: raw.slice(separator + 1)
      };
    }
  }

  return {
    clientId: request.body.client_id,
    clientSecret: request.body.client_secret
  };
}

function isRedirectUriAllowed(client, redirectUri) {
  return Array.isArray(client.redirect_uris) && client.redirect_uris.includes(redirectUri);
}

function canRecoverOAuthClient(query) {
  return typeof query.client_id === "string"
    && query.client_id.length > 0
    && query.client_id.length <= 512
    && !/\s/.test(query.client_id)
    && query.response_type === "code"
    && query.code_challenge_method === "S256"
    && typeof query.code_challenge === "string"
    && /^[A-Za-z0-9_-]{43}$/.test(query.code_challenge)
    && isAllowedRedirectUri(query.redirect_uri);
}

async function recoverOAuthClient(config, store, query) {
  if (!canRecoverOAuthClient(query)) return null;

  const client = {
    client_id: query.client_id,
    client_secret: null,
    client_id_issued_at: nowSeconds(),
    redirect_uris: [query.redirect_uri],
    client_name: "ChatGPT reconectado",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  };

  cleanupStore(store);
  store.clients[client.client_id] = client;
  await writeStore(config, store);
  return client;
}

function renderAuthorizePage({ query, error = null }) {
  const hiddenFields = Object.entries(query)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value ?? ""))}" />`)
    .join("\n");

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Autorizar MCP Worker Coordinator</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #eef2f5; color: #111827; }
      main { width: min(420px, calc(100vw - 32px)); padding: 24px; background: white; border: 1px solid #dfe5ee; border-radius: 8px; }
      h1 { margin: 0 0 8px; font-size: 1.4rem; }
      p { color: #5f6b7c; line-height: 1.4; }
      label { display: block; margin: 18px 0 6px; font-weight: 700; }
      input { width: 100%; height: 40px; padding: 0 10px; border: 1px solid #cfd7e3; border-radius: 8px; font: inherit; box-sizing: border-box; }
      button { width: 100%; height: 42px; margin-top: 16px; border: 0; border-radius: 8px; background: #111827; color: white; font: inherit; font-weight: 700; cursor: pointer; }
      .error { color: #b42318; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>Autorizar MCP Worker Coordinator</h1>
      <p>Digite a senha OAuth exibida na interface local para liberar o ChatGPT.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <form method="post" action="/oauth/authorize">
        ${hiddenFields}
        <label for="password">Senha OAuth</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
        <button type="submit">Autorizar</button>
      </form>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function redirectWithError(response, redirectUri, error, state) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);

  if (state) {
    url.searchParams.set("state", state);
  }

  response.redirect(url.toString());
}

function normalizeScope(value) {
  const requested = String(value || "mcp offline_access").split(/\s+/).filter(Boolean);
  const allowed = new Set(["mcp", "offline_access"]);
  if (requested.some((scope) => !allowed.has(scope))) {
    return null;
  }
  if (!requested.includes("mcp")) requested.unshift("mcp");
  return [...new Set(requested)].join(" ");
}

function issueTokenPair(config, store, {
  clientId,
  resource,
  scope,
  existingRefreshToken = null,
  existingRefreshRecord = null
}) {
  const issuedAt = nowMs();
  const accessTtl = Number(config.OAUTH_ACCESS_TOKEN_TTL_SECONDS || 3600);
  const refreshTtl = Number(config.OAUTH_REFRESH_TOKEN_TTL_SECONDS || 63_072_000);
  const accessExpiresAt = issuedAt + accessTtl * 1000;
  const refreshIssuedAt = existingRefreshRecord?.issuedAt || issuedAt;
  const refreshExpiresAt = existingRefreshRecord?.expiresAt || issuedAt + refreshTtl * 1000;
  const accessToken = createSignedToken(config, "access", {
    clientId,
    resource,
    scope,
    issuedAt,
    expiresAt: accessExpiresAt
  });
  const refreshToken = existingRefreshToken || createSignedToken(config, "refresh", {
    clientId,
    resource,
    scope,
    issuedAt: refreshIssuedAt,
    expiresAt: refreshExpiresAt
  });

  store.tokens[accessToken] = {
    client_id: clientId,
    resource,
    scope,
    issuedAt,
    expiresAt: accessExpiresAt
  };
  store.refreshTokens[refreshToken] = {
    client_id: clientId,
    resource,
    scope,
    issuedAt: refreshIssuedAt,
    expiresAt: refreshExpiresAt
  };

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: accessTtl,
    refresh_token: refreshToken,
    scope
  };
}

export function createOAuthRouter(config) {
  const router = express.Router();

  router.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (request, response) => {
    const origin = getPublicOrigin(config, request);

    response.json({
      resource: getProtectedResourceUrl(config, request),
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp", "offline_access"]
    });
  });

  router.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp", "/.well-known/openid-configuration"], (request, response) => {
    const origin = getPublicOrigin(config, request);

    response.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      scopes_supported: ["mcp", "offline_access"],
      resource_indicators_supported: true
    });
  });

  router.post("/oauth/register", async (request, response) => {
    const redirectUris = request.body.redirect_uris;

    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
      oauthError(response, 400, "invalid_client_metadata", "redirect_uris deve conter apenas HTTPS ou callback HTTP local.");
      return;
    }

    const authMethod = request.body.token_endpoint_auth_method || "none";
    if (!["none", "client_secret_basic", "client_secret_post"].includes(authMethod)) {
      oauthError(response, 400, "invalid_client_metadata", "token_endpoint_auth_method nao suportado.");
      return;
    }
    const requestedGrantTypes = Array.isArray(request.body.grant_types)
      ? request.body.grant_types
      : ["authorization_code", "refresh_token"];
    if (requestedGrantTypes.some((grantType) => !["authorization_code", "refresh_token"].includes(grantType))) {
      oauthError(response, 400, "invalid_client_metadata", "grant_types contem valor nao suportado.");
      return;
    }
    const grantTypes = [...new Set(requestedGrantTypes)];
    if (grantTypes.includes("authorization_code") && !grantTypes.includes("refresh_token")) {
      grantTypes.push("refresh_token");
    }

    const clientId = randomToken(24);
    const clientSecret = authMethod === "none" ? null : randomToken(32);
    const client = {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: nowSeconds(),
      redirect_uris: redirectUris,
      client_name: request.body.client_name || "ChatGPT",
      grant_types: grantTypes,
      response_types: request.body.response_types || ["code"],
      token_endpoint_auth_method: authMethod
    };
    const store = await readStore(config);

    cleanupStore(store);
    store.clients[clientId] = client;
    await writeStore(config, store);

    response.status(201).json({
      client_id: client.client_id,
      client_id_issued_at: client.client_id_issued_at,
      redirect_uris: client.redirect_uris,
      client_name: client.client_name,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      ...(clientSecret ? { client_secret: clientSecret } : {})
    });
  });

  router.get("/oauth/authorize", async (request, response) => {
    const store = await readStore(config);
    let client = store.clients[request.query.client_id];

    if (!client) {
      client = await recoverOAuthClient(config, store, request.query);
    }

    if (!client || !isRedirectUriAllowed(client, request.query.redirect_uri)) {
      response.status(400).send("Cliente OAuth ou redirect_uri invalido.");
      return;
    }

    response.type("html").send(renderAuthorizePage({ query: request.query }));
  });

  router.post("/oauth/authorize", async (request, response) => {
    const query = {
      response_type: request.body.response_type,
      client_id: request.body.client_id,
      redirect_uri: request.body.redirect_uri,
      state: request.body.state,
      code_challenge: request.body.code_challenge,
      code_challenge_method: request.body.code_challenge_method,
      scope: request.body.scope,
      resource: request.body.resource
    };
    const store = await readStore(config);
    const client = store.clients[query.client_id];

    if (!client || !isRedirectUriAllowed(client, query.redirect_uri)) {
      response.status(400).send("Cliente OAuth ou redirect_uri invalido.");
      return;
    }

    if (isLoginBlocked(request)) {
      response.status(429).type("html").send(renderAuthorizePage({ query, error: "Muitas tentativas. Aguarde antes de tentar novamente." }));
      return;
    }

    if (!safeTextEqual(request.body.password, config.OAUTH_LOGIN_PASSWORD)) {
      registerLoginFailure(request);
      response.status(401).type("html").send(renderAuthorizePage({ query, error: "Senha OAuth invalida." }));
      return;
    }

    clearLoginFailures(request);

    if (query.response_type !== "code") {
      redirectWithError(response, query.redirect_uri, "unsupported_response_type", query.state);
      return;
    }

    if (query.code_challenge_method !== "S256" || !query.code_challenge) {
      redirectWithError(response, query.redirect_uri, "invalid_request", query.state);
      return;
    }

    const normalizedScope = normalizeScope(query.scope);
    if (!normalizedScope) {
      redirectWithError(response, query.redirect_uri, "invalid_scope", query.state);
      return;
    }

    const code = randomToken(32);
    const redirectUrl = new URL(query.redirect_uri);

    cleanupStore(store);
    store.codes[code] = {
      client_id: query.client_id,
      redirect_uri: query.redirect_uri,
      code_challenge: query.code_challenge,
      resource: query.resource || getProtectedResourceUrl(config, request),
      scope: normalizedScope,
      expiresAt: nowMs() + AUTH_CODE_TTL_MS,
      used: false
    };
    await writeStore(config, store);

    redirectUrl.searchParams.set("code", code);

    if (query.state) {
      redirectUrl.searchParams.set("state", query.state);
    }

    response.redirect(redirectUrl.toString());
  });

  router.post("/oauth/token", async (request, response) => {
    const grantType = request.body.grant_type;
    if (!["authorization_code", "refresh_token"].includes(grantType)) {
      oauthError(response, 400, "unsupported_grant_type", "Grant OAuth nao suportado.");
      return;
    }

    const store = await readStore(config);
    cleanupStore(store);
    const { clientId, clientSecret } = getClientAuth(request);
    const previousRefreshToken = grantType === "refresh_token" ? request.body.refresh_token : null;
    const signedRefreshRecord = previousRefreshToken
      ? readSignedToken(config, previousRefreshToken, "refresh")
      : null;
    const storedRefreshRecord = previousRefreshToken ? store.refreshTokens[previousRefreshToken] : null;
    const refreshRecord = signedRefreshRecord || storedRefreshRecord;
    let client = store.clients[clientId];

    // Outra instalacao com a mesma chave pode renovar um token de cliente publico
    // mesmo sem possuir a copia local do registro dinamico do ChatGPT.
    if (!client
      && grantType === "refresh_token"
      && signedRefreshRecord
      && signedRefreshRecord.client_id === clientId
      && !clientSecret) {
      client = {
        client_id: clientId,
        client_secret: null,
        grant_types: ["refresh_token"],
        token_endpoint_auth_method: "none"
      };
    }

    if (!client) {
      oauthError(response, 401, "invalid_client", "Cliente OAuth invalido.");
      return;
    }

    if (client.client_secret && !safeTextEqual(client.client_secret, clientSecret)) {
      oauthError(response, 401, "invalid_client", "Client secret invalido.");
      return;
    }

    if (!client.grant_types?.includes(grantType)) {
      oauthError(response, 400, "unauthorized_client", "Cliente nao autorizado para este grant.");
      return;
    }

    if (grantType === "refresh_token") {
      if (!refreshRecord || refreshRecord.expiresAt <= nowMs() || refreshRecord.client_id !== clientId) {
        oauthError(response, 400, "invalid_grant", "Refresh token invalido ou expirado.");
        return;
      }

      const requestedScope = request.body.scope ? normalizeScope(request.body.scope) : refreshRecord.scope;
      if (!requestedScope) {
        oauthError(response, 400, "invalid_scope", "Escopo solicitado nao e suportado.");
        return;
      }
      const originalScopes = new Set(String(refreshRecord.scope).split(/\s+/));
      if (String(requestedScope).split(/\s+/).some((scope) => !originalScopes.has(scope))) {
        oauthError(response, 400, "invalid_scope", "O refresh token nao permite ampliar escopos.");
        return;
      }

      if (!signedRefreshRecord) {
        delete store.refreshTokens[previousRefreshToken];
      }
      const tokenPair = issueTokenPair(config, store, {
        clientId,
        resource: refreshRecord.resource,
        scope: requestedScope,
        existingRefreshToken: signedRefreshRecord ? previousRefreshToken : null,
        existingRefreshRecord: signedRefreshRecord ? refreshRecord : null
      });
      await writeStore(config, store);
      response.json(tokenPair);
      return;
    }

    const codeRecord = store.codes[request.body.code];
    if (!codeRecord || codeRecord.used || codeRecord.expiresAt <= nowMs()) {
      oauthError(response, 400, "invalid_grant", "Codigo OAuth invalido ou expirado.");
      return;
    }

    if (codeRecord.client_id !== clientId || codeRecord.redirect_uri !== request.body.redirect_uri) {
      oauthError(response, 400, "invalid_grant", "Codigo OAuth nao corresponde ao cliente.");
      return;
    }

    if (sha256Base64Url(request.body.code_verifier || "") !== codeRecord.code_challenge) {
      oauthError(response, 400, "invalid_grant", "PKCE code_verifier invalido.");
      return;
    }

    codeRecord.used = true;
    const tokenPair = issueTokenPair(config, store, {
      clientId,
      resource: codeRecord.resource,
      scope: codeRecord.scope
    });
    await writeStore(config, store);
    response.json(tokenPair);
  });

  return router;
}

export async function isValidOAuthAccessToken(config, token) {
  if (!token) {
    return false;
  }

  const signedRecord = readSignedToken(config, token, "access");
  if (signedRecord) {
    const expectedResource = normalizeMcpUrl(config.PUBLIC_MCP_URL);
    try {
      return !expectedResource || normalizeMcpUrl(signedRecord.resource) === expectedResource;
    } catch {
      return false;
    }
  }

  const store = await readStore(config);
  const record = store.tokens[token];

  if (!record || record.expiresAt <= nowMs()) {
    cleanupStore(store);
    await writeStore(config, store);
    return false;
  }

  return true;
}

export function getOAuthChallenge(config, request) {
  const origin = getPublicOrigin(config, request);

  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}
