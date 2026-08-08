import fs from "node:fs";
import path from "node:path";

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage", ".next", "out", "bin", "obj", ".venv", "venv", "__pycache__"
]);

export function normalizeSlashes(value) {
  return String(value || "").replaceAll("\\", "/");
}

export function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveProjectFile(projectRoot, inputPath, { mustExist = true } = {}) {
  if (!inputPath) throw new Error("Informe o arquivo para esta consulta de codigo.");
  const resolved = path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(projectRoot, inputPath);
  if (!isInside(projectRoot, resolved)) throw new Error(`Arquivo fora do projeto: ${resolved}`);
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`Arquivo nao encontrado: ${resolved}`);
  const realPath = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  if (!isInside(projectRoot, realPath)) throw new Error(`Arquivo aponta para fora do projeto: ${resolved}`);
  return realPath;
}

export function relativePath(projectRoot, fileName) {
  return normalizeSlashes(path.relative(projectRoot, fileName));
}

export function isTestFile(fileName) {
  const normalized = normalizeSlashes(fileName);
  return /(^|\/)(__tests__|tests?|specs?)\//i.test(normalized)
    || /[._](test|spec)\.[^.]+$/i.test(normalized)
    || /Tests?\.(cs|py)$/i.test(normalized);
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function discoverFiles(projectRoot, extensions, { maxFiles = 5000 } = {}) {
  const normalizedExtensions = new Set(extensions.map((extension) => extension.toLowerCase()));
  const results = [];
  const pending = [projectRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !normalizedExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      results.push(fullPath);
      if (results.length > maxFiles) throw new Error(`Projeto excede o limite de ${maxFiles} arquivos analisaveis.`);
    }
  }
  return results.sort();
}

export function fileFingerprint(fileName) {
  try {
    const stats = fs.statSync(fileName, { bigint: true });
    return `${stats.mtimeNs}:${stats.size}`;
  } catch {
    return "missing";
  }
}

export function offsetAt(content, line = 1, column = 1) {
  const lines = content.split(/\r?\n/);
  const lineIndex = Math.max(0, Math.min(lines.length - 1, Number(line) - 1));
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) offset += lines[index].length + 1;
  return Math.min(content.length, offset + Math.max(0, Math.min(lines[lineIndex].length, Number(column) - 1)));
}

export function lineColumnAt(content, offset) {
  const safeOffset = Math.max(0, Math.min(content.length, Number(offset) || 0));
  const before = content.slice(0, safeOffset);
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

export function wordAt(content, line, column) {
  const offset = offsetAt(content, line, column);
  let start = offset;
  let end = offset;
  while (start > 0 && /[\p{L}\p{N}_$]/u.test(content[start - 1])) start -= 1;
  while (end < content.length && /[\p{L}\p{N}_$]/u.test(content[end])) end += 1;
  return { word: content.slice(start, end), start, end };
}

export function locationFromOffset(projectRoot, fileName, content, start, length = 0) {
  const begin = lineColumnAt(content, start);
  const end = lineColumnAt(content, start + length);
  return {
    file: relativePath(projectRoot, fileName),
    line: begin.line,
    column: begin.column,
    endLine: end.line,
    endColumn: end.column
  };
}

export function compactToBudget(result, maxChars = 20_000) {
  const arrays = [
    "symbols", "definitions", "references", "incomingCalls", "outgoingCalls", "imports", "dependentFiles",
    "relatedSymbols", "relatedTests", "diagnostics", "files", "directories", "dependencies", "manifests", "impact"
  ];
  while (JSON.stringify(result).length > maxChars) {
    const candidate = arrays
      .map((key) => ({ key, length: Array.isArray(result[key]) ? result[key].length : 0 }))
      .sort((left, right) => right.length - left.length)[0];
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
