import { spawn } from "node:child_process";

function rpcError(message) {
  const error = new Error(message?.message || "Language Server retornou um erro.");
  error.code = message?.code || "lsp_error";
  error.details = message?.data || null;
  return error;
}

export class LspClient {
  constructor({ command, args = [], cwd, logger, name, requestTimeoutMs = 15_000 }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.logger = logger;
    this.name = name;
    this.requestTimeoutMs = requestTimeoutMs;
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = new Map();
    this.started = false;
    this.disposed = false;
  }

  on(method, listener) {
    const listeners = this.notifications.get(method) || new Set();
    listeners.add(listener);
    this.notifications.set(method, listeners);
    return () => listeners.delete(listener);
  }

  async start(initializeParams, initializationOptions = undefined) {
    if (this.started) return;
    if (this.disposed) throw new Error(`Language Server ${this.name} ja foi encerrado.`);
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.process.stdin.on("error", (error) => {
      if (!this.disposed) this.failPending(error);
    });
    this.process.stdout.on("data", (chunk) => this.consume(chunk));
    this.process.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.logger?.warn(`Language Server ${this.name}: ${message}`);
    });
    this.process.on("error", (error) => this.failPending(error));
    this.process.on("exit", (code, signal) => {
      if (!this.disposed) this.failPending(new Error(`Language Server ${this.name} encerrou (codigo ${code}, sinal ${signal || "nenhum"}).`));
      this.process = null;
      this.started = false;
    });
    const result = await this.request("initialize", { ...initializeParams, initializationOptions });
    this.started = true;
    this.notify("initialized", {});
    return result;
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const contentLength = Number(lengthMatch[1]);
      const messageEnd = headerEnd + 4 + contentLength;
      if (this.buffer.length < messageEnd) return;
      const payload = this.buffer.subarray(headerEnd + 4, messageEnd).toString("utf8");
      this.buffer = this.buffer.subarray(messageEnd);
      try {
        this.handleMessage(JSON.parse(payload));
      } catch (error) {
        this.logger?.warn(`Resposta invalida do Language Server ${this.name}.`, { error: error.message });
      }
    }
  }

  handleMessage(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(rpcError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    for (const listener of this.notifications.get(message.method) || []) listener(message.params);
  }

  handleServerRequest(message) {
    let result = null;
    if (message.method === "workspace/configuration") result = (message.params?.items || []).map(() => ({}));
    else if (message.method === "workspace/workspaceFolders") result = null;
    this.send({ jsonrpc: "2.0", id: message.id, result });
  }

  send(message) {
    if (!this.process?.stdin?.writable) throw new Error(`Language Server ${this.name} nao esta disponivel.`);
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    this.process.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.process.stdin.write(payload);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Language Server ${this.name} excedeu ${timeoutMs} ms em ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.process) return;
    const processHandle = this.process;
    const exited = new Promise((resolve) => processHandle.once("exit", resolve));
    try {
      await this.request("shutdown", {}, 1000);
      this.notify("exit", {});
    } catch {
      // O processo pode ja ter encerrado por conta propria.
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
    if (processHandle.exitCode === null) processHandle.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    this.failPending(new Error(`Language Server ${this.name} encerrado.`));
  }
}
