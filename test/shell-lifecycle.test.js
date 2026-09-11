import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runShellCommand, stopShellCommands, SHELL_OUTPUT_LIMIT_BYTES } from "../src/tools/shell.js";
import { loadOrCreateConfig } from "../src/config.js";
import { startMcpHttpServer, createMcpServer } from "../src/mcp-server.js";
import { TerminalSessionManager } from "../src/terminal/session-manager.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);
const quote = (text) => process.platform === "win32" ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\"'\"'")}'`;
const nodeCommand = (file) => process.platform === "win32"
  ? `& ${quote(process.execPath)} ${quote(file)}; exit $LASTEXITCODE`
  : `${quote(process.execPath)} ${quote(file)}`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(40); }
  throw new Error(`Prazo excedido: ${description}`);
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-shell-lifecycle-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}

test("shell direto preserva contrato e limita stdout/stderr sem esconder truncamento", { timeout: 20_000 }, async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, "output.cjs");
  const size = SHELL_OUTPUT_LIMIT_BYTES * 3;
  await fs.writeFile(file, `process.stdout.write('HEAD_OUT'+ 'A'.repeat(${size}) +'TAIL_OUT');process.stderr.write('HEAD_ERR'+ 'B'.repeat(${size}) +'TAIL_ERR')`);
  const result = await runShellCommand({ command: nodeCommand(file) }, { projectRoot: directory });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.canceled, false);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= SHELL_OUTPUT_LIMIT_BYTES);
  assert.ok(Buffer.byteLength(result.stderr) <= SHELL_OUTPUT_LIMIT_BYTES);
  assert.ok(result.stdoutBytes > SHELL_OUTPUT_LIMIT_BYTES);
  assert.ok(result.stderrBytes > SHELL_OUTPUT_LIMIT_BYTES);
  assert.match(result.stdout, /TAIL_OUT/);
  assert.match(result.stderr, /TAIL_ERR/);
  assert.doesNotMatch(result.stdout, /HEAD_OUT/);
  assert.doesNotMatch(result.stderr, /HEAD_ERR/);
  assert.equal(result.outputLimitBytes, SHELL_OUTPUT_LIMIT_BYTES);
});

test("shell direto preserva retorno curto, exit code e falha de cwd", async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, "exit.cjs");
  await fs.writeFile(file, "console.log('short-result');process.exitCode=7");
  const result = await runShellCommand({ command: nodeCommand(file) }, { projectRoot: directory });
  assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /short-result/);
  assert.equal(result.stdoutTruncated, false);
  const missing = await runShellCommand({ command: "echo ignored", cwd: path.join(directory, "missing") }, { projectRoot: directory });
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.errorCode, "shell_start_failed");
  await assert.rejects(runShellCommand({ command: "echo ignored", timeoutMs: -1 }, { projectRoot: directory }));
});

test("timeout e shutdown encerram descendentes do shell sem matar processo externo", { timeout: 20_000 }, async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, "tree.cjs");
  const pidPath = path.join(directory, "pids.json");
  await fs.writeFile(file, `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(pidPath)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`);
  const outsider = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  try {
    const timeoutResult = await runShellCommand({ command: nodeCommand(file), timeoutMs: 1800 }, { projectRoot: directory });
    const firstPids = JSON.parse(await fs.readFile(pidPath, "utf8"));
    assert.equal(timeoutResult.timedOut, true);
    assert.equal(timeoutResult.errorCode, undefined);
    await until(() => firstPids.every((pid) => !alive(pid)), "descendentes do timeout encerrados");
    assert.ok(alive(outsider.pid));
    await fs.rm(pidPath);
    const pending = runShellCommand({ command: nodeCommand(file) }, { projectRoot: directory });
    const secondPids = await until(async () => { try { return JSON.parse(await fs.readFile(pidPath, "utf8")); } catch { return null; } }, "comando de shutdown iniciou");
    await stopShellCommands();
    const shutdownResult = await pending;
    assert.equal(shutdownResult.canceled, true);
    assert.equal(shutdownResult.timedOut, false);
    assert.equal(shutdownResult.errorCode, undefined);
    await until(() => secondPids.every((pid) => !alive(pid)), "descendentes do shutdown encerrados");
    assert.ok(alive(outsider.pid));
  } finally {
    await stopShellCommands();
    outsider.kill();
    await until(() => !alive(outsider.pid), "fixture externa encerra");
  }
});

test("shutdown HTTP exige segredo local e rejeita browser/proxy/host publico", { timeout: 15_000 }, async (t) => {
  const directory = await fixture(t);
  const config = await loadOrCreateConfig(directory);
  const token = randomBytes(32).toString("base64url");
  let requests = 0;
  const server = await startMcpHttpServer({
    config: { ...config, SERVER_PORT: 0 }, teamManager: {}, tunnelController: {},
    shutdown: { token, onRequest: () => { requests++; } }
  });
  try {
    for (const extra of [
      { "x-mcp-shutdown-token": "" }, { "x-mcp-shutdown-token": "incorrect" },
      { Host: "public.example" }, { Host: "localhost.attacker.example" },
      { Origin: "http://localhost" }, { "X-Forwarded-Host": "public.example" },
      { "X-Forwarded-For": "127.0.0.1" }, { "X-Forwarded-Proto": "https" }, { Forwarded: "for=127.0.0.1" }
    ]) {
      // node:fetch normaliza Host; o cliente HTTP bruto permite testar o cabecalho real.
      const status = await new Promise((resolve, reject) => {
        const request = httpRequest(`${server.localUrl}/api/shutdown`, { method: "POST", headers: { "x-mcp-shutdown-token": token, ...extra } }, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        });
        request.on("error", reject);
        request.end();
      });
      assert.equal(status, 403, JSON.stringify(extra));
    }
    assert.equal(requests, 0);
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await fetch(`${server.localUrl}/api/shutdown`, { method: "POST", headers: { "x-mcp-shutdown-token": token } });
      assert.equal(response.status, 202);
    }
    await until(() => requests === 1, "shutdown agendado uma unica vez");
    server.beginShutdown();
    assert.equal((await fetch(`${server.localUrl}/health`)).status, 503);
  } finally { await server.stop(); }
});

test("erros operacionais de terminal tem codigo estruturado sem stack", async () => {
  const manager = new TerminalSessionManager();
  const server = createMcpServer(root, {}, manager);
  const client = new Client({ name: "terminal-errors", version: "1" });
  try {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const result = await client.callTool({ name: "terminal_status", arguments: { sessionId: "term_00000000-0000-0000-0000-000000000000" } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.data, null);
    assert.equal(result.structuredContent.error.code, "SESSION_NOT_FOUND");
    assert.equal(result.structuredContent.error.stack, undefined);
  } finally { await client.close(); await server.close(); await manager.stop(); }
});

test("script Windows tenta parada normal, limita fallback e rejeita outro processo", { timeout: 90_000, skip: process.platform !== "win32" }, async (t) => {
  for (const mode of ["graceful", "fallback", "foreign"]) {
    await t.test(mode, async (subtest) => {
      const directory = await fixture(subtest);
      const owner = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(root, "test", "fixtures", "lifecycle-server.js"), directory, mode], {
        cwd: directory, windowsHide: true, stdio: ["ignore", "ignore", "pipe"]
      });
      let errors = "";
      owner.stderr.on("data", (chunk) => { errors += chunk; });
      let info;
      try {
        info = await until(async () => { try { return JSON.parse(await fs.readFile(path.join(directory, "ready.json"), "utf8")); } catch { if (owner.exitCode !== null) throw new Error(errors || "Fixture encerrou"); return null; } }, "fixture HTTP pronta");
        const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "stop-server.ps1"), "-ProjectRoot", directory, "-Port", String(info.port), "-GracePeriodSeconds", mode === "fallback" ? "1" : "10"];
        if (mode === "foreign") {
          await assert.rejects(run("powershell.exe", args, { windowsHide: true, timeout: 20_000 }), /outro processo/);
          assert.ok(alive(owner.pid));
          return;
        }
        const result = await run("powershell.exe", args, { windowsHide: true, timeout: 25_000 });
        assert.doesNotMatch(result.stdout, /shutdownToken/);
        await until(() => !alive(owner.pid) && info.pids.every((pid) => !alive(pid)), "servidor e filhos encerrados");
        if (mode === "graceful") {
          assert.doesNotMatch(result.stdout, /fallback forcado/);
          assert.equal(await fs.readFile(path.join(directory, "graceful.txt"), "utf8"), "cleanup completed");
        } else {
          assert.match(result.stdout, /fallback forcado/);
          await assert.rejects(fs.access(path.join(directory, "graceful.txt")));
        }
        assert.ok(await fs.stat(path.join(directory, "data", "config.json")));
        assert.ok(await fs.stat(path.join(directory, "fixture.sqlite")));
      } finally {
        if (alive(owner.pid)) await run("taskkill.exe", ["/PID", String(owner.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
        await until(() => !alive(owner.pid), "fixture removida");
      }
    });
  }
});
