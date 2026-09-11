import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolvePath } from "../tools/path-utils.js";
import { TerminalSession } from "./terminal-session.js";

export const TERMINAL_DEFAULTS = {
  TERMINAL_MAX_SESSIONS: 8,
  TERMINAL_BUFFER_BYTES: 1_048_576,
  TERMINAL_READ_MAX_BYTES: 65_536,
  TERMINAL_IDLE_TIMEOUT_MS: 0,
  TERMINAL_RETENTION_MS: 600_000
};

const dimension = z.number().int().min(2).max(500);
const idleTimeout = z.number().int().min(0).max(2_147_483_647);
export const terminalConfigSchema = z.object({
  TERMINAL_MAX_SESSIONS: z.number().int().min(1).max(32),
  TERMINAL_BUFFER_BYTES: z.number().int().min(4096).max(16_777_216),
  TERMINAL_READ_MAX_BYTES: z.number().int().min(4).max(262_144),
  TERMINAL_IDLE_TIMEOUT_MS: idleTimeout,
  TERMINAL_RETENTION_MS: z.number().int().min(0).max(86_400_000)
});
export const terminalStartSchema = z.object({
  shell: z.string().min(1).max(4096).refine((value) => !value.includes("\0")).default("powershell"),
  cwd: z.string().min(1).max(32768).default("."),
  args: z.array(z.string().max(8192).refine((value) => !value.includes("\0"))).max(128).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16384).refine((value) => !value.includes("\0"))).optional(),
  cols: dimension.default(120), rows: dimension.default(30), idleTimeoutMs: idleTimeout.optional()
});
export const terminalSessionId = z.string().regex(/^term_[0-9a-f-]{36}$/);
export const terminalSendSchema = z.object({
  sessionId: terminalSessionId, data: z.string().max(65_536), newline: z.boolean().default(true)
});
export const terminalReadSchema = z.object({
  sessionId: terminalSessionId, afterOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  maxBytes: z.number().int().min(4).max(262_144).optional(), stripAnsi: z.boolean().default(false)
});
export const terminalResizeSchema = z.object({ sessionId: terminalSessionId, cols: dimension, rows: dimension });

function profile(shell) {
  if (shell === "node") return { executable: process.execPath, args: ["-i"] };
  if (shell === "python") return { executable: process.platform === "win32" ? "python.exe" : "python3", args: ["-i", "-q"] };
  if (shell === "powershell") return { executable: process.platform === "win32" ? "powershell.exe" : "pwsh", args: ["-NoLogo", "-NoProfile"] };
  return { executable: shell, args: [] };
}

function terminalEnvironment(overrides = {}) {
  if (Object.keys(overrides).length > 128 || Buffer.byteLength(JSON.stringify(overrides)) > 65_536) {
    throw new Error("Limite de variaveis de ambiente excedido.");
  }
  const env = {};
  // Nao herda segredos MCP. No Windows os nomes sao insensiveis a maiusculas.
  for (const [key, value] of Object.entries({ ...process.env, PYTHON_BASIC_REPL: "1" })) {
    if (!/^MCP_/i.test(key) && value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (/^MCP_/i.test(key)) throw new Error("Variaveis MCP_* nao podem ser encaminhadas ao terminal.");
    if (process.platform === "win32") {
      for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}

export class TerminalSessionManager {
  constructor({ projectRoot = process.cwd(), logger, config = {} } = {}) {
    this.projectRoot = projectRoot;
    this.logger = logger;
    this.config = terminalConfigSchema.parse({ ...TERMINAL_DEFAULTS, ...config });
    this.sessions = new Map();
    this.stopping = false;
    this.timer = null;
  }

  async start(input = {}) {
    if (this.stopping) throw new Error("Gerenciador de terminais esta encerrando.");
    const parsed = terminalStartSchema.parse(input);
    this.prune();
    if ([...this.sessions.values()].filter((session) => session.endedAt === null).length >= this.config.TERMINAL_MAX_SESSIONS) {
      throw new Error("Limite de sessoes simultaneas atingido. Feche um terminal antes de abrir outro.");
    }
    const cwd = resolvePath(this.projectRoot, parsed.cwd);
    if (!fs.statSync(cwd).isDirectory()) throw new Error("cwd deve apontar para um diretorio existente.");
    const selected = profile(parsed.shell);
    const env = terminalEnvironment(parsed.env);
    const session = new TerminalSession({
      ...selected, args: parsed.args ?? selected.args, cwd, env, cols: parsed.cols, rows: parsed.rows,
      sessionId: `term_${randomUUID()}`, idleTimeoutMs: parsed.idleTimeoutMs ?? this.config.TERMINAL_IDLE_TIMEOUT_MS,
      bufferBytes: this.config.TERMINAL_BUFFER_BYTES,
      onLifecycle: (event, value) => {
        // Sem stdin, stdout, args, env ou caminho: metadados bastam para diagnosticar o ciclo de vida.
        this.logger?.info?.("Terminal persistente.", {
          event, sessionId: value.sessionId, pid: value.pid, reason: value.closeReason, errorCode: value.errorCode
        });
      }
    });
    // Reserva a vaga antes do primeiro await, incluindo sessoes que ainda estao iniciando.
    this.sessions.set(session.sessionId, session);
    if (!this.timer) {
      this.timer = setInterval(() => this.maintain(), 500);
      this.timer.unref();
    }
    try {
      return await session.ready;
    } catch (error) {
      await session.close("start_error");
      throw error;
    }
  }

  get(sessionId) {
    terminalSessionId.parse(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Sessao de terminal inexistente ou expirada.");
    return session;
  }

  send(input) {
    const { sessionId, data, newline } = terminalSendSchema.parse(input);
    return this.get(sessionId).send(data, newline);
  }

  read(input) {
    const parsed = terminalReadSchema.parse(input);
    const maxBytes = parsed.maxBytes ?? this.config.TERMINAL_READ_MAX_BYTES;
    if (maxBytes > this.config.TERMINAL_READ_MAX_BYTES) throw new Error("maxBytes excede o limite de leitura configurado.");
    return this.get(parsed.sessionId).read({ ...parsed, maxBytes });
  }

  status(sessionId) { return this.get(sessionId).snapshot(); }
  list() { this.prune(); return [...this.sessions.values()].map((session) => session.snapshot()); }
  close(sessionId) { return this.get(sessionId).close(); }
  resize(input) {
    const { sessionId, cols, rows } = terminalResizeSchema.parse(input);
    return this.get(sessionId).resize(cols, rows);
  }

  prune() {
    const closed = [...this.sessions.values()].filter((session) => session.endedAt !== null).sort((a, b) => a.endedAt - b.endedAt);
    for (let index = 0; index < closed.length; index++) {
      const session = closed[index];
      if (Date.now() - session.endedAt >= this.config.TERMINAL_RETENTION_MS || index < closed.length - this.config.TERMINAL_MAX_SESSIONS) {
        this.sessions.delete(session.sessionId);
      }
    }
  }

  maintain() {
    this.prune();
    for (const session of this.sessions.values()) {
      // Consultar status/saida nao prolonga a vida de um terminal ocioso.
      if (session.status === "running" && session.idleTimeoutMs > 0 && Date.now() - session.lastActivityAt >= session.idleTimeoutMs) {
        session.close("idle_timeout").catch(() => this.logger?.error?.("Falha ao encerrar terminal ocioso.", { sessionId: session.sessionId }));
      }
    }
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    const results = await Promise.allSettled([...this.sessions.values()].map((session) => session.close("shutdown")));
    if (results.some((result) => result.status === "rejected")) throw new Error("Uma arvore de terminal nao encerrou; tente novamente.");
    this.sessions.clear();
  }
}
