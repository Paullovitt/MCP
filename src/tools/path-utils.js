import path from "node:path";

export function resolvePath(baseRoot, inputPath = ".") {
  if (!inputPath || inputPath === ".") {
    return path.resolve(baseRoot);
  }

  // Absolute paths are intentionally allowed so the app can operate on any
  // project folder on different PCs, not only on the GPT-MCP install folder.
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }

  return path.resolve(baseRoot, inputPath);
}

export function resolveInsideProject(projectRoot, inputPath = ".") {
  // Kept for backward compatibility with existing tools. Despite the old name,
  // this resolver now allows absolute paths by design.
  return resolvePath(projectRoot, inputPath);
}

export function displayPath(baseRoot, absolutePath) {
  const root = path.resolve(baseRoot);
  const resolvedPath = path.resolve(absolutePath);
  const relativePath = path.relative(root, resolvedPath);

  if (!relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return relativePath || ".";
  }

  return resolvedPath;
}

export function relativeToProject(projectRoot, absolutePath) {
  return displayPath(projectRoot, absolutePath);
}

export function normalizeEncoding(encoding = "utf8") {
  const allowed = new Set(["utf8", "utf-8", "ascii", "latin1", "base64"]);

  if (!allowed.has(encoding.toLowerCase())) {
    throw new Error(`Encoding nao permitido: ${encoding}`);
  }

  return encoding;
}
