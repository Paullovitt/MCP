import fs from "node:fs/promises";
import path from "node:path";
import { TypeScriptWorkspace } from "./typescript-workspace.js";

export class CodeIntelligenceEngine {
  constructor({ logger, maxFiles = 5000 } = {}) {
    this.logger = logger;
    this.maxFiles = maxFiles;
    this.sessions = new Map();
  }

  async session(projectRoot) {
    const normalized = path.resolve(projectRoot);
    const stats = await fs.stat(normalized).catch(() => null);
    if (!stats?.isDirectory()) throw new Error(`Projeto de codigo nao encontrado: ${normalized}`);
    let session = this.sessions.get(normalized);
    if (!session) {
      session = new TypeScriptWorkspace(normalized, { logger: this.logger, maxFiles: this.maxFiles });
      this.sessions.set(normalized, session);
      this.logger?.info("Sessao de Code Intelligence iniciada.", { projectRoot: normalized, provider: "typescript-language-service" });
    }
    return session;
  }

  async query(projectRoot, input) {
    return (await this.session(projectRoot)).query(input);
  }

  async context(projectRoot, input) {
    return (await this.session(projectRoot)).context(input);
  }

  async diagnostics(projectRoot, input) {
    return (await this.session(projectRoot)).diagnostics(input);
  }

  invalidate(projectRoot, paths = []) {
    this.sessions.get(path.resolve(projectRoot))?.invalidate(paths);
  }

  invalidatePaths(paths = []) {
    for (const session of this.sessions.values()) session.invalidate(paths);
  }

  disposeProject(projectRoot) {
    const normalized = path.resolve(projectRoot);
    this.sessions.get(normalized)?.dispose();
    this.sessions.delete(normalized);
  }

  close() {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  getStatus() {
    return {
      provider: "typescript-language-service",
      activeSessions: this.sessions.size,
      projects: [...this.sessions.keys()]
    };
  }
}
