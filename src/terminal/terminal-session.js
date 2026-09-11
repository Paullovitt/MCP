import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { OutputBuffer } from "./output-buffer.js";
import { terminateProcessTree } from "./process-tree.js";

export class TerminalSession {
  constructor({ sessionId, executable, args, cwd, env, cols, rows, idleTimeoutMs, bufferBytes, onLifecycle }) {
    Object.assign(this, { sessionId, shell: executable, cwd, cols, rows, idleTimeoutMs, onLifecycle });
    this.status = "starting";
    this.createdAt = this.lastActivityAt = Date.now();
    this.endedAt = this.exitCode = this.pid = this.signal = this.closeReason = this.errorCode = null;
    this.buffer = new OutputBuffer(bufferBytes);
    this.pendingInputBytes = 0;
    const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MCP_|^NODE_OPTIONS$|^NODE_PATH$/i.test(key)));
    this.host = fork(fileURLToPath(new URL("./pty-host.js", import.meta.url)), [], {
      windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
      // Env customizado pertence a CLI, nao ao Node auxiliar que hospeda o addon.
      env: hostEnv, detached: process.platform !== "win32"
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.startTimer = setTimeout(() => {
      this.errorCode = "PTY_START_TIMEOUT";
      this.rejectReady(new Error("Terminal nao iniciou em 10 segundos."));
      this.close("start_timeout").catch(() => {});
    }, 10_000);
    this.host.on("message", (message) => {
      if (message.type === "ready") {
        this.pid = message.pid;
        clearTimeout(this.startTimer);
        if (this.status === "starting") {
          this.status = "running";
          this.onLifecycle("started", this);
          this.resolveReady(this.snapshot());
        }
      } else if (message.type === "data") {
        this.buffer.append(message.data);
        this.lastActivityAt = Date.now();
      } else if (message.type === "exit") {
        this.exitCode = message.exitCode;
        this.signal = message.signal ?? null;
      } else if (message.type === "failure") {
        this.errorCode = message.code;
        this.rejectReady(Object.assign(new Error(message.code === "PTY_UNAVAILABLE"
          ? "node-pty indisponivel. Execute npm install --include=optional e verifique o suporte nativo."
          : "Falha ao iniciar/operar a PTY; verifique o executavel e seus argumentos."), { code: message.code }));
      }
    });
    this.host.once("error", () => {
      this.errorCode = "PTY_HOST_ERROR";
      this.finish();
    });
    this.host.once("exit", (code) => {
      if (this.exitCode === null && !this.closeReason && !this.errorCode) this.errorCode = "PTY_HOST_CRASH";
      this.finish(code);
    });
    this.host.send({ type: "start", executable, args, cwd, env, cols, rows }, (error) => {
      if (error) { this.errorCode = "PTY_IPC_ERROR"; this.close("ipc_error").catch(() => {}); }
    });
  }

  finish() {
    if (this.endedAt !== null) return;
    clearTimeout(this.startTimer);
    this.endedAt = Date.now();
    this.status = this.errorCode ? "error" : this.closeReason ? "closed" : "exited";
    this.rejectReady(new Error("Terminal encerrou antes de ficar pronto."));
    this.onLifecycle(this.status, this);
  }

  snapshot() {
    return {
      sessionId: this.sessionId, pid: this.pid, shell: this.shell, cwd: this.cwd, cwdIsInitial: true,
      backend: "pty", stream: "combined", status: this.status, cols: this.cols, rows: this.rows,
      createdAt: new Date(this.createdAt).toISOString(), lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      endedAt: this.endedAt === null ? null : new Date(this.endedAt).toISOString(),
      exitCode: this.exitCode, signal: this.signal, closeReason: this.closeReason, errorCode: this.errorCode,
      idleTimeoutMs: this.idleTimeoutMs, bufferBytes: this.buffer.size,
      bufferLimitBytes: this.buffer.capacity, startOffset: this.buffer.startOffset, endOffset: this.buffer.endOffset
    };
  }

  assertRunning() {
    if (this.status !== "running" || !this.host.connected) throw Object.assign(new Error("Sessao nao esta em execucao."), { code: "SESSION_NOT_RUNNING" });
  }

  async send(data, newline = true) {
    this.assertRunning();
    const text = data + (newline ? "\r" : "");
    const bytes = Buffer.byteLength(text);
    if (bytes > 65_536 || this.pendingInputBytes + bytes > 262_144) throw new Error("Limite de entrada do terminal excedido.");
    this.pendingInputBytes += bytes;
    try {
      await new Promise((resolve, reject) => this.host.send({ type: "write", data: text }, (error) => error ? reject(new Error("Falha no IPC do terminal.")) : resolve()));
      this.lastActivityAt = Date.now();
      return { sessionId: this.sessionId, acceptedBytes: bytes, status: this.status };
    } finally {
      this.pendingInputBytes -= bytes;
    }
  }

  read({ afterOffset = 0, maxBytes = 65_536, stripAnsi = false } = {}) {
    const result = this.buffer.read(afterOffset, maxBytes);
    // ANSI e mantido no anel. A opcao de visualizacao nunca altera os offsets UTF-8.
    if (stripAnsi) result.output = stripVTControlCharacters(result.output);
    return { sessionId: this.sessionId, status: this.status, stream: "combined", ...result };
  }

  async resize(cols, rows) {
    this.assertRunning();
    await new Promise((resolve, reject) => this.host.send({ type: "resize", cols, rows }, (error) => error ? reject(new Error("Falha ao redimensionar terminal.")) : resolve()));
    this.cols = cols;
    this.rows = rows;
    this.lastActivityAt = Date.now();
    return this.snapshot();
  }

  close(reason = "requested") {
    if (this.closing) return this.closing;
    if (this.endedAt !== null) return Promise.resolve(this.snapshot());
    this.closeReason = reason;
    this.status = "closing";
    clearTimeout(this.startTimer);
    this.rejectReady(new Error("Terminal encerrado durante a inicializacao."));
    this.closing = terminateProcessTree(this.host, 300, {
      onForce: () => this.onLifecycle("forced_termination", this)
    }).then(() => {
      this.finish();
      return this.snapshot();
    }).catch((error) => {
      this.closing = null; // Permite nova tentativa se o sistema operacional negar o encerramento.
      throw error;
    });
    return this.closing;
  }
}
