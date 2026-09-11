import { spawn } from "node:child_process";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { resolveInsideProject } from "./path-utils.js";
import { MAX_SHELL_TIMEOUT_MS } from "../timeouts.js";
import { StringDecoder } from "node:string_decoder";
import { OutputBuffer } from "../terminal/output-buffer.js";
import { terminateProcessTree } from "../terminal/process-tree.js";

// Dois buffers fixos preservam as saidas recentes sem acumular logs ilimitados no servidor.
export const SHELL_OUTPUT_LIMIT_BYTES = 524_288;
const activeCommands = new Set();

export async function stopShellCommands() {
  // O bootstrap bloqueia novas requisicoes antes de cancelar os comandos ja aceitos.
  await Promise.all([...activeCommands].map((entry) => entry.stop("shutdown")));
}

function getShellCommand(command) {
  if (os.platform() === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
    };
  }

  return {
    executable: "/bin/sh",
    args: ["-lc", command]
  };
}

export async function runShellCommand(input, { projectRoot }) {
  const cwd = resolveInsideProject(projectRoot, input.cwd || ".");
  // A chamada interna segue o mesmo padrao maximo anunciado pela tool MCP.
  const timeoutMs = input.timeoutMs ?? MAX_SHELL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SHELL_TIMEOUT_MS) {
    throw new Error("Prazo de shell invalido: use de 1 a 600000 ms.");
  }
  const startedAt = performance.now();
  const shellCommand = getShellCommand(input.command);

  return new Promise((resolve) => {
    const child = spawn(shellCommand.executable, shellCommand.args, {
      cwd,
      windowsHide: true,
      detached: os.platform() !== "win32"
    });

    const stdout = new OutputBuffer(SHELL_OUTPUT_LIMIT_BYTES);
    const stderr = new OutputBuffer(SHELL_OUTPUT_LIMIT_BYTES);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let timedOut = false;
    let canceled = false;
    let finished = false;
    let termination = null;
    let errorCode = null;
    let exitCode = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      activeCommands.delete(entry);
      stdout.append(stdoutDecoder.end());
      stderr.append(stderrDecoder.end());
      resolve({
        stdout: stdout.read(0, SHELL_OUTPUT_LIMIT_BYTES).output,
        stderr: stderr.read(0, SHELL_OUTPUT_LIMIT_BYTES).output,
        exitCode, timedOut, canceled, durationMs: Math.round(performance.now() - startedAt),
        stdoutTruncated: stdout.startOffset > 0, stderrTruncated: stderr.startOffset > 0,
        stdoutBytes, stderrBytes, outputLimitBytes: SHELL_OUTPUT_LIMIT_BYTES,
        ...(errorCode ? { errorCode } : {})
      });
    };
    const stop = (reason) => {
      if (finished) return Promise.resolve();
      if (termination) return termination;
      timedOut = reason === "timeout";
      canceled = reason === "shutdown";
      clearTimeout(timer);
      termination = terminateProcessTree(child, 300, { kind: "command" }).catch(() => {
        // Nao declara encerramento bem-sucedido quando o SO recusa matar a arvore.
        errorCode = "process_tree_close_failed";
        stderr.append("\nNao foi possivel confirmar o encerramento da arvore de processos.");
      }).finally(() => {
        // Descendentes destacados podem reter pipes; nao prendem a resposta indefinidamente.
        child.stdout.destroy();
        child.stderr.destroy();
        finish();
      });
      return termination;
    };
    const entry = { stop };
    activeCommands.add(entry);
    const timer = setTimeout(() => { void stop("timeout"); }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      stdout.append(stdoutDecoder.write(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderr.append(stderrDecoder.write(chunk));
    });

    child.on("error", (error) => {
      stderr.append(error.message);
      exitCode = 1;
      errorCode = "shell_start_failed";
      if (!termination) finish();
    });

    child.on("close", (code) => {
      exitCode = errorCode === "shell_start_failed" ? 1 : code;
      if (!termination) finish();
    });
  });
}
