import fs from "node:fs/promises";
import path from "node:path";
import { normalizeEncoding, relativeToProject, resolveInsideProject } from "./path-utils.js";

const IGNORED_DIRS = new Set(["node_modules", ".git"]);

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function shouldIgnoreDir(dirName) {
  return IGNORED_DIRS.has(dirName);
}

async function walkDirectory(root, currentPath, options, results, depth = 0) {
  if (results.length >= options.maxEntries || depth > options.maxDepth) {
    return;
  }

  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= options.maxEntries) {
      return;
    }

    if (entry.isDirectory() && shouldIgnoreDir(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentPath, entry.name);
    const item = {
      name: entry.name,
      path: relativeToProject(root, absolutePath),
      type: entry.isDirectory() ? "directory" : "file"
    };

    results.push(item);

    if (options.recursive && entry.isDirectory()) {
      await walkDirectory(root, absolutePath, options, results, depth + 1);
    }
  }
}

export async function listFiles(input, { projectRoot }) {
  const targetPath = resolveInsideProject(projectRoot, input.path || ".");
  const stats = await fs.stat(targetPath);

  if (!stats.isDirectory()) {
    throw new Error("O caminho informado não é uma pasta.");
  }

  const results = [];
  await walkDirectory(projectRoot, targetPath, input, results);

  return {
    root: relativeToProject(projectRoot, targetPath),
    count: results.length,
    entries: results
  };
}

export async function readFileText(input, { projectRoot }) {
  const filePath = resolveInsideProject(projectRoot, input.path);
  const encoding = normalizeEncoding(input.encoding);
  const content = await fs.readFile(filePath, encoding);
  const maxChars = input.maxChars ?? 200_000;

  return {
    path: relativeToProject(projectRoot, filePath),
    truncated: content.length > maxChars,
    content: content.slice(0, maxChars)
  };
}

export async function writeFileText(input, { projectRoot }) {
  const filePath = resolveInsideProject(projectRoot, input.path);

  if (input.createDirectories !== false) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  await fs.writeFile(filePath, input.content, "utf8");

  return {
    path: relativeToProject(projectRoot, filePath),
    bytes: Buffer.byteLength(input.content, "utf8"),
    createdDirectories: input.createDirectories !== false
  };
}

export async function createDirectory(input, { projectRoot }) {
  const directoryPath = resolveInsideProject(projectRoot, input.path);

  // Mantem o comportamento amigavel de agente: criar a arvore quando pedido.
  await fs.mkdir(directoryPath, { recursive: input.recursive !== false });

  return {
    path: relativeToProject(projectRoot, directoryPath),
    recursive: input.recursive !== false
  };
}

export async function deletePath(input, { projectRoot }) {
  const targetPath = resolveInsideProject(projectRoot, input.path);
  const stats = await fs.lstat(targetPath);

  // A exclusao fica explicita em tool separada para o cliente MCP tratar como acao destrutiva.
  await fs.rm(targetPath, {
    recursive: input.recursive === true,
    force: input.force === true
  });

  return {
    path: relativeToProject(projectRoot, targetPath),
    type: stats.isDirectory() ? "directory" : "file",
    recursive: input.recursive === true,
    force: input.force === true
  };
}

export async function movePath(input, { projectRoot }) {
  const sourcePath = resolveInsideProject(projectRoot, input.source);
  const destinationPath = resolveInsideProject(projectRoot, input.destination);

  // Facilita mover arquivos para pastas novas sem exigir um passo manual anterior.
  if (input.createDirectories !== false) {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  }

  if (input.overwrite === true) {
    await fs.rm(destinationPath, { recursive: true, force: true });
  }

  await fs.rename(sourcePath, destinationPath);

  return {
    source: relativeToProject(projectRoot, sourcePath),
    destination: relativeToProject(projectRoot, destinationPath),
    overwritten: input.overwrite === true
  };
}

export async function copyPath(input, { projectRoot }) {
  const sourcePath = resolveInsideProject(projectRoot, input.source);
  const destinationPath = resolveInsideProject(projectRoot, input.destination);
  const stats = await fs.lstat(sourcePath);

  // Usa as APIs nativas do Node para preservar comportamento consistente entre PCs.
  if (input.createDirectories !== false) {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  }

  if (input.overwrite === true) {
    await fs.rm(destinationPath, { recursive: true, force: true });
  }

  if (stats.isDirectory()) {
    await fs.cp(sourcePath, destinationPath, {
      recursive: input.recursive === true,
      force: input.overwrite === true
    });
  } else {
    await fs.copyFile(sourcePath, destinationPath);
  }

  return {
    source: relativeToProject(projectRoot, sourcePath),
    destination: relativeToProject(projectRoot, destinationPath),
    type: stats.isDirectory() ? "directory" : "file",
    recursive: input.recursive === true,
    overwritten: input.overwrite === true
  };
}

function fileMatchesPattern(relativePath, includePattern) {
  if (!includePattern) {
    return true;
  }

  const escaped = includePattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(relativePath);
}

async function searchFile(filePath, relativePath, input, matches) {
  const rawContent = await fs.readFile(filePath, "utf8").catch(() => null);

  if (rawContent === null) {
    return;
  }

  const haystack = input.caseSensitive ? rawContent : rawContent.toLowerCase();
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
  const lines = rawContent.split(/\r?\n/);
  const searchableLines = haystack.split(/\r?\n/);

  for (let index = 0; index < searchableLines.length; index += 1) {
    if (matches.length >= input.maxMatches) {
      return;
    }

    const column = searchableLines[index].indexOf(needle);

    if (column !== -1) {
      matches.push({
        path: relativePath,
        line: index + 1,
        column: column + 1,
        text: lines[index]
      });
    }
  }
}

async function walkForSearch(projectRoot, currentPath, input, matches, depth = 0) {
  if (matches.length >= input.maxMatches || depth > input.maxDepth) {
    return;
  }

  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (matches.length >= input.maxMatches) {
      return;
    }

    if (entry.isDirectory() && shouldIgnoreDir(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = relativeToProject(projectRoot, absolutePath);

    if (entry.isDirectory()) {
      if (input.recursive) {
        await walkForSearch(projectRoot, absolutePath, input, matches, depth + 1);
      }
      continue;
    }

    if (fileMatchesPattern(relativePath, input.includePattern)) {
      await searchFile(absolutePath, relativePath, input, matches);
    }
  }
}

export async function searchFiles(input, { projectRoot }) {
  if (!input.query) {
    throw new Error("A busca exige um texto em query.");
  }

  const targetPath = resolveInsideProject(projectRoot, input.path || ".");
  const matches = [];
  const effectiveInput = {
    recursive: input.recursive !== false,
    caseSensitive: input.caseSensitive === true,
    maxMatches: input.maxMatches ?? 100,
    maxDepth: input.maxDepth ?? 8,
    includePattern: input.includePattern,
    query: input.query
  };

  await walkForSearch(projectRoot, targetPath, effectiveInput, matches);

  return {
    query: input.query,
    count: matches.length,
    matches
  };
}

export async function applyExactPatch(input, { projectRoot }) {
  const filePath = resolveInsideProject(projectRoot, input.path);
  const content = await fs.readFile(filePath, "utf8");

  if (!content.includes(input.search)) {
    throw new Error("Texto exato de busca não encontrado no arquivo.");
  }

  const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  if (input.backup !== false && !(await pathExists(backupPath))) {
    await fs.writeFile(backupPath, content, "utf8");
  }

  const updatedContent =
    input.replaceAll === true
      ? content.split(input.search).join(input.replace)
      : content.replace(input.search, input.replace);

  await fs.writeFile(filePath, updatedContent, "utf8");

  return {
    path: relativeToProject(projectRoot, filePath),
    backupPath: input.backup !== false ? relativeToProject(projectRoot, backupPath) : null,
    replacements: input.replaceAll === true ? content.split(input.search).length - 1 : 1
  };
}
