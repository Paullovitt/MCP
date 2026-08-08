import path from "node:path";
import { createRequire } from "node:module";
import { TypeScriptWorkspace } from "./typescript-workspace.js";
import { LspWorkspace } from "./lsp-workspace.js";
import { StructuralWorkspace } from "./structural-workspace.js";
import { ProjectWorkspace } from "./project-workspace.js";

const require = createRequire(import.meta.url);
const PROJECT_ACTIONS = new Set(["project", "dependencies", "installation", "files", "relatedFiles", "languageCapabilities"]);

export class MultiLanguageWorkspace {
  constructor(projectRoot, { logger, maxFiles = 5000 } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.logger = logger;
    this.providers = {
      typescript: new TypeScriptWorkspace(this.projectRoot, { logger, maxFiles }),
      python: new LspWorkspace(this.projectRoot, {
        provider: "pyright-language-server",
        serverEntry: require.resolve("pyright/langserver.index.js"),
        extensions: [".py", ".pyi"],
        languageIds: { ".py": "python", ".pyi": "python" },
        settings: { python: { analysis: { autoSearchPaths: true, diagnosticMode: "workspace", typeCheckingMode: "basic" } } },
        logger,
        maxFiles
      }),
      html: new LspWorkspace(this.projectRoot, {
        provider: "vscode-html-language-server",
        serverEntry: require.resolve("vscode-langservers-extracted/bin/vscode-html-language-server"),
        extensions: [".html", ".htm"],
        languageIds: { ".html": "html", ".htm": "html" },
        initializationOptions: { provideFormatter: false, embeddedLanguages: { css: true, javascript: true } },
        logger,
        maxFiles
      }),
      css: new LspWorkspace(this.projectRoot, {
        provider: "vscode-css-language-server",
        serverEntry: require.resolve("vscode-langservers-extracted/bin/vscode-css-language-server"),
        extensions: [".css", ".scss", ".less"],
        languageIds: { ".css": "css", ".scss": "scss", ".less": "less" },
        initializationOptions: { provideFormatter: false },
        logger,
        maxFiles
      }),
      csharp: new StructuralWorkspace(this.projectRoot, { mode: "csharp", logger, maxFiles }),
      sql: new StructuralWorkspace(this.projectRoot, { mode: "sql", logger, maxFiles })
    };
    this.project = new ProjectWorkspace(this.projectRoot, { maxFiles, capabilityProvider: () => this.getCapabilities() });
  }

  providerForFile(fileName) {
    const extension = path.extname(fileName || "").toLowerCase();
    if ([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return this.providers.typescript;
    if ([".py", ".pyi"].includes(extension)) return this.providers.python;
    if ([".html", ".htm"].includes(extension)) return this.providers.html;
    if ([".css", ".scss", ".less"].includes(extension)) return this.providers.css;
    if (extension === ".cs") return this.providers.csharp;
    if (extension === ".sql") return this.providers.sql;
    return null;
  }

  searchableProviders() {
    return Object.values(this.providers).filter((provider) => provider.fileNames?.length > 0);
  }

  async searchAcrossProviders(input) {
    const query = input.query || input.symbol || "";
    const results = await Promise.all(this.searchableProviders().map(async (provider) => {
      try {
        const response = await provider.query({ ...input, action: "symbols", query, maxResults: input.maxResults || 50 });
        return response.symbols || [];
      } catch (error) {
        this.logger?.warn("Provider ignorado durante busca multilíngue.", { provider: provider.provider || "typescript-language-service", error: error.message });
        return [];
      }
    }));
    return results.flat().sort((left, right) => Number(right.name === query) - Number(left.name === query) || left.file.localeCompare(right.file));
  }

  async resolveProvider(input) {
    if (input.file) {
      const provider = this.providerForFile(input.file);
      if (!provider) throw new Error(`Linguagem ainda nao suportada para Code Intelligence: ${path.extname(input.file) || input.file}`);
      return { provider, input };
    }
    if (!input.symbol && !input.query) throw new Error("Informe symbol, query ou file.");
    const matches = await this.searchAcrossProviders({ ...input, maxResults: 20 });
    if (matches.length === 0) throw new Error(`Simbolo nao encontrado: ${input.symbol || input.query}`);
    const selected = matches[0];
    const provider = this.providerForFile(selected.file);
    return {
      provider,
      input: {
        ...input,
        file: selected.file,
        line: input.line || selected.line,
        column: input.column || selected.column,
        symbol: input.symbol || selected.name
      },
      alternatives: matches.slice(1, 10)
    };
  }

  async query(input) {
    if (PROJECT_ACTIONS.has(input.action)) return this.project.query(input);
    if (input.action === "symbols" && !input.file) {
      const symbols = await this.searchAcrossProviders(input);
      const limit = input.maxResults || 50;
      return {
        provider: "multi-language-code-intelligence",
        projectRoot: this.projectRoot,
        symbols: symbols.slice(0, limit),
        total: symbols.length,
        truncated: symbols.length > limit
      };
    }
    const resolved = await this.resolveProvider(input);
    const result = await resolved.provider.query(resolved.input);
    if (resolved.alternatives?.length && !result.alternatives?.length) result.alternatives = resolved.alternatives;
    return result;
  }

  async context(input) {
    if (input.action && PROJECT_ACTIONS.has(input.action)) return this.project.query(input);
    const resolved = await this.resolveProvider(input);
    const result = await resolved.provider.context(resolved.input);
    if (resolved.alternatives?.length && !result.alternatives?.length) result.alternatives = resolved.alternatives;
    return result;
  }

  async diagnostics(input = {}) {
    if (input.file) {
      const provider = this.providerForFile(input.file);
      if (!provider) throw new Error(`Linguagem ainda nao suportada para diagnosticos: ${path.extname(input.file) || input.file}`);
      return provider.diagnostics(input);
    }
    const results = await Promise.all(this.searchableProviders().map(async (provider) => {
      try {
        return await provider.diagnostics(input);
      } catch (error) {
        return { provider: provider.provider || "typescript-language-service", analyzedFiles: 0, diagnostics: [], totalDiagnostics: 0, error: error.message };
      }
    }));
    const diagnostics = results.flatMap((result) => result.diagnostics || []);
    const limit = input.maxResults || 200;
    return {
      provider: "multi-language-code-intelligence",
      projectRoot: this.projectRoot,
      analyzedFiles: results.reduce((total, result) => total + (result.analyzedFiles || 0), 0),
      diagnostics: diagnostics.slice(0, limit),
      totalDiagnostics: diagnostics.length,
      truncated: diagnostics.length > limit,
      providers: results.map((result) => ({ provider: result.provider, analyzedFiles: result.analyzedFiles, diagnostics: result.totalDiagnostics, error: result.error || null }))
    };
  }

  invalidate(paths = []) {
    for (const provider of Object.values(this.providers)) provider.invalidate(paths);
    this.project.invalidate(paths);
  }

  getCapabilities() {
    return [
      { language: "javascript/typescript", extensions: ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"], provider: "typescript-language-service", semanticLevel: "full", active: true },
      { language: "python", extensions: ["py", "pyi"], provider: "pyright-language-server", semanticLevel: "full", active: Boolean(this.providers.python.client) },
      { language: "html", extensions: ["html", "htm"], provider: "vscode-html-language-server", semanticLevel: "language-server", active: Boolean(this.providers.html.client) },
      { language: "css", extensions: ["css", "scss", "less"], provider: "vscode-css-language-server", semanticLevel: "language-server", active: Boolean(this.providers.css.client) },
      { language: "sql", extensions: ["sql"], provider: "sql-structural-parser", semanticLevel: "parser/dialect", active: true },
      { language: "csharp", extensions: ["cs"], provider: "csharp-structural-fallback", semanticLevel: "structural", active: true, limitation: "Roslyn nao esta integrado nesta versao; um futuro adapter tambem exigira SDK .NET, ausente neste computador." },
      { language: "project/dependencies", extensions: [], provider: "project-intelligence", semanticLevel: "manifests/files/installations", active: true }
    ];
  }

  getStatus() {
    return {
      provider: "multi-language-code-intelligence",
      projectRoot: this.projectRoot,
      capabilities: this.getCapabilities(),
      providers: Object.fromEntries(Object.entries(this.providers).map(([name, provider]) => [name, provider.getStatus?.() || {
        provider: "typescript-language-service", active: true, files: provider.fileNames?.length || 0
      }]))
    };
  }

  async dispose() {
    await Promise.all(Object.values(this.providers).map((provider) => provider.dispose()));
    this.project.dispose();
  }
}
