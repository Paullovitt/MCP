import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { LspClient } from "./lsp-client.js";
import {
  compactToBudget,
  discoverFiles,
  fileFingerprint,
  isInside,
  isTestFile,
  relativePath,
  resolveProjectFile,
  unique,
  wordAt
} from "./workspace-utils.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenMarkup(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenMarkup).filter(Boolean).join("\n");
  if (typeof value.value === "string") return value.value;
  if (typeof value.language === "string" && typeof value.value === "string") return value.value;
  return "";
}

function symbolKind(kind) {
  return ({
    1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "property",
    8: "field", 9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable",
    14: "constant", 15: "string", 18: "array", 22: "enumMember", 23: "struct", 26: "typeParameter"
  })[kind] || "symbol";
}

function severity(value) {
  return ({ 1: "error", 2: "warning", 3: "information", 4: "hint" })[value] || "message";
}

function diagnosticKey(uri) {
  try {
    const fileName = path.normalize(fileURLToPath(uri));
    return process.platform === "win32" ? fileName.toLowerCase() : fileName;
  } catch {
    return uri;
  }
}

export class LspWorkspace {
  constructor(projectRoot, {
    provider,
    serverEntry,
    serverArgs = ["--stdio"],
    extensions,
    languageIds,
    initializationOptions,
    settings,
    logger,
    maxFiles = 5000
  }) {
    this.projectRoot = fs.realpathSync(path.resolve(projectRoot));
    this.provider = provider;
    this.serverEntry = serverEntry;
    this.serverArgs = serverArgs;
    this.extensions = extensions;
    this.languageIds = languageIds;
    this.initializationOptions = initializationOptions;
    this.settings = settings || {};
    this.logger = logger;
    this.maxFiles = maxFiles;
    this.fileNames = [];
    this.openFiles = new Map();
    this.publishedDiagnostics = new Map();
    this.client = null;
    this.startPromise = null;
    this.refreshFiles();
  }

  refreshFiles() {
    this.fileNames = discoverFiles(this.projectRoot, this.extensions, { maxFiles: this.maxFiles });
  }

  languageId(fileName) {
    return this.languageIds[path.extname(fileName).toLowerCase()] || this.provider;
  }

  async ensureStarted() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const client = new LspClient({
        command: process.execPath,
        args: [this.serverEntry, ...this.serverArgs],
        cwd: this.projectRoot,
        logger: this.logger,
        name: this.provider
      });
      client.on("textDocument/publishDiagnostics", (params) => {
        // Pyright normaliza a letra da unidade no URI; a chave por caminho evita perder diagnosticos no Windows.
        this.publishedDiagnostics.set(diagnosticKey(params.uri), params.diagnostics || []);
      });
      await client.start({
        processId: process.pid,
        clientInfo: { name: "mcp-worker-coordinator", version: "2.1.0" },
        rootPath: this.projectRoot,
        rootUri: pathToFileURL(this.projectRoot).href,
        workspaceFolders: [{ uri: pathToFileURL(this.projectRoot).href, name: path.basename(this.projectRoot) }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true, symbol: { resolveSupport: { properties: ["location.range"] } } },
          textDocument: {
            synchronization: { didSave: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ["markdown", "plaintext"] },
            completion: { completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"] } },
            callHierarchy: {},
            publishDiagnostics: { relatedInformation: true }
          }
        }
      }, this.initializationOptions);
      if (Object.keys(this.settings).length > 0) client.notify("workspace/didChangeConfiguration", { settings: this.settings });
      this.client = client;
      this.logger?.info("Language Server iniciado.", { projectRoot: this.projectRoot, provider: this.provider });
    })().catch((error) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  resolveFile(inputPath) {
    return resolveProjectFile(this.projectRoot, inputPath);
  }

  relative(fileName) {
    return relativePath(this.projectRoot, fileName);
  }

  async ensureOpen(inputPath) {
    await this.ensureStarted();
    const fileName = this.resolveFile(inputPath);
    const uri = pathToFileURL(fileName).href;
    const fingerprint = fileFingerprint(fileName);
    const current = this.openFiles.get(fileName);
    const content = fs.readFileSync(fileName, "utf8");
    if (!current) {
      this.client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: this.languageId(fileName), version: 1, text: content }
      });
      this.openFiles.set(fileName, { version: 1, fingerprint });
    } else if (current.fingerprint !== fingerprint) {
      const version = current.version + 1;
      this.client.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text: content }] });
      this.openFiles.set(fileName, { version, fingerprint });
    }
    return { fileName, uri, content };
  }

  mapLocation(location) {
    if (!location) return null;
    const uri = location.uri || location.targetUri;
    const range = location.range || location.targetSelectionRange || location.targetRange;
    if (!uri || !range) return null;
    let fileName;
    try {
      fileName = fileURLToPath(uri);
    } catch {
      return null;
    }
    if (!isInside(this.projectRoot, fileName)) return null;
    return {
      file: this.relative(fileName),
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1
    };
  }

  flattenDocumentSymbols(items, fileName, parent = null, output = []) {
    for (const item of items || []) {
      const location = item.location ? this.mapLocation(item.location) : {
        file: this.relative(fileName),
        line: item.selectionRange?.start.line + 1 || 1,
        column: item.selectionRange?.start.character + 1 || 1,
        endLine: item.selectionRange?.end.line + 1 || 1,
        endColumn: item.selectionRange?.end.character + 1 || 1
      };
      output.push({ name: item.name, kind: symbolKind(item.kind), containerName: item.containerName || parent, ...location });
      this.flattenDocumentSymbols(item.children, fileName, item.name, output);
    }
    return output;
  }

  async documentSymbols(fileName) {
    const opened = await this.ensureOpen(fileName);
    const items = await this.client.request("textDocument/documentSymbol", { textDocument: { uri: opened.uri } });
    return this.flattenDocumentSymbols(items, opened.fileName);
  }

  async symbols(input = {}) {
    await this.ensureStarted();
    const query = input.query || input.symbol || "";
    let symbols = [];
    try {
      const items = await this.client.request("workspace/symbol", { query });
      symbols = (items || []).map((item) => ({
        name: item.name,
        kind: symbolKind(item.kind),
        containerName: item.containerName || null,
        ...this.mapLocation(item.location)
      })).filter((item) => item.file);
    } catch {
      // Alguns Language Servers implementam apenas documentSymbol; o fallback abaixo cobre esse caso.
    }
    if (symbols.length === 0 || input.file) {
      this.refreshFiles();
      const files = input.file ? [this.resolveFile(input.file)] : this.fileNames.slice(0, input.maxFiles || 100);
      const nested = await Promise.all(files.map((fileName) => this.documentSymbols(fileName).catch(() => [])));
      symbols = nested.flat().filter((item) => !query || item.name.toLowerCase().includes(query.toLowerCase()));
    }
    symbols.sort((left, right) => Number(right.name === query) - Number(left.name === query) || left.file.localeCompare(right.file));
    const limit = input.maxResults || 50;
    return { provider: this.provider, projectRoot: this.projectRoot, symbols: symbols.slice(0, limit), total: symbols.length, truncated: symbols.length > limit };
  }

  async resolveAnchor(input = {}) {
    if (input.file) {
      const opened = await this.ensureOpen(input.file);
      const position = { line: Math.max(0, (input.line || 1) - 1), character: Math.max(0, (input.column || 1) - 1) };
      const selectedWord = wordAt(opened.content, input.line || 1, input.column || 1).word;
      return { ...opened, position, symbol: input.symbol || selectedWord || null, alternatives: [] };
    }
    if (!input.symbol) throw new Error("Informe symbol ou file/line/column.");
    const result = await this.symbols({ symbol: input.symbol, query: input.symbol, maxResults: 20 });
    if (result.symbols.length === 0) throw new Error(`Simbolo nao encontrado: ${input.symbol}`);
    const selected = result.symbols[0];
    const opened = await this.ensureOpen(selected.file);
    return {
      ...opened,
      position: { line: selected.line - 1, character: selected.column - 1 },
      symbol: selected.name,
      alternatives: result.symbols.slice(1, 10)
    };
  }

  async definition(input) {
    const anchor = await this.resolveAnchor(input);
    const response = await this.client.request("textDocument/definition", {
      textDocument: { uri: anchor.uri }, position: anchor.position
    });
    const raw = Array.isArray(response) ? response : response ? [response] : [];
    const definitions = raw.map((item) => this.mapLocation(item)).filter(Boolean);
    if (definitions.length === 0) definitions.push({
      file: this.relative(anchor.fileName), line: anchor.position.line + 1, column: anchor.position.character + 1,
      endLine: anchor.position.line + 1, endColumn: anchor.position.character + Math.max(1, anchor.symbol?.length || 1) + 1
    });
    const hover = await this.hover({ file: this.relative(anchor.fileName), line: anchor.position.line + 1, column: anchor.position.character + 1, symbol: anchor.symbol });
    return { provider: this.provider, symbol: anchor.symbol, definitions, quickInfo: hover.quickInfo, alternatives: anchor.alternatives };
  }

  async references(input) {
    const anchor = await this.resolveAnchor(input);
    const response = await this.client.request("textDocument/references", {
      textDocument: { uri: anchor.uri }, position: anchor.position, context: { includeDeclaration: true }
    });
    const references = (response || []).map((item) => this.mapLocation(item)).filter(Boolean);
    const limit = input.maxResults || 100;
    return {
      provider: this.provider, symbol: anchor.symbol, references: references.slice(0, limit), totalReferences: references.length,
      truncated: references.length > limit, alternatives: anchor.alternatives
    };
  }

  async hover(input) {
    const anchor = await this.resolveAnchor(input);
    const response = await this.client.request("textDocument/hover", { textDocument: { uri: anchor.uri }, position: anchor.position });
    const text = flattenMarkup(response?.contents);
    return {
      provider: this.provider,
      symbol: anchor.symbol,
      quickInfo: text ? { kind: this.languageId(anchor.fileName), signature: text, documentation: "" } : null,
      alternatives: anchor.alternatives
    };
  }

  async callHierarchy(input) {
    const anchor = await this.resolveAnchor(input);
    let incoming = [];
    let outgoing = [];
    try {
      const prepared = await this.client.request("textDocument/prepareCallHierarchy", { textDocument: { uri: anchor.uri }, position: anchor.position });
      const item = prepared?.[0];
      if (item) {
        incoming = (await this.client.request("callHierarchy/incomingCalls", { item }) || []).map((call) => ({
          name: call.from.name, kind: symbolKind(call.from.kind), ...this.mapLocation({ uri: call.from.uri, range: call.from.selectionRange })
        }));
        outgoing = (await this.client.request("callHierarchy/outgoingCalls", { item }) || []).map((call) => ({
          name: call.to.name, kind: symbolKind(call.to.kind), ...this.mapLocation({ uri: call.to.uri, range: call.to.selectionRange })
        }));
      }
    } catch {
      // Hierarquia de chamadas e opcional no protocolo e em cada linguagem.
    }
    return { provider: this.provider, symbol: anchor.symbol, incoming, outgoing, alternatives: anchor.alternatives };
  }

  extractImports(fileName, content) {
    const imports = [];
    const patterns = this.languageId(fileName) === "python"
      ? [/^\s*import\s+([\w.]+)/gm, /^\s*from\s+([\w.]+)\s+import\s+/gm]
      : [/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gim, /@(?:import|use)\s+(?:url\()?['"]?([^'"\s);]+)/gim];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) imports.push({ specifier: match[1], external: !match[1].startsWith(".") });
    }
    return imports;
  }

  async imports(input) {
    const opened = await this.ensureOpen(input.file);
    const imports = this.extractImports(opened.fileName, opened.content);
    const dependents = [];
    const targetBase = path.basename(opened.fileName, path.extname(opened.fileName));
    for (const candidate of this.fileNames) {
      if (candidate === opened.fileName) continue;
      const candidateContent = fs.readFileSync(candidate, "utf8");
      if (this.extractImports(candidate, candidateContent).some((entry) => entry.specifier.includes(targetBase))) dependents.push(this.relative(candidate));
    }
    return { provider: this.provider, file: this.relative(opened.fileName), imports, dependents };
  }

  async completion(input) {
    const opened = await this.ensureOpen(input.file);
    const response = await this.client.request("textDocument/completion", {
      textDocument: { uri: opened.uri },
      position: { line: input.line - 1, character: input.column - 1 },
      context: { triggerKind: 1 }
    });
    const allEntries = Array.isArray(response) ? response : response?.items || [];
    const limit = input.maxResults || 50;
    const entries = allEntries.slice(0, limit).map((entry) => ({
      name: entry.label,
      kind: symbolKind(entry.kind),
      detail: entry.detail || null,
      documentation: flattenMarkup(entry.documentation),
      insertText: typeof entry.textEdit?.newText === "string" ? entry.textEdit.newText : entry.insertText || entry.label,
      sortText: entry.sortText || null
    }));
    return { provider: this.provider, file: this.relative(opened.fileName), line: input.line, column: input.column, entries, total: allEntries.length, truncated: allEntries.length > limit };
  }

  mapDiagnostic(fileName, diagnostic) {
    return {
      file: this.relative(fileName),
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      endLine: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
      code: diagnostic.code ?? null,
      category: severity(diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source || this.provider
    };
  }

  async diagnostics(input = {}) {
    this.refreshFiles();
    const files = input.file ? [this.resolveFile(input.file)] : this.fileNames.slice(0, input.maxFiles || 100);
    await Promise.all(files.map((fileName) => this.ensureOpen(fileName)));
    // Language Servers publicam diagnosticos por notificacao; aguardar a primeira publicacao evita respostas vazias durante a inicializacao fria.
    const diagnosticsDeadline = Date.now() + (input.settleMs || 1500);
    const diagnosticKeys = files.map((fileName) => diagnosticKey(pathToFileURL(fileName).href));
    while (Date.now() < diagnosticsDeadline && diagnosticKeys.some((key) => !this.publishedDiagnostics.has(key))) await wait(50);
    const diagnostics = [];
    for (const fileName of files) {
      const key = diagnosticKey(pathToFileURL(fileName).href);
      diagnostics.push(...(this.publishedDiagnostics.get(key) || []).map((item) => this.mapDiagnostic(fileName, item)));
    }
    const limit = input.maxResults || 200;
    return {
      provider: this.provider, projectRoot: this.projectRoot, analyzedFiles: files.length,
      diagnostics: diagnostics.slice(0, limit), totalDiagnostics: diagnostics.length, truncated: diagnostics.length > limit
    };
  }

  excerpt(fileName, line, maxChars = 5000) {
    const content = fs.readFileSync(fileName, "utf8");
    const lines = content.split(/\r?\n/);
    const startIndex = Math.max(0, line - 8);
    const selected = lines.slice(startIndex, Math.min(lines.length, line + 24)).join("\n");
    return { file: this.relative(fileName), startLine: startIndex + 1, content: selected.slice(0, maxChars), truncated: selected.length > maxChars };
  }

  async context(input) {
    const anchor = await this.resolveAnchor(input);
    const locationInput = { file: this.relative(anchor.fileName), line: anchor.position.line + 1, column: anchor.position.character + 1, symbol: anchor.symbol };
    const [definition, references, calls, imports, diagnostics, symbols] = await Promise.all([
      this.definition(locationInput),
      this.references({ ...locationInput, maxResults: input.maxReferences || 100 }),
      this.callHierarchy(locationInput),
      this.imports({ file: locationInput.file }),
      this.diagnostics({ file: locationInput.file, maxResults: input.maxDiagnostics || 50 }),
      this.symbols({ file: locationInput.file, maxResults: 30 })
    ]);
    const relatedTests = unique([
      ...references.references.filter((reference) => isTestFile(reference.file)).map((reference) => reference.file),
      ...this.fileNames.filter((fileName) => isTestFile(fileName) && path.basename(fileName).toLowerCase().includes(path.basename(anchor.fileName, path.extname(anchor.fileName)).toLowerCase())).map((fileName) => this.relative(fileName))
    ]).slice(0, input.maxRelatedTests || 30);
    return compactToBudget({
      provider: this.provider,
      projectRoot: this.projectRoot,
      symbol: anchor.symbol,
      definition: definition.definitions[0] || null,
      signature: definition.quickInfo?.signature || null,
      documentation: definition.quickInfo?.documentation || "",
      alternatives: anchor.alternatives,
      excerpt: this.excerpt(anchor.fileName, anchor.position.line + 1, Math.min(8000, input.maxExcerptChars || 5000)),
      references: references.references,
      totalReferences: references.totalReferences,
      incomingCalls: calls.incoming,
      outgoingCalls: calls.outgoing,
      imports: imports.imports,
      dependentFiles: imports.dependents,
      relatedSymbols: symbols.symbols.filter((item) => item.name !== anchor.symbol).slice(0, 20),
      relatedTests,
      diagnostics: diagnostics.diagnostics,
      truncated: references.truncated,
      project: { sourceFiles: this.fileNames.length }
    }, input.maxChars || 20_000);
  }

  async query(input) {
    switch (input.action) {
      case "symbols": return this.symbols(input);
      case "definition": return this.definition(input);
      case "references": return this.references(input);
      case "hover": return this.hover(input);
      case "callHierarchy": return this.callHierarchy(input);
      case "imports": return this.imports(input);
      case "completion": return this.completion(input);
      default: throw new Error(`Acao de code_query nao suportada por ${this.provider}: ${input.action}`);
    }
  }

  invalidate(paths = []) {
    for (const inputPath of paths) {
      const fileName = path.resolve(inputPath);
      if (isInside(this.projectRoot, fileName)) this.openFiles.delete(fileName);
    }
    this.refreshFiles();
  }

  async dispose() {
    await this.client?.dispose();
    this.openFiles.clear();
    this.publishedDiagnostics.clear();
  }

  getStatus() {
    return { provider: this.provider, active: Boolean(this.client), files: this.fileNames.length };
  }
}
