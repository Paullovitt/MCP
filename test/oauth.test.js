import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createOAuthRouter, isValidOAuthAccessToken } from "../src/oauth.js";

test("OAuth integrado preserva login, PKCE e tokens entre instalacoes", { timeout: 15_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-check-"));
  const servers = [];
  t.after(async () => {
    // Nenhuma credencial ou banco real participa da verificacao de autenticacao.
    for (const server of servers) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const sharedSecret = crypto.randomBytes(32).toString("base64url");
  const configuration = (name) => ({
    PROJECT_ROOT: path.join(directory, name),
    PUBLIC_MCP_URL: "https://mcp.example/mcp",
    OAUTH_LOGIN_PASSWORD: crypto.randomBytes(18).toString("base64url"),
    OAUTH_SHARED_TOKEN_SECRET: sharedSecret,
    OAUTH_ACCESS_TOKEN_TTL_SECONDS: 3600,
    OAUTH_REFRESH_TOKEN_TTL_SECONDS: 7200
  });
  const configA = configuration("installation-a");
  const configB = configuration("installation-b");
  async function serve(config) {
    const app = express();
    app.use(express.json(), express.urlencoded({ extended: false }), createOAuthRouter(config));
    const server = await new Promise((resolve, reject) => {
      const running = app.listen(0, "127.0.0.1", () => resolve(running));
      running.once("error", reject);
    });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  const originA = await serve(configA);
  const originB = await serve(configB);
  const post = (origin, route, body) => fetch(origin + route, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const registration = await post(originA, "/oauth/register", {
    redirect_uris: ["https://client.example/callback"], client_name: "OAuth integration test", token_endpoint_auth_method: "none"
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const authorization = {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
    state: "test-state", scope: "mcp offline_access", resource: configA.PUBLIC_MCP_URL
  };
  let tokenPair;

  await t.test("descoberta publica anuncia o mesmo emissor e recurso", async () => {
    const metadata = await fetch(originA + "/.well-known/oauth-authorization-server").then((r) => r.json());
    const resource = await fetch(originA + "/.well-known/oauth-protected-resource").then((r) => r.json());
    assert.equal(metadata.issuer, "https://mcp.example");
    assert.equal(resource.resource, configA.PUBLIC_MCP_URL);
    assert.deepEqual(resource.authorization_servers, [metadata.issuer]);
  });

  await t.test("senha incorreta e PKCE incorreto sao recusados; codigo so funciona uma vez", async () => {
    const denied = await post(originA, "/oauth/authorize", { ...authorization, password: "wrong-password" });
    assert.equal(denied.status, 401);
    const accepted = await post(originA, "/oauth/authorize", { ...authorization, password: configA.OAUTH_LOGIN_PASSWORD });
    assert.equal(accepted.status, 302);
    const callback = new URL(accepted.headers.get("location"));
    assert.equal(callback.searchParams.get("state"), authorization.state);
    const exchange = { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: authorization.redirect_uri, code: callback.searchParams.get("code") };
    const invalidPkce = await post(originA, "/oauth/token", { ...exchange, code_verifier: "wrong-verifier" });
    assert.equal(invalidPkce.status, 400);
    const tokens = await post(originA, "/oauth/token", { ...exchange, code_verifier: verifier });
    assert.equal(tokens.status, 200);
    tokenPair = await tokens.json();
    assert.equal(await isValidOAuthAccessToken(configA, tokenPair.access_token), true);
    assert.equal((await post(originA, "/oauth/token", { ...exchange, code_verifier: verifier })).status, 400);
  });

  await t.test("chave compartilhada permite validacao e refresh na segunda instalacao", async () => {
    assert.equal(await isValidOAuthAccessToken(configB, tokenPair.access_token), true);
    const refreshed = await post(originB, "/oauth/token", {
      grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokenPair.refresh_token
    });
    assert.equal(refreshed.status, 200);
    const tokens = await refreshed.json();
    assert.equal(tokens.refresh_token, tokenPair.refresh_token);
    assert.equal(await isValidOAuthAccessToken(configA, tokens.access_token), true);
    assert.equal(await isValidOAuthAccessToken(configB, tokens.access_token), true);
  });

  await t.test("assinatura, recurso e tipos de token continuam protegidos", async () => {
    assert.equal(await isValidOAuthAccessToken({ ...configB, OAUTH_SHARED_TOKEN_SECRET: crypto.randomBytes(32).toString("base64url") }, tokenPair.access_token), false);
    assert.equal(await isValidOAuthAccessToken({ ...configB, PUBLIC_MCP_URL: "https://other.example/mcp" }, tokenPair.access_token), false);
    assert.equal(await isValidOAuthAccessToken(configB, tokenPair.refresh_token), false);
    const parts = tokenPair.access_token.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    assert.equal(await isValidOAuthAccessToken(configB, parts.join(".")), false);
    const wrongClient = await post(originB, "/oauth/token", {
      grant_type: "refresh_token", client_id: "wrong-client", refresh_token: tokenPair.refresh_token
    });
    assert.equal(wrongClient.status, 401);
  });

  await t.test("tokens locais antigos validos sobrevivem a atualizacao", async () => {
    const storePath = path.join(configA.PROJECT_ROOT, "data", "oauth-store.json");
    const store = JSON.parse(await fs.readFile(storePath, "utf8"));
    const legacy = crypto.randomBytes(32).toString("base64url");
    store.tokens[legacy] = { client_id: client.client_id, resource: configA.PUBLIC_MCP_URL, scope: "mcp", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    await fs.writeFile(storePath, JSON.stringify(store));
    assert.equal(await isValidOAuthAccessToken(configA, legacy), true);
  });
});
