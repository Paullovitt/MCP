import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadOrCreateConfig } from "../src/config.js";
import { createMcpServer } from "../src/mcp-server.js";
import { WorkerTeamManager } from "../src/workers/team-manager.js";
import { runShellCommand } from "../src/tools/shell.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const dayMs = 86_400_000;
const command = "echo timeout-check";
const sleepCommand = (ms) => process.platform === "win32"
  ? `Start-Sleep -Milliseconds ${ms}; Write-Output finished`
  : `sleep ${ms / 1000}; echo finished`;

async function temporaryProject(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-timeouts-"));
  // O teste remove somente o diretorio exclusivo que acabou de criar.
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

test("configuracao nova usa 24 horas e preserva prazos explicitos existentes", async (t) => {
  const directory = await temporaryProject(t);
  const initial = await loadOrCreateConfig(directory);
  assert.equal(initial.WORKER_TASK_TIMEOUT_MS, dayMs);
  assert.equal(initial.FILE_LOCK_TTL_MS, 30_000);
  assert.equal(initial.WORKER_COUNT, 3);
  const configPath = path.join(directory, "data", "config.json");
  await fs.writeFile(configPath, JSON.stringify({ ...initial, WORKER_TASK_TIMEOUT_MS: 4500 }));
  const loaded = await loadOrCreateConfig(directory);
  assert.equal(loaded.WORKER_TASK_TIMEOUT_MS, 4500);
  assert.equal(loaded.OAUTH_LOGIN_PASSWORD, initial.OAUTH_LOGIN_PASSWORD);
  assert.equal(loaded.INSTALL_ID, initial.INSTALL_ID);
  // A migracao recebida do GitHub reconhece especificamente o antigo padrao de 120s.
  await fs.writeFile(configPath, JSON.stringify({ ...loaded, WORKER_TASK_TIMEOUT_MS: 120_000 }));
  const migrated = await loadOrCreateConfig(directory);
  assert.equal(migrated.WORKER_TASK_TIMEOUT_MS, dayMs);
  assert.equal(migrated.OAUTH_SHARED_TOKEN_SECRET, loaded.OAUTH_SHARED_TOKEN_SECRET);
});

test("shell interno usa dez minutos e termina assim que o comando acaba", async (t) => {
  const directory = await temporaryProject(t);
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  // Observa o prazo real armado sem simular dez minutos nem substituir o processo.
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    timers.push(milliseconds);
    return originalSetTimeout(callback, milliseconds, ...args);
  });
  const result = await runShellCommand({ command }, { projectRoot: directory });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /timeout-check/);
  assert.ok(timers.includes(600_000));
});

test("MCP e tres workers respeitam os maximos, erros e cancelamentos", { timeout: 60_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-timeouts-"));
  const projectPath = path.join(directory, "project");
  await fs.mkdir(projectPath);
  await fs.writeFile(path.join(projectPath, "package.json"), JSON.stringify({ name: "timeout-fixture", version: "1.0.0", private: true }));
  const manager = new WorkerTeamManager({ projectRoot: repositoryRoot, databasePath: path.join(directory, "coordinator.sqlite") });
  const server = createMcpServer(projectPath, manager);
  const client = new Client({ name: "timeout-tests", version: "1.0.0" });
  t.after(async () => {
    // Fecha workers e SQLite antes de remover seus arquivos, inclusive no Windows.
    try {
      await client.close();
      await server.close();
    } finally {
      await manager.stop();
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  const dataCall = async (name, args) => (await call(name, args)).data;
  const team = await dataCall("create_worker_team", { projectPath });
  const teamId = team.team.id;
  assert.equal(team.workers.length, 3);
  assert.equal(new Set(team.workers.map((worker) => worker.pid)).size, 3);
  assert.equal(manager.defaultTimeoutMs, dayMs);

  await t.test("schemas anunciam padrao igual ao teto de cada tool", async () => {
    const { tools } = await client.listTools();
    const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
    for (const [name, property, maximum] of [
      ["run_shell", "timeoutMs", 600_000],
      ["npm_install", "timeoutMs", 600_000],
      ["run_tests", "timeoutMs", 300_000],
      ["wait_for_worker_tasks", "timeoutMs", 300_000],
      ["run_parallel_tasks", "waitTimeoutMs", 300_000],
      ["run_shell_background", "timeoutMs", dayMs]
    ]) {
      assert.equal(schemas.get(name).properties[property].default, maximum, `${name}: default`);
      assert.equal(schemas.get(name).properties[property].maximum, maximum, `${name}: maximum`);
    }
    for (const name of ["assign_worker_task", "send_worker_instruction"]) {
      assert.equal(schemas.get(name).properties.timeoutMs.maximum, dayMs);
    }
    assert.equal(schemas.get("run_parallel_tasks").properties.tasks.items.properties.timeoutMs.maximum, dayMs);
  });

  await t.test("prazos invalidos e acima do teto sao recusados antes de executar", async () => {
    for (const [name, args, field, maximum] of [
      ["run_shell", { command }, "timeoutMs", 600_000],
      ["npm_install", {}, "timeoutMs", 600_000],
      ["run_tests", { command }, "timeoutMs", 300_000],
      ["wait_for_worker_tasks", { taskIds: ["not-a-task"] }, "timeoutMs", 300_000],
      ["run_parallel_tasks", { teamId, tasks: [{ operation: "list_files" }] }, "waitTimeoutMs", 300_000],
      ["assign_worker_task", { teamId, operation: "list_files" }, "timeoutMs", dayMs],
      ["run_shell_background", { teamId, command }, "timeoutMs", dayMs]
    ]) {
      for (const value of [0, -1, 1.5, maximum + 1]) {
        const result = await client.callTool({ name, arguments: { ...args, [field]: value } });
        assert.equal(result.isError, true, `${name} aceitou ${value}`);
      }
    }
  });

  await t.test("comandos diretos e npm offline executam com seus novos padroes", async (subtest) => {
    const timers = [];
    const originalSetTimeout = globalThis.setTimeout;
    subtest.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
      timers.push(milliseconds);
      return originalSetTimeout(callback, milliseconds, ...args);
    });
    for (const [name, args, maximum] of [
      ["run_shell", { command }, 600_000],
      ["run_tests", { command }, 300_000],
      ["npm_install", { flags: ["--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"] }, 600_000]
    ]) {
      timers.length = 0;
      const result = await call(name, args);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.timedOut, false);
      assert.ok(timers.includes(maximum), `${name} nao armou o prazo esperado`);
    }
  });

  await t.test("tres tarefas paralelas herdam 24 horas e prazos menores prevalecem", async () => {
    const batch = await dataCall("run_parallel_tasks", {
      teamId,
      tasks: team.workers.map((worker) => ({ workerId: worker.id, operation: "run_shell", params: { command } }))
    });
    assert.equal(batch.tasks.length, 3);
    assert.ok(batch.tasks.every((task) => task.timeoutMs === dayMs));
    const finished = await dataCall("wait_for_worker_tasks", { taskIds: batch.tasks.map((task) => task.id) });
    assert.equal(finished.completed, true);
    assert.ok(finished.tasks.every((task) => task.status === "concluido"));
    const custom = await dataCall("assign_worker_task", { teamId, operation: "list_files", timeoutMs: 5000 });
    assert.equal(custom.timeoutMs, 5000);
    const done = await dataCall("wait_for_worker_tasks", { taskIds: [custom.id] });
    assert.equal(done.tasks[0].status, "concluido");
    const followup = await dataCall("send_worker_instruction", {
      teamId, workerId: team.workers[0].id, message: "Verificar arquivos", operation: "list_files"
    });
    assert.equal(followup.followupTask.timeoutMs, dayMs);
    await dataCall("wait_for_worker_tasks", { taskIds: [followup.followupTask.id] });
  });

  await t.test("espera curta expira sem cancelar comando em segundo plano", async () => {
    const started = await dataCall("run_shell_background", { teamId, command: sleepCommand(650) });
    assert.equal(started.timeoutMs, dayMs);
    const waiting = await dataCall("wait_for_worker_tasks", { taskIds: [started.taskId], timeoutMs: 1, pollMs: 10 });
    assert.equal(waiting.timedOut, true);
    assert.equal(waiting.tasks[0].cancelRequested, false);
    const finished = await dataCall("wait_for_worker_tasks", { taskIds: [started.taskId], timeoutMs: 10_000 });
    assert.equal(finished.tasks[0].status, "concluido");
  });

  await t.test("timeout explicito encerra comando e libera bloqueios", async () => {
    const task = await dataCall("assign_worker_task", {
      teamId, operation: "run_shell", params: { command: sleepCommand(10_000) },
      readPaths: ["package.json"], timeoutMs: 200
    });
    const finished = await dataCall("wait_for_worker_tasks", { taskIds: [task.id], timeoutMs: 10_000 });
    assert.equal(finished.tasks[0].status, "timeout");
    // Cancelamentos retornam o erro no task; a saida do comando permanece nos logs.
    assert.equal(finished.tasks[0].error.code, "timeout");
    const commandLog = manager.getLogs({ taskId: task.id, limit: 100 }).find((entry) => entry.event === "command_finished");
    assert.equal(commandLog.data.timedOut, true);
    assert.deepEqual(manager.store.getLocks({ taskId: task.id }), []);
  });

  await t.test("tarefa com prazo de 24 horas permanece cancelavel", async () => {
    const started = await dataCall("run_shell_background", { teamId, command: sleepCommand(10_000), readPaths: ["package.json"] });
    const deadline = Date.now() + 5000;
    // Aguarda o comando iniciar de verdade para exercitar o cancelamento em execucao.
    while (Date.now() < deadline && !manager.getLogs({ taskId: started.taskId, limit: 100 }).some((entry) => entry.event === "command_started")) {
      await delay(20);
    }
    assert.equal(manager.getTaskResult(started.taskId).status, "executando");
    await dataCall("cancel_worker_task", { taskId: started.taskId });
    const finished = await dataCall("wait_for_worker_tasks", { taskIds: [started.taskId], timeoutMs: 10_000 });
    assert.equal(finished.tasks[0].status, "cancelado");
    assert.deepEqual(manager.store.getLocks({ taskId: started.taskId }), []);
  });

  await t.test("escrita, leitura e Code Intelligence continuam funcionando", async () => {
    const written = await dataCall("assign_worker_task", {
      teamId, operation: "write_file", params: { path: "sample.js", content: "export const answer = 42;\n" }
    });
    const finished = await dataCall("wait_for_worker_tasks", { taskIds: [written.id], timeoutMs: 15_000 });
    assert.equal(finished.tasks[0].status, "concluido");
    assert.equal(finished.tasks[0].result.intelligence.mode, "always");
    assert.equal(finished.tasks[0].result.intelligence.verified, true);
    assert.notEqual(finished.tasks[0].result.intelligence.status, "failed");
    assert.equal(await fs.readFile(path.join(projectPath, "sample.js"), "utf8"), "export const answer = 42;\n");
    assert.deepEqual(manager.store.getLocks({ taskId: written.id }), []);
    const read = await call("read_file", { path: "sample.js" });
    assert.match(read.content, /answer = 42/);
  });
});
