import fs from "node:fs";
import path from "node:path";
import sqlParserPackage from "node-sql-parser";
import {
  compactToBudget,
  discoverFiles,
  isInside,
  isTestFile,
  locationFromOffset,
  offsetAt,
  relativePath,
  resolveProjectFile,
  unique,
  wordAt
} from "./workspace-utils.js";

const { Parser } = sqlParserPackage;
const CSHARP_KEYWORDS = [
  "class", "interface", "record", "struct", "enum", "namespace", "using", "public", "private", "protected",
  "internal", "static", "async", "await", "return", "new", "var", "string", "int", "bool", "decimal", "void"
];
const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "GROUP BY", "ORDER BY", "HAVING",
  "INSERT INTO", "UPDATE", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "VALUES", "AS", "ON", "LIMIT"
];

function cleanIdentifier(value) {
  return String(value || "").replace(/^[`"\[]|[`"\]]$/g, "");
}

function matchesWord(content, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "g");
}

export class StructuralWorkspace {
  constructor(projectRoot, { mode, logger, maxFiles = 5000 } = {}) {
    this.projectRoot = fs.realpathSync(path.resolve(projectRoot));
    this.mode = mode;
    this.provider = mode === "csharp" ? "csharp-structural-fallback" : "sql-structural-parser";
    this.extensions = mode === "csharp" ? [".cs"] : [".sql"];
    this.logger = logger;
    this.maxFiles = maxFiles;
    this.parser = mode === "sql" ? new Parser() : null;
    this.fileNames = [];
    this.symbolCache = new Map();
    this.refresh();
  }

  refresh() {
    this.fileNames = discoverFiles(this.projectRoot, this.extensions, { maxFiles: this.maxFiles });
    this.symbolCache.clear();
  }

  resolveFile(fileName) {
    return resolveProjectFile(this.projectRoot, fileName);
  }

  relative(fileName) {
    return relativePath(this.projectRoot, fileName);
  }

  scanCSharp(fileName, content) {
    const symbols = [];
    let currentContainer = null;
    const add = (name, kind, start, signature, containerName = currentContainer) => {
      symbols.push({ name, kind, containerName, signature: signature.trim(), ...locationFromOffset(this.projectRoot, fileName, content, start, name.length), _fileName: fileName, _offset: start });
    };
    const declarations = [
      { kind: "namespace", pattern: /^\s*(?:file\s+)?namespace\s+([A-Za-z_][\w.]*)/gm },
      { kind: "type", pattern: /^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|ref)\s+)*(class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/gm }
    ];
    for (const definition of declarations) {
      for (const match of content.matchAll(definition.pattern)) {
        const name = definition.kind === "type" ? match[2] : match[1];
        const kind = definition.kind === "type" ? match[1] : definition.kind;
        const start = match.index + match[0].lastIndexOf(name);
        add(name, kind, start, match[0], definition.kind === "type" ? currentContainer : null);
        if (definition.kind === "type") currentContainer = name;
      }
    }
    const methodPattern = /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|new|partial)\s+)*(?:[A-Za-z_][\w<>,.?\[\]\s]*\s+)([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*(?:=>|\{|;)/gm;
    const excluded = new Set(["if", "for", "foreach", "while", "switch", "catch", "using", "lock"]);
    for (const match of content.matchAll(methodPattern)) {
      if (excluded.has(match[1])) continue;
      const start = match.index + match[0].indexOf(match[1]);
      add(match[1], "method", start, match[0]);
    }
    const propertyPattern = /^\s*(?:(?:public|private|protected|internal|static|virtual|override|required|init|readonly)\s+)+[A-Za-z_][\w<>,.?\[\]]*\s+([A-Za-z_]\w*)\s*\{\s*(?:get|set|init)\b/gm;
    for (const match of content.matchAll(propertyPattern)) {
      const start = match.index + match[0].indexOf(match[1]);
      add(match[1], "property", start, match[0]);
    }
    const fieldPattern = /^\s*(?:(?:public|private|protected|internal|static|const|readonly|volatile)\s+)+[A-Za-z_][\w<>,.?\[\]]*\s+([A-Za-z_]\w*)\s*(?:=|;)/gm;
    for (const match of content.matchAll(fieldPattern)) {
      const start = match.index + match[0].indexOf(match[1]);
      add(match[1], match[0].includes(" const ") ? "constant" : "field", start, match[0]);
    }
    // Associar cada membro ao tipo declarado imediatamente antes dele melhora completion de variaveis sem exigir Roslyn.
    const typeSymbols = symbols.filter((item) => ["class", "interface", "record", "struct", "enum"].includes(item.kind)).sort((left, right) => left._offset - right._offset);
    for (const symbol of symbols.filter((item) => ["method", "property", "field", "constant"].includes(item.kind))) {
      symbol.containerName = typeSymbols.filter((item) => item._offset < symbol._offset).at(-1)?.name || null;
    }
    return symbols;
  }

  scanSql(fileName, content) {
    const symbols = [];
    const add = (name, kind, start, signature, containerName = null) => {
      symbols.push({ name, kind, containerName, signature: signature.trim(), ...locationFromOffset(this.projectRoot, fileName, content, start, name.length), _fileName: fileName, _offset: start });
    };
    const objectPattern = /CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW|FUNCTION|PROCEDURE|TRIGGER|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[]?[A-Za-z_][\w.$]*[`"\]]?)/gim;
    for (const match of content.matchAll(objectPattern)) {
      const name = cleanIdentifier(match[2]);
      const start = match.index + match[0].lastIndexOf(match[2]);
      add(name, match[1].toLowerCase(), start, match[0]);
      if (match[1].toUpperCase() !== "TABLE") continue;
      const opening = content.indexOf("(", match.index + match[0].length);
      if (opening < 0) continue;
      let depth = 1;
      let closing = opening + 1;
      while (closing < content.length && depth > 0) {
        if (content[closing] === "(") depth += 1;
        else if (content[closing] === ")") depth -= 1;
        closing += 1;
      }
      const body = content.slice(opening + 1, Math.max(opening + 1, closing - 1));
      const columnPattern = /(?:^|,)\s*([`"\[]?[A-Za-z_]\w*[`"\]]?)\s+([A-Za-z][\w]*(?:\s*\([^)]*\))?)/gm;
      for (const column of body.matchAll(columnPattern)) {
        const columnName = cleanIdentifier(column[1]);
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(columnName)) continue;
        const columnStart = opening + 1 + column.index + column[0].indexOf(column[1]);
        add(columnName, "column", columnStart, column[0], name);
      }
    }
    return symbols;
  }

  scanFile(fileName) {
    const cached = this.symbolCache.get(fileName);
    const content = fs.readFileSync(fileName, "utf8");
    const fingerprint = `${content.length}:${fs.statSync(fileName).mtimeMs}`;
    if (cached?.fingerprint === fingerprint) return cached;
    const symbols = this.mode === "csharp" ? this.scanCSharp(fileName, content) : this.scanSql(fileName, content);
    const value = { content, symbols, fingerprint };
    this.symbolCache.set(fileName, value);
    return value;
  }

  allSymbols() {
    return this.fileNames.flatMap((fileName) => this.scanFile(fileName).symbols);
  }

  publicSymbol(symbol) {
    const { _fileName, _offset, signature, ...result } = symbol;
    return { ...result, signature };
  }

  symbols(input = {}) {
    const query = (input.query || input.symbol || "").toLowerCase();
    const files = input.file ? [this.resolveFile(input.file)] : this.fileNames;
    const matches = files.flatMap((fileName) => this.scanFile(fileName).symbols)
      .filter((item) => !query || item.name.toLowerCase().includes(query))
      .sort((left, right) => Number(right.name.toLowerCase() === query) - Number(left.name.toLowerCase() === query) || left.file.localeCompare(right.file));
    const limit = input.maxResults || 50;
    return { provider: this.provider, projectRoot: this.projectRoot, symbols: matches.slice(0, limit).map((item) => this.publicSymbol(item)), total: matches.length, truncated: matches.length > limit };
  }

  resolveAnchor(input = {}) {
    if (input.file) {
      const fileName = this.resolveFile(input.file);
      const { content, symbols } = this.scanFile(fileName);
      const selectedWord = input.symbol || wordAt(content, input.line || 1, input.column || 1).word;
      const exact = symbols.find((item) => item.name === selectedWord);
      if (exact) return { selected: exact, alternatives: symbols.filter((item) => item !== exact).slice(0, 9).map((item) => this.publicSymbol(item)) };
      const position = offsetAt(content, input.line || 1, input.column || 1);
      return {
        selected: { name: selectedWord, kind: "symbol", signature: null, ...locationFromOffset(this.projectRoot, fileName, content, position, selectedWord?.length || 0), _fileName: fileName, _offset: position },
        alternatives: []
      };
    }
    if (!input.symbol) throw new Error("Informe symbol ou file/line/column.");
    const matches = this.allSymbols().filter((item) => item.name.toLowerCase().includes(input.symbol.toLowerCase()))
      .sort((left, right) => Number(right.name === input.symbol) - Number(left.name === input.symbol));
    if (matches.length === 0) throw new Error(`Simbolo nao encontrado: ${input.symbol}`);
    return { selected: matches[0], alternatives: matches.slice(1, 10).map((item) => this.publicSymbol(item)) };
  }

  definition(input) {
    const anchor = this.resolveAnchor(input);
    const definitions = this.allSymbols().filter((item) => item.name === anchor.selected.name).map((item) => this.publicSymbol(item));
    return {
      provider: this.provider,
      symbol: anchor.selected.name,
      definitions: definitions.length ? definitions : [this.publicSymbol(anchor.selected)],
      quickInfo: { kind: anchor.selected.kind, signature: anchor.selected.signature, documentation: "" },
      alternatives: anchor.alternatives
    };
  }

  references(input) {
    const anchor = this.resolveAnchor(input);
    if (!anchor.selected.name) throw new Error("Nao foi possivel identificar o simbolo na posicao informada.");
    const references = [];
    for (const fileName of this.fileNames) {
      const { content, symbols } = this.scanFile(fileName);
      const definitions = new Set(symbols.filter((item) => item.name === anchor.selected.name).map((item) => item._offset));
      for (const match of content.matchAll(matchesWord(content, anchor.selected.name))) {
        references.push({ ...locationFromOffset(this.projectRoot, fileName, content, match.index, anchor.selected.name.length), isDefinition: definitions.has(match.index), isWriteAccess: false });
      }
    }
    const limit = input.maxResults || 100;
    return {
      provider: this.provider, symbol: anchor.selected.name, references: references.slice(0, limit), totalReferences: references.length,
      truncated: references.length > limit, alternatives: anchor.alternatives
    };
  }

  hover(input) {
    const definition = this.definition(input);
    return { provider: this.provider, symbol: definition.symbol, quickInfo: definition.quickInfo, alternatives: definition.alternatives };
  }

  callHierarchy(input) {
    const anchor = this.resolveAnchor(input);
    if (anchor.selected.kind !== "method" && !["function", "procedure"].includes(anchor.selected.kind)) {
      return { provider: this.provider, symbol: anchor.selected.name, incoming: [], outgoing: [], alternatives: anchor.alternatives };
    }
    const references = this.references({ symbol: anchor.selected.name, maxResults: 1000 }).references;
    const incoming = references.filter((item) => !item.isDefinition).map((item) => ({ name: anchor.selected.name, kind: "call", ...item }));
    const source = this.scanFile(anchor.selected._fileName).content;
    const excerpt = this.extractDeclaration(anchor.selected, 8000).content;
    const outgoingNames = unique([...excerpt.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1]))
      .filter((name) => name !== anchor.selected.name);
    const outgoing = this.allSymbols().filter((item) => outgoingNames.includes(item.name)).slice(0, 50).map((item) => this.publicSymbol(item));
    return { provider: this.provider, symbol: anchor.selected.name, incoming, outgoing, alternatives: anchor.alternatives, sourceFile: this.relative(anchor.selected._fileName), sourceChars: source.length };
  }

  importsForFile(fileName) {
    const content = this.scanFile(fileName).content;
    const imports = [];
    const pattern = this.mode === "csharp"
      ? /^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm
      : /\b(?:FROM|JOIN|REFERENCES|UPDATE|INTO)\s+([`"\[]?[A-Za-z_][\w.$]*[`"\]]?)/gim;
    for (const match of content.matchAll(pattern)) imports.push({ specifier: cleanIdentifier(match[1]), external: this.mode === "csharp", ...locationFromOffset(this.projectRoot, fileName, content, match.index, match[0].length) });
    return imports;
  }

  imports(input) {
    const fileName = this.resolveFile(input.file);
    const imports = this.importsForFile(fileName);
    const targetNames = new Set(this.scanFile(fileName).symbols.map((item) => item.name));
    const dependents = this.fileNames.filter((candidate) => candidate !== fileName && this.importsForFile(candidate).some((entry) => targetNames.has(entry.specifier) || [...targetNames].some((name) => entry.specifier.endsWith(`.${name}`)))).map((candidate) => this.relative(candidate));
    return { provider: this.provider, file: this.relative(fileName), imports, dependents };
  }

  completion(input) {
    const fileName = this.resolveFile(input.file);
    const { content } = this.scanFile(fileName);
    const position = offsetAt(content, input.line, input.column);
    const before = content.slice(0, position);
    const entries = [];
    if (this.mode === "csharp") {
      const memberMatch = before.match(/([A-Za-z_]\w*)\.\s*[A-Za-z_\w]*$/);
      if (memberMatch) {
        const variable = memberMatch[1];
        const declaration = new RegExp(`\\b([A-Za-z_]\\w*(?:<[^;=]+>)?)\\s+${variable}\\b`).exec(content);
        let typeName = declaration?.[1]?.replace(/<.*>/, "");
        if (typeName === "var") {
          // Inferencia deterministica do caso C# mais comum: `var nome = new Tipo(...)`.
          typeName = new RegExp(`\\bvar\\s+${variable}\\s*=\\s*new\\s+([A-Za-z_]\\w*)`).exec(content)?.[1] || typeName;
        }
        entries.push(...this.allSymbols().filter((item) => item.containerName === typeName && ["method", "property", "field"].includes(item.kind)));
      }
      if (entries.length === 0) entries.push(...this.allSymbols(), ...CSHARP_KEYWORDS.map((name) => ({ name, kind: "keyword", signature: name })));
    } else {
      entries.push(...this.allSymbols(), ...SQL_KEYWORDS.map((name) => ({ name, kind: "keyword", signature: name })));
    }
    const prefix = before.match(/[A-Za-z_]\w*$/)?.[0]?.toLowerCase() || "";
    const deduplicated = [...new Map(entries.filter((item) => !prefix || item.name.toLowerCase().startsWith(prefix)).map((item) => [item.name, item])).values()];
    const limit = input.maxResults || 50;
    return {
      provider: this.provider, file: this.relative(fileName), line: input.line, column: input.column,
      entries: deduplicated.slice(0, limit).map((item) => ({ name: item.name, kind: item.kind, detail: item.signature || null, insertText: item.name })),
      total: deduplicated.length, truncated: deduplicated.length > limit
    };
  }

  csharpDiagnostics(fileName, content) {
    const diagnostics = [];
    let braces = 0;
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] === "{") braces += 1;
      if (content[index] === "}") braces -= 1;
      if (braces < 0) {
        diagnostics.push({ ...locationFromOffset(this.projectRoot, fileName, content, index, 1), code: "CS_STRUCT_BRACE", category: "error", message: "Chave de fechamento sem abertura correspondente.", source: this.provider });
        braces = 0;
      }
    }
    if (braces > 0) diagnostics.push({ ...locationFromOffset(this.projectRoot, fileName, content, content.length, 0), code: "CS_STRUCT_BRACE", category: "error", message: `${braces} chave(s) de abertura sem fechamento.`, source: this.provider });
    return diagnostics;
  }

  sqlDiagnostics(fileName, content, dialect) {
    const dialectNames = { sqlite: "SQLite", postgresql: "Postgresql", mysql: "MySQL", transactsql: "TransactSQL" };
    const candidates = dialect && dialect !== "auto" ? [dialectNames[dialect] || dialect] : ["SQLite", "Postgresql", "MySQL", "TransactSQL"];
    const errors = [];
    for (const database of candidates) {
      try {
        this.parser.astify(content, { database });
        return [];
      } catch (error) {
        errors.push({ database, error });
      }
    }
    const selected = errors[0];
    const line = Number(selected.error.location?.start?.line) || 1;
    const column = Number(selected.error.location?.start?.column) || 1;
    return [{
      file: this.relative(fileName), line, column, endLine: line, endColumn: column + 1,
      code: "SQL_PARSE", category: "error", message: selected.error.message, source: `${this.provider}:${selected.database}`
    }];
  }

  diagnostics(input = {}) {
    const files = input.file ? [this.resolveFile(input.file)] : this.fileNames.slice(0, input.maxFiles || 100);
    const diagnostics = files.flatMap((fileName) => {
      const content = this.scanFile(fileName).content;
      return this.mode === "csharp" ? this.csharpDiagnostics(fileName, content) : this.sqlDiagnostics(fileName, content, input.dialect);
    });
    const limit = input.maxResults || 200;
    return { provider: this.provider, projectRoot: this.projectRoot, analyzedFiles: files.length, diagnostics: diagnostics.slice(0, limit), totalDiagnostics: diagnostics.length, truncated: diagnostics.length > limit };
  }

  extractDeclaration(symbol, maxChars = 5000) {
    const content = this.scanFile(symbol._fileName).content;
    const lines = content.split(/\r?\n/);
    const startIndex = Math.max(0, symbol.line - 4);
    const selected = lines.slice(startIndex, Math.min(lines.length, symbol.line + 30)).join("\n");
    return { file: this.relative(symbol._fileName), startLine: startIndex + 1, content: selected.slice(0, maxChars), truncated: selected.length > maxChars };
  }

  context(input) {
    const anchor = this.resolveAnchor(input);
    const locationInput = { file: this.relative(anchor.selected._fileName), line: anchor.selected.line, column: anchor.selected.column, symbol: anchor.selected.name };
    const definition = this.definition(locationInput);
    const references = this.references({ ...locationInput, maxResults: input.maxReferences || 100 });
    const calls = this.callHierarchy(locationInput);
    const imports = this.imports({ file: locationInput.file });
    const diagnostics = this.diagnostics({ file: locationInput.file, maxResults: input.maxDiagnostics || 50, dialect: input.dialect });
    const fileSymbols = this.scanFile(anchor.selected._fileName).symbols;
    const relatedTests = unique([
      ...references.references.filter((reference) => isTestFile(reference.file)).map((reference) => reference.file),
      ...this.fileNames.filter((fileName) => isTestFile(fileName) && path.basename(fileName).toLowerCase().includes(path.basename(anchor.selected._fileName, path.extname(anchor.selected._fileName)).toLowerCase())).map((fileName) => this.relative(fileName))
    ]).slice(0, input.maxRelatedTests || 30);
    return compactToBudget({
      provider: this.provider,
      projectRoot: this.projectRoot,
      language: this.mode,
      symbol: anchor.selected.name,
      definition: definition.definitions[0] || null,
      signature: definition.quickInfo?.signature || null,
      documentation: "",
      alternatives: anchor.alternatives,
      excerpt: this.extractDeclaration(anchor.selected, Math.min(8000, input.maxExcerptChars || 5000)),
      references: references.references,
      totalReferences: references.totalReferences,
      incomingCalls: calls.incoming,
      outgoingCalls: calls.outgoing,
      imports: imports.imports,
      dependentFiles: imports.dependents,
      relatedSymbols: fileSymbols.filter((item) => item.name !== anchor.selected.name).slice(0, 20).map((item) => this.publicSymbol(item)),
      relatedTests,
      diagnostics: diagnostics.diagnostics,
      truncated: references.truncated,
      capabilities: this.mode === "csharp"
        ? { semanticLevel: "structural", roslynActive: false, reason: "SDK .NET/Roslyn nao disponivel; simbolos, referencias, membros e estrutura continuam ativos." }
        : { semanticLevel: "parser", dialect: input.dialect || "auto" },
      project: { sourceFiles: this.fileNames.length }
    }, input.maxChars || 20_000);
  }

  query(input) {
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
      if (isInside(this.projectRoot, fileName)) this.symbolCache.delete(fileName);
    }
    this.refresh();
  }

  dispose() {
    this.symbolCache.clear();
  }

  getStatus() {
    return { provider: this.provider, active: true, files: this.fileNames.length, semanticLevel: this.mode === "csharp" ? "structural" : "parser" };
  }
}
