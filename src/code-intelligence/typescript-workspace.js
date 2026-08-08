import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/out/**"
];

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function displayParts(parts) {
  return ts.displayPartsToString(parts || []);
}

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/");
}

function isTestFile(fileName) {
  const normalized = normalizeSlashes(fileName);
  return /(^|\/)(__tests__|tests?|specs?)\//i.test(normalized) || /[._](test|spec)\.[cm]?[jt]sx?$/i.test(normalized);
}

function diagnosticCategory(category) {
  return ({
    [ts.DiagnosticCategory.Warning]: "warning",
    [ts.DiagnosticCategory.Error]: "error",
    [ts.DiagnosticCategory.Suggestion]: "suggestion",
    [ts.DiagnosticCategory.Message]: "message"
  })[category] || "message";
}

export class TypeScriptWorkspace {
  constructor(projectRoot, { maxFiles = 5000, logger } = {}) {
    this.projectRoot = fs.realpathSync(path.resolve(projectRoot));
    this.maxFiles = maxFiles;
    this.logger = logger;
    this.fileNames = [];
    this.versions = new Map();
    this.fingerprints = new Map();
    this.projectVersion = 0;
    this.configPath = null;
    this.configFingerprint = null;
    this.configDiagnostics = [];
    this.lastRefreshAt = 0;
    this.compilerOptions = this.defaultCompilerOptions();
    this.loadProject();
    this.createService();
  }

  defaultCompilerOptions() {
    return {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      skipLibCheck: true,
      allowSyntheticDefaultImports: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.ReactJSX
    };
  }

  resolveFile(inputPath) {
    if (!inputPath) throw new Error("Informe o arquivo para esta consulta de codigo.");
    const resolved = path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(this.projectRoot, inputPath);
    if (!isInside(this.projectRoot, resolved)) throw new Error(`Arquivo fora do projeto: ${resolved}`);
    const realPath = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    if (!isInside(this.projectRoot, realPath)) throw new Error(`Arquivo aponta para fora do projeto: ${resolved}`);
    return realPath;
  }

  relative(fileName) {
    return normalizeSlashes(path.relative(this.projectRoot, fileName));
  }

  findConfigPath() {
    return ts.findConfigFile(this.projectRoot, ts.sys.fileExists, "tsconfig.json")
      || ts.findConfigFile(this.projectRoot, ts.sys.fileExists, "jsconfig.json")
      || null;
  }

  fileFingerprint(fileName) {
    try {
      const stats = fs.statSync(fileName, { bigint: true });
      return `${stats.mtimeNs}:${stats.size}`;
    } catch {
      return "missing";
    }
  }

  discoverFiles() {
    const configPath = this.findConfigPath();
    this.configPath = configPath;
    this.configDiagnostics = [];
    if (configPath) {
      const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
      if (loaded.error) this.configDiagnostics.push(loaded.error);
      const parsed = ts.parseJsonConfigFileContent(loaded.config || {}, ts.sys, path.dirname(configPath));
      this.configDiagnostics.push(...parsed.errors);
      this.compilerOptions = { ...parsed.options, noEmit: true };
      return parsed.fileNames;
    }

    this.compilerOptions = this.defaultCompilerOptions();
    return ts.sys.readDirectory(this.projectRoot, SOURCE_EXTENSIONS, DEFAULT_EXCLUDES, ["**/*"]);
  }

  loadProject() {
    const previousFileList = this.fileNames.join("\n");
    const discovered = unique(this.discoverFiles().map((fileName) => path.resolve(fileName)))
      .filter((fileName) => isInside(this.projectRoot, fileName))
      .filter((fileName) => !DEFAULT_EXCLUDES.some((pattern) => {
        const segment = pattern.replaceAll("**/", "").replaceAll("/**", "");
        return normalizeSlashes(fileName).includes(`/${segment}/`);
      }))
      .sort();
    if (discovered.length > this.maxFiles) {
      throw new Error(`Projeto excede o limite de ${this.maxFiles} arquivos analisaveis.`);
    }
    this.fileNames = discovered;
    let changed = previousFileList !== discovered.join("\n");
    const nextFingerprints = new Map();
    for (const fileName of discovered) {
      const fingerprint = this.fileFingerprint(fileName);
      nextFingerprints.set(fileName, fingerprint);
      if (this.fingerprints.get(fileName) !== fingerprint) {
        this.versions.set(fileName, (this.versions.get(fileName) || 0) + 1);
        changed = true;
      }
    }
    for (const oldFile of this.fingerprints.keys()) {
      if (!nextFingerprints.has(oldFile)) {
        this.versions.set(oldFile, (this.versions.get(oldFile) || 0) + 1);
        changed = true;
      }
    }
    this.fingerprints = nextFingerprints;
    this.configFingerprint = this.configPath ? this.fileFingerprint(this.configPath) : null;
    if (changed || this.projectVersion === 0) this.projectVersion += 1;
    return changed;
  }

  createService() {
    const host = {
      getScriptFileNames: () => this.fileNames,
      getScriptVersion: (fileName) => String(this.versions.get(path.resolve(fileName)) || 0),
      getScriptSnapshot: (fileName) => {
        if (!ts.sys.fileExists(fileName)) return undefined;
        return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) || "");
      },
      getCurrentDirectory: () => this.projectRoot,
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      getProjectVersion: () => String(this.projectVersion),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  refresh() {
    const timestamp = Date.now();
    if (timestamp - this.lastRefreshAt < 100) return;
    this.lastRefreshAt = timestamp;
    const nextConfig = this.findConfigPath();
    const nextConfigFingerprint = nextConfig ? this.fileFingerprint(nextConfig) : null;
    const configChanged = nextConfig !== this.configPath || nextConfigFingerprint !== this.configFingerprint;
    const previousFiles = this.fileNames.join("\n");
    this.loadProject();
    if (configChanged || previousFiles !== this.fileNames.join("\n")) {
      this.service.dispose();
      this.createService();
    }
  }

  invalidate(paths = []) {
    for (const inputPath of paths) {
      const fileName = path.resolve(inputPath);
      if (!isInside(this.projectRoot, fileName)) continue;
      this.versions.set(fileName, (this.versions.get(fileName) || 0) + 1);
      this.fingerprints.delete(fileName);
    }
    this.projectVersion += 1;
    this.lastRefreshAt = 0;
  }

  sourceFile(fileName) {
    return this.service.getProgram()?.getSourceFile(fileName) || null;
  }

  position(fileName, line = 1, column = 1) {
    const source = this.sourceFile(fileName);
    if (!source) throw new Error(`Arquivo nao pertence ao projeto de codigo: ${fileName}`);
    const lineIndex = Math.max(0, Math.min(source.getLineAndCharacterOfPosition(source.getEnd()).line, Number(line) - 1));
    const lineStart = source.getPositionOfLineAndCharacter(lineIndex, 0);
    const nextLineStart = lineIndex + 1 < source.getLineAndCharacterOfPosition(source.getEnd()).line + 1
      ? source.getPositionOfLineAndCharacter(lineIndex + 1, 0)
      : source.getEnd();
    return Math.min(nextLineStart, lineStart + Math.max(0, Number(column) - 1));
  }

  location(fileName, textSpan = { start: 0, length: 0 }) {
    const source = this.sourceFile(fileName);
    if (!source) return { file: this.relative(fileName), line: 1, column: 1, endLine: 1, endColumn: 1 };
    const start = source.getLineAndCharacterOfPosition(Math.min(textSpan.start, source.getEnd()));
    const end = source.getLineAndCharacterOfPosition(Math.min(textSpan.start + textSpan.length, source.getEnd()));
    return {
      file: this.relative(fileName),
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1
    };
  }

  navigateItems(query, { file, limit = 50 } = {}) {
    this.refresh();
    const fileName = file ? this.resolveFile(file) : undefined;
    return this.service.getNavigateToItems(query || "", limit, fileName, true, true).map((item) => {
      const source = this.sourceFile(item.fileName);
      const spanText = source?.text.slice(item.textSpan.start, item.textSpan.start + item.textSpan.length) || "";
      const nameOffset = spanText.indexOf(item.name);
      const nameSpan = nameOffset >= 0
        ? { start: item.textSpan.start + nameOffset, length: item.name.length }
        : item.textSpan;
      return {
        name: item.name,
        kind: item.kind,
        modifiers: item.kindModifiers || "",
        containerName: item.containerName || null,
        matchKind: item.matchKind,
        ...this.location(item.fileName, nameSpan),
        _fileName: item.fileName,
        _position: nameSpan.start
      };
    });
  }

  resolveAnchor({ symbol, file, line, column } = {}) {
    this.refresh();
    if (file && line) {
      const fileName = this.resolveFile(file);
      const position = this.position(fileName, line, column || 1);
      const quick = this.service.getQuickInfoAtPosition(fileName, position);
      return {
        selected: { name: symbol || displayParts(quick?.displayParts) || null, ...this.location(fileName, quick?.textSpan || { start: position, length: 0 }), _fileName: fileName, _position: position },
        candidates: []
      };
    }
    if (!symbol) throw new Error("Informe symbol ou file/line/column.");
    const candidates = this.navigateItems(symbol, { file, limit: 30 })
      .sort((left, right) => Number(right.name === symbol) - Number(left.name === symbol) || left.file.localeCompare(right.file));
    if (candidates.length === 0) throw new Error(`Simbolo nao encontrado: ${symbol}`);
    return { selected: candidates[0], candidates: candidates.slice(1, 10).map(({ _fileName, _position, ...item }) => item) };
  }

  quickInfo(anchor) {
    const info = this.service.getQuickInfoAtPosition(anchor._fileName, anchor._position);
    if (!info) return null;
    return {
      kind: info.kind,
      modifiers: info.kindModifiers || "",
      signature: displayParts(info.displayParts),
      documentation: displayParts(info.documentation),
      tags: (info.tags || []).map((tag) => ({ name: tag.name, text: displayParts(tag.text) }))
    };
  }

  symbols(input) {
    return {
      provider: "typescript-language-service",
      projectRoot: this.projectRoot,
      symbols: this.navigateItems(input.query || input.symbol || "", { file: input.file, limit: input.maxResults || 50 })
        .map(({ _fileName, _position, ...item }) => item)
    };
  }

  definition(input) {
    const resolved = this.resolveAnchor(input);
    const definitions = this.service.getDefinitionAtPosition(resolved.selected._fileName, resolved.selected._position) || [];
    const locations = definitions.length > 0
      ? definitions.map((definition) => ({ name: definition.name, kind: definition.kind, ...this.location(definition.fileName, definition.textSpan) }))
      : [{ name: resolved.selected.name, kind: resolved.selected.kind, ...this.location(resolved.selected._fileName, { start: resolved.selected._position, length: resolved.selected.name?.length || 0 }) }];
    return { provider: "typescript-language-service", symbol: resolved.selected.name, definitions: locations, quickInfo: this.quickInfo(resolved.selected), alternatives: resolved.candidates };
  }

  references(input) {
    const resolved = this.resolveAnchor(input);
    const groups = this.service.findReferences(resolved.selected._fileName, resolved.selected._position) || [];
    const references = [];
    for (const group of groups) {
      for (const reference of group.references) {
        references.push({
          ...this.location(reference.fileName, reference.textSpan),
          isDefinition: reference.isDefinition === true,
          isWriteAccess: reference.isWriteAccess === true
        });
      }
    }
    return {
      provider: "typescript-language-service",
      symbol: resolved.selected.name,
      references: references.slice(0, input.maxResults || 100),
      totalReferences: references.length,
      truncated: references.length > (input.maxResults || 100),
      alternatives: resolved.candidates
    };
  }

  hover(input) {
    const resolved = this.resolveAnchor(input);
    return { provider: "typescript-language-service", symbol: resolved.selected.name, quickInfo: this.quickInfo(resolved.selected), alternatives: resolved.candidates };
  }

  callHierarchy(input) {
    const resolved = this.resolveAnchor(input);
    let incoming = [];
    let outgoing = [];
    try {
      incoming = (this.service.provideCallHierarchyIncomingCalls(resolved.selected._fileName, resolved.selected._position) || []).map((call) => ({
        name: call.from.name,
        kind: call.from.kind,
        ...this.location(call.from.file, call.from.span),
        callSites: call.fromSpans.map((span) => this.location(resolved.selected._fileName, span))
      }));
      outgoing = (this.service.provideCallHierarchyOutgoingCalls(resolved.selected._fileName, resolved.selected._position) || []).map((call) => ({
        name: call.to.name,
        kind: call.to.kind,
        ...this.location(call.to.file, call.to.span),
        callSites: call.fromSpans.map((span) => this.location(resolved.selected._fileName, span))
      }));
    } catch {
      // Nem todo tipo de simbolo participa de uma hierarquia de chamadas.
    }
    return { provider: "typescript-language-service", symbol: resolved.selected.name, incoming, outgoing, alternatives: resolved.candidates };
  }

  importsForFile(fileName) {
    const source = this.sourceFile(fileName);
    if (!source) return [];
    const imports = [];
    const addImport = (specifier, node) => {
      const resolved = ts.resolveModuleName(specifier, fileName, this.compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
      imports.push({
        specifier,
        resolvedFile: resolved && isInside(this.projectRoot, resolved) ? this.relative(resolved) : null,
        external: !resolved || !isInside(this.projectRoot, resolved),
        ...this.location(fileName, { start: node.getStart(source), length: node.getWidth(source) })
      });
    };
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addImport(node.moduleSpecifier.text, node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (isRequire || isDynamicImport) addImport(node.arguments[0].text, node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return imports;
  }

  imports(input) {
    this.refresh();
    const fileName = this.resolveFile(input.file);
    const imports = this.importsForFile(fileName);
    const dependents = [];
    for (const candidate of this.fileNames) {
      if (candidate === fileName) continue;
      if (this.importsForFile(candidate).some((entry) => entry.resolvedFile === this.relative(fileName))) {
        dependents.push(this.relative(candidate));
      }
    }
    return { provider: "typescript-language-service", file: this.relative(fileName), imports, dependents };
  }

  completion(input) {
    this.refresh();
    const fileName = this.resolveFile(input.file);
    const position = this.position(fileName, input.line, input.column);
    const completion = this.service.getCompletionsAtPosition(fileName, position, {
      includeCompletionsForModuleExports: true,
      includeInsertTextCompletions: true
    });
    const entries = (completion?.entries || []).slice(0, input.maxResults || 50).map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      sortText: entry.sortText,
      source: entry.source || null,
      insertText: entry.insertText || entry.name
    }));
    return { provider: "typescript-language-service", file: this.relative(fileName), line: input.line, column: input.column, entries, total: completion?.entries?.length || 0, truncated: (completion?.entries?.length || 0) > entries.length };
  }

  mapDiagnostic(diagnostic) {
    const location = diagnostic.file && Number.isInteger(diagnostic.start)
      ? this.location(diagnostic.file.fileName, { start: diagnostic.start, length: diagnostic.length || 0 })
      : { file: null, line: null, column: null, endLine: null, endColumn: null };
    return {
      ...location,
      code: diagnostic.code,
      category: diagnosticCategory(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      source: diagnostic.source || "typescript"
    };
  }

  diagnostics(input = {}) {
    this.refresh();
    const requestedFiles = input.file ? [this.resolveFile(input.file)] : this.fileNames.slice(0, input.maxFiles || 100);
    const diagnostics = [...this.configDiagnostics];
    for (const fileName of requestedFiles) {
      diagnostics.push(...this.service.getSyntacticDiagnostics(fileName));
      diagnostics.push(...this.service.getSemanticDiagnostics(fileName));
      if (input.includeSuggestions !== false) diagnostics.push(...this.service.getSuggestionDiagnostics(fileName));
    }
    const mapped = diagnostics.map((diagnostic) => this.mapDiagnostic(diagnostic));
    const limit = input.maxResults || 200;
    return {
      provider: "typescript-language-service",
      projectRoot: this.projectRoot,
      analyzedFiles: requestedFiles.length,
      diagnostics: mapped.slice(0, limit),
      totalDiagnostics: mapped.length,
      truncated: mapped.length > limit
    };
  }

  excerpt(anchor, maxChars = 5000) {
    const source = this.sourceFile(anchor._fileName);
    if (!source) return null;
    let node = ts.getTokenAtPosition(source, anchor._position);
    while (node.parent && !ts.isFunctionLike(node) && !ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node) && !ts.isVariableStatement(node)) {
      node = node.parent;
    }
    const start = node.getStart(source);
    const end = Math.min(node.getEnd(), start + maxChars);
    const line = source.getLineAndCharacterOfPosition(start).line + 1;
    return { file: this.relative(anchor._fileName), startLine: line, truncated: end < node.getEnd(), content: source.text.slice(start, end) };
  }

  relatedSymbols(fileName, selectedName, limit = 20) {
    const tree = this.service.getNavigationTree(fileName);
    const results = [];
    const visit = (item) => {
      if (item.text !== selectedName && item.text !== "<global>") {
        results.push({ name: item.text, kind: item.kind, ...this.location(fileName, item.spans?.[0] || { start: 0, length: 0 }) });
      }
      for (const child of item.childItems || []) visit(child);
    };
    visit(tree);
    return results.slice(0, limit);
  }

  context(input) {
    const resolved = this.resolveAnchor(input);
    const definition = this.definition({ file: this.relative(resolved.selected._fileName), line: resolved.selected.line, column: resolved.selected.column, symbol: resolved.selected.name });
    const references = this.references({ file: this.relative(resolved.selected._fileName), line: resolved.selected.line, column: resolved.selected.column, symbol: resolved.selected.name, maxResults: input.maxReferences || 100 });
    const calls = this.callHierarchy({ file: this.relative(resolved.selected._fileName), line: resolved.selected.line, column: resolved.selected.column, symbol: resolved.selected.name });
    const imports = this.imports({ file: this.relative(resolved.selected._fileName) });
    const relatedTests = unique([
      ...references.references.filter((reference) => isTestFile(reference.file)).map((reference) => reference.file),
      ...imports.dependents.filter(isTestFile),
      ...this.fileNames.filter((fileName) => isTestFile(fileName) && path.basename(fileName).toLowerCase().includes(path.basename(resolved.selected._fileName, path.extname(resolved.selected._fileName)).toLowerCase())).map((fileName) => this.relative(fileName))
    ]).slice(0, input.maxRelatedTests || 30);
    const diagnostics = this.diagnostics({ file: this.relative(resolved.selected._fileName), maxResults: input.maxDiagnostics || 50 });
    const result = {
      provider: "typescript-language-service",
      projectRoot: this.projectRoot,
      symbol: resolved.selected.name,
      definition: definition.definitions[0] || null,
      signature: definition.quickInfo?.signature || null,
      documentation: definition.quickInfo?.documentation || "",
      alternatives: resolved.candidates,
      excerpt: this.excerpt(resolved.selected, Math.min(8000, input.maxExcerptChars || 5000)),
      references: references.references,
      totalReferences: references.totalReferences,
      incomingCalls: calls.incoming,
      outgoingCalls: calls.outgoing,
      imports: imports.imports,
      dependentFiles: imports.dependents,
      relatedSymbols: this.relatedSymbols(resolved.selected._fileName, resolved.selected.name),
      relatedTests,
      diagnostics: diagnostics.diagnostics,
      truncated: references.truncated,
      project: { configFile: this.configPath ? this.relative(this.configPath) : null, sourceFiles: this.fileNames.length, version: this.projectVersion }
    };
    return this.compactToBudget(result, input.maxChars || 20_000);
  }

  compactToBudget(result, maxChars) {
    const arrays = ["references", "incomingCalls", "outgoingCalls", "imports", "dependentFiles", "relatedSymbols", "relatedTests", "diagnostics"];
    while (JSON.stringify(result).length > maxChars) {
      const candidate = arrays.map((key) => ({ key, length: result[key]?.length || 0 })).sort((left, right) => right.length - left.length)[0];
      if (!candidate || candidate.length <= 1) break;
      result[candidate.key] = result[candidate.key].slice(0, Math.ceil(candidate.length / 2));
      result.truncated = true;
    }
    if (JSON.stringify(result).length > maxChars && result.excerpt?.content) {
      result.excerpt.content = result.excerpt.content.slice(0, Math.max(200, Math.floor(maxChars / 4)));
      result.excerpt.truncated = true;
      result.truncated = true;
    }
    result.responseChars = JSON.stringify(result).length;
    return result;
  }

  query(input) {
    switch (input.action) {
      case "symbols": return this.symbols(input);
      case "definition": return this.definition(input);
      case "references": return this.references(input);
      case "hover": return this.hover(input);
      case "callHierarchy": return this.callHierarchy(input);
      case "imports":
        if (!input.file) throw new Error("A acao imports exige file.");
        return this.imports(input);
      case "completion":
        if (!input.file || !input.line || !input.column) throw new Error("A acao completion exige file, line e column.");
        return this.completion(input);
      default: throw new Error(`Acao de code_query nao suportada: ${input.action}`);
    }
  }

  dispose() {
    this.service.dispose();
  }
}
