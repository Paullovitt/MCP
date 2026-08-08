import fs from "node:fs/promises";
import path from "node:path";
import { relativeToProject, resolveInsideProject } from "./path-utils.js";
import { runShellCommand } from "./shell.js";

const DEFAULT_IGNORED_NAMES = new Set(["node_modules", ".git"]);

async function readJsonIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw new Error(`Falha ao ler JSON ${filePath}: ${error.message}`);
  }
}

async function readTextPreviewIfExists(filePath, maxChars) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return {
      exists: true,
      truncated: content.length > maxChars,
      preview: content.slice(0, maxChars)
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, truncated: false, preview: "" };
    }

    throw error;
  }
}

async function listRootEntries(projectRoot, maxEntries) {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });

  return entries
    .filter((entry) => !DEFAULT_IGNORED_NAMES.has(entry.name))
    .slice(0, maxEntries)
    .map((entry) => ({
      name: entry.name,
      path: relativeToProject(projectRoot, path.join(projectRoot, entry.name)),
      type: entry.isDirectory() ? "directory" : "file"
    }));
}

function pickDependencies(packageJson) {
  if (!packageJson) {
    return {
      dependencies: {},
      devDependencies: {}
    };
  }

  return {
    dependencies: packageJson.dependencies || {},
    devDependencies: packageJson.devDependencies || {}
  };
}

async function getGitSummary(projectRoot) {
  const result = await runShellCommand(
    {
      command: "git status --short --branch",
      cwd: ".",
      timeoutMs: 10_000
    },
    { projectRoot }
  );

  return {
    available: result.exitCode === 0,
    status: result.stdout.trim(),
    error: result.exitCode === 0 ? null : result.stderr.trim()
  };
}

export async function projectOverview(input = {}, { projectRoot }) {
  const targetRoot = resolveInsideProject(projectRoot, input.path || ".");
  const packageJsonPath = path.join(targetRoot, "package.json");
  const readmePath = path.join(targetRoot, "README.md");
  const packageJson = await readJsonIfExists(packageJsonPath);
  const rootEntries = await listRootEntries(targetRoot, input.maxEntries ?? 80);
  const readme = await readTextPreviewIfExists(readmePath, input.readmeMaxChars ?? 2500);
  const git = await getGitSummary(targetRoot);
  const dependencyInfo = pickDependencies(packageJson);

  return {
    projectRoot: relativeToProject(projectRoot, targetRoot),
    name: packageJson?.name || path.basename(targetRoot),
    version: packageJson?.version || null,
    description: packageJson?.description || null,
    license: packageJson?.license || null,
    packageManager: "npm",
    scripts: packageJson?.scripts || {},
    dependencies: dependencyInfo.dependencies,
    devDependencies: dependencyInfo.devDependencies,
    rootEntries,
    readme,
    git,
    mainFiles: rootEntries
      .filter((entry) => entry.type === "file" || ["src", "test", "scripts", "data"].includes(entry.name))
      .map((entry) => entry.path)
  };
}
