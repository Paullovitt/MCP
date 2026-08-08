import crypto from "node:crypto";
import fs from "node:fs/promises";

export async function snapshotPath(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isFile()) {
      const content = await fs.readFile(filePath);
      return {
        exists: true,
        type: "file",
        size: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
        sha256: crypto.createHash("sha256").update(content).digest("hex")
      };
    }

    if (stats.isDirectory()) {
      return {
        exists: true,
        type: "directory",
        size: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
        sha256: null
      };
    }

    if (stats.isSymbolicLink()) {
      const target = await fs.readlink(filePath);
      return {
        exists: true,
        type: "symlink",
        size: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
        sha256: crypto.createHash("sha256").update(target).digest("hex")
      };
    }

    return {
      exists: true,
      type: "other",
      size: stats.size,
      mtimeMs: Math.trunc(stats.mtimeMs),
      sha256: null
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        exists: false,
        type: null,
        size: 0,
        mtimeMs: null,
        sha256: null
      };
    }
    throw error;
  }
}

export async function snapshotPaths(paths) {
  const entries = await Promise.all([...new Set(paths)].sort().map(async (filePath) => [filePath, await snapshotPath(filePath)]));
  return Object.fromEntries(entries);
}

export function snapshotsEqual(expected, actual) {
  if (!expected || !actual) return false;
  return (
    expected.exists === actual.exists &&
    expected.type === actual.type &&
    expected.sha256 === actual.sha256 &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  );
}

export function findSnapshotChanges(expectedMap, actualMap) {
  const changes = [];
  for (const filePath of new Set([...Object.keys(expectedMap || {}), ...Object.keys(actualMap || {})])) {
    const expected = expectedMap?.[filePath];
    const actual = actualMap?.[filePath];
    if (!snapshotsEqual(expected, actual)) {
      changes.push({ path: filePath, expected: expected ?? null, actual: actual ?? null });
    }
  }
  return changes;
}
