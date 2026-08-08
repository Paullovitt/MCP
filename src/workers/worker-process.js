import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  copyPath,
  createDirectory,
  deletePath,
  listFiles,
  movePath,
  readFileText,
  searchFiles
} from "../tools/filesystem.js";
import { snapshotPaths, findSnapshotChanges } from "./file-state.js";

const MAX_OUTPUT_CHARS = 2_000_000;
let currentTaskId = null;
let currentCommand = null;
let cancellation = null;
let shuttingDown = false;
const intelligenceRequests = new Map();

function send(message) {
  if (process.connected) {
    process.send(message);
  }
}

function log(level, event, message, data = null, taskId = currentTaskId) {
  send({ type: "log", taskId, level, event, message, data, createdAt: Date.now() });
}

function resolveTaskPath(projectRoot, inputPath = ".") {
  if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
  return path.resolve(projectRoot, inputPath);
}

function appendLimited(current, chunk) {
  if (current.length >= MAX_OUTPUT_CHARS) return current;
  return (current + chunk.toString()).slice(0, MAX_OUTPUT_CHARS);
}

function killCommandTree(child) {
  if (!child?.pid) return;
  if (os.platform() === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function cancelCurrent(reason = "cancelado") {
  if (!currentTaskId) return false;
  cancellation = { reason, at: Date.now() };
  if (currentCommand) {
    killCommandTree(currentCommand);
  }
  return true;
}

function shellCommand(command) {
  if (os.platform() === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
    };
  }
  return { executable: "/bin/sh", args: ["-lc", command] };
}

async function runCommand({ command, cwd, timeoutMs }) {
  const started = performance.now();
  const shell = shellCommand(command);
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  log("info", "command_started", "Comando iniciado.", { command, cwd, timeoutMs });

  const result = await new Promise((resolve) => {
    const child = spawn(shell.executable, shell.args, {
      cwd,
      windowsHide: true,
      detached: os.platform() !== "win32"
    });
    currentCommand = child;

    const timer = setTimeout(() => {
      timedOut = true;
      cancellation = { reason: "timeout", at: Date.now() };
      killCommandTree(child);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
      send({ type: "log", taskId: currentTaskId, level: "info", event: "stdout", message: chunk.toString().slice(0, 20_000), data: null, createdAt: Date.now() });
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
      send({ type: "log", taskId: currentTaskId, level: "warn", event: "stderr", message: chunk.toString().slice(0, 20_000), data: null, createdAt: Date.now() });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      currentCommand = null;
      resolve({ exitCode: 1, error });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      currentCommand = null;
      resolve({ exitCode, error: null });
    });
  });

  const commandResult = {
    command,
    cwd,
    stdout,
    stderr,
    exitCode: result.exitCode,
    timedOut,
    canceled: Boolean(cancellation && cancellation.reason !== "timeout"),
    durationMs: Math.round(performance.now() - started)
  };

  log(result.exitCode === 0 ? "info" : "error", "command_finished", "Comando finalizado.", commandResult);

  if (result.error) throw result.error;
  return commandResult;
}

async function verifyExpectedSnapshots(task) {
  const writePaths = task.writePaths || [];
  if (writePaths.length === 0) return;
  const actual = await snapshotPaths(writePaths);
  const changes = findSnapshotChanges(task.expectedSnapshots || {}, actual);
  if (changes.length > 0) {
    const error = new Error("Arquivo alterado depois da atribuicao da tarefa.");
    error.code = "file_changed_before_write";
    error.details = changes;
    throw error;
  }
}

function checkCanceled() {
  if (!cancellation) return;
  const error = new Error(cancellation.reason === "timeout" ? "Tempo limite excedido." : "Tarefa cancelada.");
  error.code = cancellation.reason === "timeout" ? "timeout" : "canceled";
  throw error;
}

function requestCodeIntelligence(action, params, timeoutMs) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      intelligenceRequests.delete(requestId);
      const error = new Error("Code Intelligence excedeu o tempo limite.");
      error.code = "code_intelligence_timeout";
      reject(error);
    }, timeoutMs);
    intelligenceRequests.set(requestId, { resolve, reject, timer });
    send({ type: "code_intelligence_request", requestId, taskId: currentTaskId, action, params });
  });
}

async function executeOperation(task, { verifySnapshots = true } = {}) {
  const projectRoot = task.projectRoot;
  const params = task.params || {};
  const filesUsed = new Set([...(task.readPaths || []), ...(task.writePaths || [])]);
  const commands = [];

  checkCanceled();
  if (verifySnapshots) await verifyExpectedSnapshots(task);
  checkCanceled();

  switch (task.operation) {
    case "read_file": {
      const result = await readFileText(
        {
          path: resolveTaskPath(projectRoot, params.path),
          encoding: params.encoding || "utf8",
          maxChars: params.maxChars ?? 200_000
        },
        { projectRoot }
      );
      filesUsed.add(resolveTaskPath(projectRoot, params.path));
      return { output: result, filesUsed: [...filesUsed], commands };
    }

    case "list_files": {
      const result = await listFiles(
        {
          path: resolveTaskPath(projectRoot, params.path || "."),
          recursive: params.recursive === true,
          maxEntries: params.maxEntries ?? 500,
          maxDepth: params.maxDepth ?? 8
        },
        { projectRoot }
      );
      return { output: result, filesUsed: [...filesUsed], commands };
    }

    case "search_files": {
      const result = await searchFiles(
        {
          path: resolveTaskPath(projectRoot, params.path || "."),
          query: params.query,
          recursive: params.recursive !== false,
          caseSensitive: params.caseSensitive === true,
          includePattern: params.includePattern,
          maxMatches: params.maxMatches ?? 200,
          maxDepth: params.maxDepth ?? 12
        },
        { projectRoot }
      );
      for (const match of result.matches) {
        filesUsed.add(resolveTaskPath(projectRoot, match.path));
      }
      return { output: result, filesUsed: [...filesUsed], commands };
    }

    case "write_file": {
      const filePath = resolveTaskPath(projectRoot, params.path);
      await fs.mkdir(path.dirname(filePath), { recursive: params.createDirectories !== false });
      await fs.writeFile(filePath, String(params.content ?? ""), params.encoding || "utf8");
      filesUsed.add(filePath);
      return {
        output: { path: filePath, bytes: Buffer.byteLength(String(params.content ?? ""), params.encoding || "utf8") },
        filesUsed: [...filesUsed],
        commands
      };
    }

    case "apply_patch": {
      const filePath = resolveTaskPath(projectRoot, params.path);
      const content = await fs.readFile(filePath, "utf8");
      if (!content.includes(params.search)) {
        const error = new Error("Texto exato de busca nao encontrado no arquivo.");
        error.code = "patch_search_not_found";
        throw error;
      }
      const replacements = params.replaceAll === true ? content.split(params.search).length - 1 : 1;
      const updated = params.replaceAll === true
        ? content.split(params.search).join(params.replace ?? "")
        : content.replace(params.search, params.replace ?? "");
      await fs.writeFile(filePath, updated, "utf8");
      filesUsed.add(filePath);
      return { output: { path: filePath, replacements }, filesUsed: [...filesUsed], commands };
    }

    case "create_directory": {
      const result = await createDirectory(
        { path: resolveTaskPath(projectRoot, params.path), recursive: params.recursive !== false },
        { projectRoot }
      );
      filesUsed.add(resolveTaskPath(projectRoot, params.path));
      return { output: result, filesUsed: [...filesUsed], commands };
    }

    case "copy_path": {
      const result = await copyPath(
        {
          source: resolveTaskPath(projectRoot, params.source),
          destination: resolveTaskPath(projectRoot, params.destination),
          recursive: params.recursive === true,
          overwrite: params.overwrite === true,
          createDirectories: params.createDirectories !== false
        },
        { projectRoot }
      );
      filesUsed.add(resolveTaskPath(projectRoot, params.source));
      filesUsed.add(resolveTaskPath(projectRoot, params.destination));
      return { output: result, filesUsed: [...filesUsed], commands };
    }

    case "move_path": {
      const result = await movePath(
        {
          source: resolveTaskPath(projectRoot, params.source),
          destination: resolveTaskPath(projectRoot, params.destination),
          overwrite: params.overwrite === true,
          createDirectories: params.createDirectories !== false
        },
        { projectRoot }
      );
      filesUsed.add(resolveTaskPath(projectRoot, params.source));
      filesUsed.add(resolveTaskPath(projectRoot, params.destination));
      return { output: result, filesUsed: [...filesUsed], commands };
    }

    case "delete_path": {
      const result = await deletePath(
        {
          path: resolveTaskPath(projectRoot, params.path),
          recursive: params.recursive === true,
          force: params.force === true
        },
        { projectRoot }
      );
      filesUsed.add(resolveTaskPath(projectRoot, params.path));
      return { output: result, filesUsed: [...filesUsed], commands };
    }

    case "run_shell":
    case "run_tests": {
      const command = task.operation === "run_tests" ? params.command || "npm test" : params.command;
      const cwd = resolveTaskPath(projectRoot, params.cwd || ".");
      const commandResult = await runCommand({ command, cwd, timeoutMs: task.timeoutMs });
      commands.push(commandResult);
      checkCanceled();
      if (commandResult.exitCode !== 0) {
        const error = new Error(`Comando terminou com codigo ${commandResult.exitCode}.`);
        error.code = commandResult.timedOut ? "timeout" : "command_failed";
        error.commandResult = commandResult;
        throw error;
      }
      return { output: commandResult, filesUsed: [...filesUsed], commands };
    }

    case "git_status": {
      const cwd = resolveTaskPath(projectRoot, params.cwd || ".");
      const commandResult = await runCommand({ command: "git status --short --branch", cwd, timeoutMs: task.timeoutMs });
      commands.push(commandResult);
      if (commandResult.exitCode !== 0) {
        const error = new Error("git status falhou.");
        error.code = "command_failed";
        error.commandResult = commandResult;
        throw error;
      }
      return { output: commandResult, filesUsed: [...filesUsed], commands };
    }

    case "git_diff": {
      const cwd = resolveTaskPath(projectRoot, params.cwd || ".");
      const staged = params.staged === true ? "--staged" : "";
      const pathspec = params.pathspec ? ` -- '${String(params.pathspec).replaceAll("'", "''")}'` : "";
      const commandResult = await runCommand({ command: `git diff ${staged}${pathspec}`.trim(), cwd, timeoutMs: task.timeoutMs });
      commands.push(commandResult);
      if (commandResult.exitCode !== 0) {
        const error = new Error("git diff falhou.");
        error.code = "command_failed";
        error.commandResult = commandResult;
        throw error;
      }
      return { output: commandResult, filesUsed: [...filesUsed], commands };
    }

    case "batch_operations": {
      const operations = params.operations;
      if (!Array.isArray(operations) || operations.length === 0 || operations.length > 50) {
        const error = new Error("batch_operations exige de 1 a 50 operacoes.");
        error.code = "invalid_batch";
        throw error;
      }
      const results = [];
      for (const [index, definition] of operations.entries()) {
        checkCanceled();
        try {
          // O lote valida o snapshot uma unica vez para nao confundir suas proprias escritas com alteracoes externas.
          const operationResult = await executeOperation({
            ...task,
            operation: definition.operation,
            params: definition.params || {},
            readPaths: definition.readPaths || [],
            writePaths: definition.writePaths || [],
            expectedSnapshots: {}
          }, { verifySnapshots: false });
          for (const filePath of operationResult.filesUsed || []) filesUsed.add(filePath);
          commands.push(...(operationResult.commands || []));
          results.push({ index, operation: definition.operation, output: operationResult.output });
        } catch (error) {
          error.details = { ...(error.details || {}), batchIndex: index, operation: definition.operation };
          throw error;
        }
      }
      return {
        output: { operationCount: operations.length, results },
        filesUsed: [...filesUsed],
        commands
      };
    }

    case "code_context": {
      const result = await requestCodeIntelligence("context", params, task.timeoutMs);
      return { output: result, filesUsed: [...filesUsed], commands };
    }

    case "code_query": {
      const result = await requestCodeIntelligence("query", params, task.timeoutMs);
      return { output: result, filesUsed: [...filesUsed], commands };
    }

    case "code_diagnostics": {
      const result = await requestCodeIntelligence("diagnostics", params, task.timeoutMs);
      return { output: result, filesUsed: [...filesUsed], commands };
    }

    default: {
      const error = new Error(`Operacao de worker nao suportada: ${task.operation}`);
      error.code = "unsupported_operation";
      throw error;
    }
  }
}

async function handleExecute(task) {
  if (currentTaskId) {
    send({
      type: "result",
      taskId: task.id,
      status: "erro",
      error: { code: "worker_busy", message: "Worker ja esta executando outra tarefa." },
      result: null,
      startedAt: Date.now(),
      finishedAt: Date.now()
    });
    return;
  }

  currentTaskId = task.id;
  cancellation = null;
  const startedAt = Date.now();
  log("info", "task_started", "Tarefa iniciada no processo worker.", { operation: task.operation, pid: process.pid });

  let watchdog = null;
  if (task.operation !== "run_shell" && task.operation !== "run_tests" && task.operation !== "git_status" && task.operation !== "git_diff") {
    watchdog = setTimeout(() => cancelCurrent("timeout"), task.timeoutMs);
  }

  try {
    const result = await executeOperation(task);
    checkCanceled();
    const after = await snapshotPaths(task.writePaths || []);
    send({
      type: "result",
      taskId: task.id,
      status: "concluido",
      result: { ...result, after },
      error: null,
      startedAt,
      finishedAt: Date.now()
    });
  } catch (error) {
    const status = error.code === "timeout" ? "timeout" : error.code === "canceled" ? "cancelado" : "erro";
    send({
      type: "result",
      taskId: task.id,
      status,
      result: error.commandResult ? { commandResult: error.commandResult } : null,
      error: {
        code: error.code || "worker_error",
        message: error.message,
        details: error.details || null
      },
      startedAt,
      finishedAt: Date.now()
    });
  } finally {
    if (watchdog) clearTimeout(watchdog);
    currentTaskId = null;
    currentCommand = null;
    cancellation = null;
    if (shuttingDown) process.exit(0);
  }
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "execute") {
    handleExecute(message.task).catch((error) => {
      send({ type: "fatal", error: { message: error.message, stack: error.stack }, taskId: message.task?.id || null });
    });
    return;
  }

  if (message.type === "code_intelligence_response") {
    const pending = intelligenceRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    intelligenceRequests.delete(message.requestId);
    if (message.error) {
      const error = new Error(message.error.message || "Falha no Code Intelligence.");
      error.code = message.error.code || "code_intelligence_error";
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  if (message.type === "cancel") {
    const canceled = message.taskId === currentTaskId && cancelCurrent(message.reason || "cancelado");
    send({ type: "cancel_ack", taskId: message.taskId, canceled });
    return;
  }

  if (message.type === "instruction") {
    log("info", "instruction_received", message.message || "Instrucao registrada.", message.data || null, message.taskId || currentTaskId);
    return;
  }

  if (message.type === "shutdown") {
    shuttingDown = true;
    if (!currentTaskId) process.exit(0);
    cancelCurrent("cancelado");
  }
});

process.on("uncaughtException", (error) => {
  send({ type: "fatal", taskId: currentTaskId, error: { message: error.message, stack: error.stack } });
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  send({ type: "fatal", taskId: currentTaskId, error: { message: error?.message || String(error), stack: error?.stack } });
  process.exit(1);
});

send({ type: "ready", pid: process.pid, workerId: process.env.WORKER_ID || null, startedAt: Date.now() });
