import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork, spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OutputBuffer } from "../src/terminal/output-buffer.js";
import { TerminalSessionManager } from "../src/terminal/session-manager.js";
import { createMcpServer, startMcpHttpServer } from "../src/mcp-server.js";
import { loadOrCreateConfig } from "../src/config.js";

async function until(check, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(30);
  }
  throw new Error(`Prazo excedido: ${description}`);
}

async function outputMatching(manager, sessionId, pattern, afterOffset = 0) {
  let output = "";
  let cursor = afterOffset;
  return until(() => {
    const result = manager.read({ sessionId, afterOffset: cursor, stripAnsi: true });
    output += result.output;
    cursor = result.cursor;
    return pattern.test(output) && { output, cursor };
  }, `saida ${pattern}`);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("ring buffer limita memoria, pagina cursores e preserva Unicode", () => {
  const buffer = new OutputBuffer(16);
  buffer.append("abcdefghijklmnopqrst");
  assert.equal(buffer.size, 16);
  assert.deepEqual(buffer.read(0, 4), {
    output: "efgh", cursor: 8, startOffset: 4, endOffset: 20, truncatedBefore: true, hasMore: true, bytes: 4
  });
  assert.equal(buffer.read(8, 50).output, "ijklmnopqrst");
  assert.equal(buffer.read(20).output, "");
  assert.throws(() => buffer.read(-1));
  assert.throws(() => buffer.read(21));
  assert.throws(() => buffer.read(0, 3));
  assert.throws(() => new OutputBuffer(0));
  const unicode = new OutputBuffer(13);
  unicode.append("12345😀ação😀");
  let cursor = 0;
  let output = "";
  while (cursor < unicode.endOffset) {
    const part = unicode.read(cursor, 4);
    assert.ok(part.cursor > cursor);
    assert.ok(part.bytes <= 4);
    output += part.output;
    cursor = part.cursor;
  }
  assert.equal(output, "ação😀");
  assert.ok(!output.includes("�"));
  unicode.append("A".repeat(1_000_000));
  assert.equal(unicode.storage.length, 13);
  assert.equal(unicode.read().output, "A".repeat(13));
});

test("terminais reais: estado, interacao, seguranca e lifecycle", { timeout: 120_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-terminal-test-"));
  const events = [];
  const manager = new TerminalSessionManager({ projectRoot: directory, logger: { info: (...args) => events.push(args) } });
  t.after(async () => {
    await manager.stop();
    // Somente a pasta exclusiva criada acima e removida; nao usa dados do MCP instalado.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  for (const { shell, declaration, expression, prompt, exit } of [
    { shell: "node", declaration: "var x = 50", expression: "console.log('VALUE_' + (x * 10))", prompt: /> /, exit: ".exit" },
    { shell: "python", declaration: "x = 50", expression: "print('VALUE_' + str(x * 10))", prompt: />>>/, exit: "exit()" },
    { shell: "powershell", declaration: "$x = 50", expression: "Write-Output ('VALUE_' + ($x * 10))", prompt: /PS .*?>/, exit: "exit" }
  ]) {
    await t.test(`${shell}: variavel persiste e saida natural informa exitCode`, async (subtest) => {
      const executable = shell === "python" ? (process.platform === "win32" ? "python.exe" : "python3") : "pwsh";
      if ((shell === "python" || (shell === "powershell" && process.platform !== "win32")) && spawnSync(executable, ["--version"], { windowsHide: true }).error) {
        subtest.skip(`Instale ${executable} para validar este perfil.`);
        return;
      }
      const session = await manager.start({ shell, cwd: directory });
      const { sessionId } = session;
      assert.equal(session.backend, "pty");
      assert.equal(session.cwd, directory);
      await outputMatching(manager, sessionId, prompt);
      const beforeDeclaration = manager.status(sessionId).endOffset;
      await manager.send({ sessionId, data: declaration });
      // REPL nao e fila de comandos: aguarda o novo prompt antes da proxima avaliacao.
      await outputMatching(manager, sessionId, shell === "node" ? /undefined[\s\S]*> / : prompt, beforeDeclaration);
      await manager.send({ sessionId, data: expression });
      const result = await outputMatching(manager, sessionId, /VALUE_500/);
      assert.equal(manager.read({ sessionId, afterOffset: result.cursor }).output, "");
      await manager.send({ sessionId, data: exit });
      await until(() => manager.status(sessionId).status === "exited", "saida natural");
      assert.equal(manager.status(sessionId).exitCode, 0);
      assert.ok(!isAlive(session.pid));
      assert.throws(() => manager.resize({ sessionId, cols: 0, rows: 10 }));
      await assert.rejects(manager.send({ sessionId, data: "nao executar" }));
      assert.equal((await manager.close(sessionId)).status, "exited");
    });
  }

  await t.test("PTY real, prompt y/n, Unicode e input sem Enter", async () => {
    const script = "console.log('TTY_'+Boolean(process.stdin.isTTY));const rl=require('node:readline').createInterface({input:process.stdin,output:process.stdout});rl.question('CONTINUE?',answer=>{console.log('RESULT_'+answer.toUpperCase());rl.close()});";
    const { sessionId } = await manager.start({ shell: "node", args: ["-e", script] });
    await outputMatching(manager, sessionId, /CONTINUE\?/);
    assert.match(manager.read({ sessionId, stripAnsi: true }).output, /TTY_true/);
    await manager.send({ sessionId, data: "ação", newline: false });
    await delay(100);
    assert.doesNotMatch(manager.read({ sessionId, stripAnsi: true }).output, /RESULT_AÇÃO/);
    assert.equal(manager.status(sessionId).status, "running");
    await manager.send({ sessionId, data: "", newline: true });
    await outputMatching(manager, sessionId, /RESULT_AÇÃO/);
    await until(() => manager.status(sessionId).status === "exited", "resposta encerra CLI");
  });

  await t.test("resize e Ctrl+C interrompem um comando sem perder a sessao", async () => {
    const { sessionId } = await manager.start({ shell: "node" });
    await outputMatching(manager, sessionId, /> /);
    const resized = await manager.resize({ sessionId, cols: 97, rows: 23 });
    assert.equal(resized.cols, 97);
    await manager.send({ sessionId, data: "console.log('SIZE_' + process.stdout.columns)" });
    await outputMatching(manager, sessionId, /SIZE_97/);
    await manager.send({ sessionId, data: "while (true) {}" });
    await delay(200);
    await manager.send({ sessionId, data: "\u0003", newline: false });
    await outputMatching(manager, sessionId, /interrupted|SIGINT/);
    await manager.send({ sessionId, data: "console.log('RECOVER_' + 42)" });
    await outputMatching(manager, sessionId, /RECOVER_42/);
    await manager.close(sessionId);
  });

  await t.test("sessao e descendente sao encerrados juntos", async () => {
    const script = "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('CHILD_'+child.pid);setInterval(()=>{},1000)";
    const session = await manager.start({ shell: "node", args: ["-e", script] });
    const { output } = await outputMatching(manager, session.sessionId, /CHILD_\d+/);
    const childPid = Number(output.match(/CHILD_(\d+)/)[1]);
    assert.ok(isAlive(childPid));
    const [closed, duplicate] = await Promise.all([manager.close(session.sessionId), manager.close(session.sessionId)]);
    assert.equal(closed.status, "closed");
    assert.equal(duplicate.status, "closed");
    await until(() => !isAlive(session.pid) && !isAlive(childPid), "arvore encerrada");
  });

  await t.test("falhas de executavel, cwd, cursor e ambiente sao explicitas", async () => {
    await assert.rejects(manager.start({ shell: "mcp_missing_executable_318972.exe" }), /PTY|Terminal|executavel/i);
    await assert.rejects(manager.start({ shell: "node", cwd: path.join(directory, "missing") }));
    await fs.writeFile(path.join(directory, "not-directory"), "fixture");
    await assert.rejects(manager.start({ cwd: path.join(directory, "not-directory") }), /diretorio/);
    await assert.rejects(manager.start({ env: { MCP_OAUTH_SHARED_TOKEN_SECRET: "secret" } }), /MCP/);
    await assert.rejects(manager.start({ env: { BAD: "\0" } }));
    assert.throws(() => manager.status("term_00000000-0000-0000-0000-000000000000"), /inexistente/);
    const session = await manager.start({ shell: "node", env: { TERMINAL_TEST_VALUE: "env-secret-489" } });
    await outputMatching(manager, session.sessionId, /> /);
    assert.throws(() => manager.read({ sessionId: session.sessionId, afterOffset: Number.MAX_SAFE_INTEGER }), /Cursor/);
    assert.throws(() => manager.read({ sessionId: session.sessionId, maxBytes: 262144 }), /limite/);
    await assert.rejects(manager.send({ sessionId: session.sessionId, data: "😀".repeat(20000) }), /Limite/);
    await manager.send({ sessionId: session.sessionId, data: "var password = 'input-secret-739'; console.log(process.env.TERMINAL_TEST_VALUE)" });
    await outputMatching(manager, session.sessionId, /env-secret-489/);
    await manager.close(session.sessionId);
    assert.doesNotMatch(JSON.stringify(events), /input-secret|env-secret|TERMINAL_TEST_VALUE|password/);
  });

  await t.test("saida intensa respeita buffer e retorna truncamento explicito", async () => {
    const limited = new TerminalSessionManager({ projectRoot: directory, config: { TERMINAL_BUFFER_BYTES: 4096 } });
    try {
      const session = await limited.start({ shell: "node", args: ["-e", "process.stdout.write('a'.repeat(200000));console.log('END_OF_OUTPUT')"] });
      await until(() => limited.status(session.sessionId).status === "exited", "saida intensa termina");
      const read = limited.read({ sessionId: session.sessionId });
      assert.equal(read.truncatedBefore, true);
      assert.ok(read.bytes <= 4096);
      assert.match(read.output, /END_OF_OUTPUT/);
      assert.ok(limited.status(session.sessionId).endOffset > 100_000);
    } finally { await limited.stop(); }
  });

  await t.test("limite inclui inicializacoes concorrentes; idle e retencao limpam sessoes", async () => {
    const limited = new TerminalSessionManager({ projectRoot: directory, config: { TERMINAL_MAX_SESSIONS: 1, TERMINAL_RETENTION_MS: 40 } });
    try {
      const first = limited.start({ shell: "node", idleTimeoutMs: 200 });
      await assert.rejects(limited.start({ shell: "node" }), /Limite/);
      const session = await first;
      const internal = limited.get(session.sessionId);
      await until(() => internal.endedAt !== null, "idle fecha terminal");
      assert.equal(internal.closeReason, "idle_timeout");
      await delay(50);
      assert.equal(limited.list().length, 0);
      assert.throws(() => limited.status(session.sessionId), /expirada/);
      await limited.stop();
      await assert.rejects(limited.start({ shell: "node" }), /encerrando/);
    } finally { await limited.stop(); }
  });

  await t.test("crash do host nao derruba manager e shutdown fecha sessoes", async () => {
    const session = await manager.start({ shell: "node" });
    await outputMatching(manager, session.sessionId, /> /);
    manager.get(session.sessionId).host.kill("SIGKILL");
    await until(() => manager.status(session.sessionId).status === "error", "crash identificado");
    await until(() => !isAlive(session.pid), "PTY do host morto encerrada");
    const second = new TerminalSessionManager({ projectRoot: directory });
    const sessions = await Promise.all([second.start({ shell: "node" }), second.start({ shell: "node" })]);
    await second.stop();
    assert.equal(second.list().length, 0);
    for (const current of sessions) assert.ok(!isAlive(current.pid));
  });

  await t.test("processo sem primeira saida tambem pode ser fechado", async () => {
    // node-pty adia certas operacoes ate receber dados; taskkill da arvore nao depende disso.
    const session = await manager.start({ shell: "node", args: ["-e", "setInterval(()=>{},1000)"] });
    await manager.close(session.sessionId);
    assert.equal(manager.status(session.sessionId).status, "closed");
    assert.ok(!isAlive(session.pid));
    assert.ok(manager.list().filter((item) => item.endedAt !== null).length <= 8);
  });
});

test("addon ausente falha explicitamente sem afetar o processo MCP", { timeout: 10_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-terminal-no-addon-"));
  let host;
  try {
    // Copia apenas o host para um diretorio sem node_modules; nao remove dependencias instaladas.
    const hostPath = path.join(directory, "pty-host.mjs");
    await fs.copyFile(new URL("../src/terminal/pty-host.js", import.meta.url), hostPath);
    host = fork(hostPath, [], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
    let failure;
    host.on("message", (message) => { if (message.type === "failure") failure = message; });
    host.send({ type: "start", executable: process.execPath, args: ["-i"], cwd: directory, env: {}, cols: 80, rows: 24 });
    await until(() => failure, "erro de addon ausente");
    assert.equal(failure.code, "PTY_UNAVAILABLE");
    await until(() => host.exitCode !== null, "host sem addon encerra");
  } finally {
    if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("perda abrupta do MCP encerra o terminal via disconnect IPC", { timeout: 20_000 }, async () => {
  const moduleUrl = new URL("../src/terminal/session-manager.js", import.meta.url).href;
  // Simula um MCP descartavel, nao encerra o servidor real nem toca no OAuth instalado.
  const owner = spawn(process.execPath, ["--input-type=module", "-e", `
    import {TerminalSessionManager} from ${JSON.stringify(moduleUrl)};
    const manager=new TerminalSessionManager();
    const session=await manager.start({shell:'node'});
    process.send({pid:session.pid,hostPid:manager.get(session.sessionId).host.pid});
  `], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let session;
  owner.on("message", (message) => { session = message; });
  try {
    await until(() => session, "owner iniciou terminal");
    assert.ok(isAlive(session.pid));
    await delay(300);
    owner.kill("SIGKILL");
    await until(() => !isAlive(session.pid) && !isAlive(session.hostPid), "IPC desconectado limpa host e PTY");
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
  }
});

test("tools MCP compartilham sessoes entre reconexoes sem alterar tools antigas", { timeout: 20_000 }, async (t) => {
  const manager = new TerminalSessionManager();
  t.after(() => manager.stop());
  async function connect() {
    const server = createMcpServer(process.cwd(), {}, manager);
    const client = new Client({ name: "terminal-regression", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      return result.structuredContent;
    };
    return { client, server, call, close: async () => { await client.close(); await server.close(); } };
  }
  const first = await connect();
  let sessionId;
  try {
    const { tools } = await first.client.listTools();
    assert.equal(tools.filter((tool) => tool.name.startsWith("terminal_")).length, 7);
    assert.equal(tools.length, 41);
    const result = await first.call("terminal_start", { shell: "node" });
    sessionId = result.data.sessionId;
    await outputMatching(manager, sessionId, /> /);
    await first.call("terminal_send", { sessionId, data: "var persisted = 21" });
    await outputMatching(manager, sessionId, /undefined/);
    const bad = await first.client.callTool({ name: "terminal_resize", arguments: { sessionId, cols: -1, rows: 10 } });
    assert.equal(bad.isError, true);
    assert.equal((await first.call("run_shell", { command: "echo old-shell-ok" })).exitCode, 0);
  } finally { await first.close(); }
  const second = await connect();
  try {
    assert.equal((await second.call("terminal_status", { sessionId })).data.status, "running");
    assert.equal((await second.call("terminal_list")).data.length, 1);
    await second.call("terminal_resize", { sessionId, cols: 99, rows: 24 });
    await second.call("terminal_send", { sessionId, data: "console.log('PERSISTED_' + persisted * 2)" });
    await outputMatching(manager, sessionId, /PERSISTED_42/);
    const read = (await second.call("terminal_read", { sessionId, maxBytes: 4096 })).data;
    assert.match(read.output, /PERSISTED_42/);
    const again = (await second.call("terminal_read", { sessionId, afterOffset: read.cursor })).data;
    assert.ok(again.cursor >= read.cursor);
    assert.equal((await second.call("terminal_close", { sessionId })).data.status, "closed");
  } finally { await second.close(); }
});

test("HTTP protege novas tools com OAuth e configura limites sem mudar credenciais", { timeout: 10_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-terminal-http-"));
  const manager = new TerminalSessionManager();
  let server;
  try {
    const original = await loadOrCreateConfig(directory);
    assert.equal(original.TERMINAL_MAX_SESSIONS, 8);
    assert.equal(original.TERMINAL_IDLE_TIMEOUT_MS, 0);
    const config = await loadOrCreateConfig(directory);
    assert.equal(config.OAUTH_LOGIN_PASSWORD, original.OAUTH_LOGIN_PASSWORD);
    server = await startMcpHttpServer({ config: { ...config, SERVER_PORT: 0 }, teamManager: {}, tunnelController: {}, terminalManager: manager });
    assert.equal((await fetch(`${server.localUrl}/health`)).status, 200);
    for (const token of [null, "invalid"]) {
      const result = await fetch(server.localMcpUrl, {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "terminal_start", arguments: { shell: "node" } } })
      });
      assert.equal(result.status, 401);
      assert.match(result.headers.get("www-authenticate"), /Bearer/);
    }
    assert.equal(manager.list().length, 0);
    await fs.writeFile(path.join(directory, "data", "config.json"), JSON.stringify({ ...config, TERMINAL_MAX_SESSIONS: -1 }));
    await assert.rejects(loadOrCreateConfig(directory));
  } finally {
    if (server) await server.stop();
    await manager.stop();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
