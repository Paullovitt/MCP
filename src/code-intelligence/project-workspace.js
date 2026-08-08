import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  compactToBudget,
  DEFAULT_IGNORED_DIRECTORIES,
  isTestFile,
  normalizeSlashes,
  relativePath,
  resolveProjectFile,
  unique
} from "./workspace-utils.js";

const MANIFEST_NAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "requirements.txt", "pyproject.toml", "poetry.lock", "pipfile", "pipfile.lock",
  "nuget.config", "packages.config", "dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "tsconfig.json", "jsconfig.json", ".env.example"
]);

const LANGUAGE_BY_EXTENSION = {
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".py": "python", ".cs": "csharp", ".sql": "sql", ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".less": "less", ".json": "json", ".xml": "xml",
  ".md": "markdown", ".yml": "yaml", ".yaml": "yaml", ".ps1": "powershell", ".bat": "batch"
};

function fileCategory(relativeFile) {
  const normalized = normalizeSlashes(relativeFile);
  const base = path.basename(normalized).toLowerCase();
  if (isTestFile(normalized)) return "test";
  if (MANIFEST_NAMES.has(base) || /\.(csproj|sln|props|targets)$/i.test(base)) return "manifest";
  if (/\.env|config|settings|tsconfig|jsconfig/i.test(base)) return "config";
  if (/(^|\/)(migrations?|schema|seeds?)(\/|$)/i.test(normalized) || /\.sql$/i.test(base)) return "database";
  if (/\.(html?|css|scss|less)$/i.test(base)) return "web";
  if (/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|cs)$/i.test(base)) return "source";
  if (/\.(md|txt)$/i.test(base)) return "documentation";
  return "other";
}

export class ProjectWorkspace {
  constructor(projectRoot, { maxFiles = 5000, capabilityProvider } = {}) {
    this.projectRoot = fs.realpathSync(path.resolve(projectRoot));
    this.maxFiles = maxFiles;
    this.capabilityProvider = capabilityProvider;
    this.files = [];
    this.directories = [];
    this.refresh();
  }

  refresh() {
    const files = [];
    const directories = [];
    const pending = [this.projectRoot];
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
          if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;
          directories.push(relativePath(this.projectRoot, fullPath));
          pending.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const stats = fs.statSync(fullPath);
        const relativeFile = relativePath(this.projectRoot, fullPath);
        files.push({
          file: relativeFile,
          extension: path.extname(entry.name).toLowerCase(),
          language: LANGUAGE_BY_EXTENSION[path.extname(entry.name).toLowerCase()] || "unknown",
          category: fileCategory(relativeFile),
          size: stats.size
        });
        if (files.length > this.maxFiles) throw new Error(`Projeto excede o limite de ${this.maxFiles} arquivos indexaveis.`);
      }
    }
    this.files = files.sort((left, right) => left.file.localeCompare(right.file));
    this.directories = directories.sort();
  }

  manifestFiles() {
    return this.files.filter((entry) => entry.category === "manifest");
  }

  nodeDependencies(fileName) {
    const manifest = JSON.parse(fs.readFileSync(fileName, "utf8"));
    const groups = [
      ["runtime", manifest.dependencies || {}],
      ["development", manifest.devDependencies || {}],
      ["peer", manifest.peerDependencies || {}],
      ["optional", manifest.optionalDependencies || {}]
    ];
    return groups.flatMap(([scope, dependencies]) => Object.entries(dependencies).map(([name, version]) => ({
      ecosystem: "npm",
      name,
      version,
      scope,
      installed: fs.existsSync(path.join(this.projectRoot, "node_modules", ...name.split("/")))
    })));
  }

  pythonDependencies(fileName) {
    const base = path.basename(fileName).toLowerCase();
    const content = fs.readFileSync(fileName, "utf8");
    const dependencies = [];
    if (base === "requirements.txt") {
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
        const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*([<>=!~].*)?$/);
        if (match) dependencies.push({ ecosystem: "pip", name: match[1], version: match[2] || "*", scope: "runtime", installed: null });
      }
    } else if (base === "pyproject.toml") {
      const dependencyBlocks = [...content.matchAll(/dependencies\s*=\s*\[([\s\S]*?)\]/g)].map((match) => match[1]);
      for (const block of dependencyBlocks) {
        for (const quoted of block.matchAll(/["']([A-Za-z0-9_.-]+)([^"']*)["']/g)) {
          dependencies.push({ ecosystem: "pip", name: quoted[1], version: quoted[2]?.trim() || "*", scope: "runtime", installed: null });
        }
      }
    }
    return dependencies;
  }

  dotnetDependencies(fileName) {
    const content = fs.readFileSync(fileName, "utf8");
    return [...content.matchAll(/<PackageReference\s+Include=["']([^"']+)["'](?:\s+Version=["']([^"']+)["'])?[^>]*>/gi)].map((match) => ({
      ecosystem: "nuget", name: match[1], version: match[2] || "central/unspecified", scope: "runtime", installed: null
    }));
  }

  webDependencies() {
    const dependencies = [];
    for (const entry of this.files.filter((file) => file.language === "html")) {
      const content = fs.readFileSync(path.join(this.projectRoot, entry.file), "utf8");
      for (const match of content.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gim)) {
        dependencies.push({ ecosystem: "web", name: match[1], version: null, scope: "runtime", installed: !/^https?:\/\//i.test(match[1]), sourceFile: entry.file });
      }
    }
    return dependencies;
  }

  dependencies(input = {}) {
    this.refresh();
    const dependencies = [];
    const manifests = [];
    for (const entry of this.manifestFiles()) {
      const fullPath = path.join(this.projectRoot, entry.file);
      const base = path.basename(entry.file).toLowerCase();
      try {
        if (base === "package.json") dependencies.push(...this.nodeDependencies(fullPath));
        else if (["requirements.txt", "pyproject.toml"].includes(base)) dependencies.push(...this.pythonDependencies(fullPath));
        else if (/\.csproj$/i.test(base)) dependencies.push(...this.dotnetDependencies(fullPath));
        manifests.push(entry.file);
      } catch (error) {
        manifests.push(`${entry.file} (erro: ${error.message})`);
      }
    }
    dependencies.push(...this.webDependencies());
    const query = String(input.query || input.dependency || "").toLowerCase();
    const filtered = dependencies.filter((item) => !query || item.name.toLowerCase().includes(query));
    const limit = input.maxResults || 200;
    return compactToBudget({
      provider: "project-intelligence",
      projectRoot: this.projectRoot,
      manifests,
      dependencies: filtered.slice(0, limit),
      totalDependencies: filtered.length,
      missingDependencies: filtered.filter((item) => item.installed === false),
      installation: this.installationCommands(),
      truncated: filtered.length > limit
    }, input.maxChars || 20_000);
  }

  installationCommands() {
    const names = new Set(this.files.map((entry) => path.basename(entry.file).toLowerCase()));
    const commands = [];
    if (names.has("package-lock.json")) commands.push({ ecosystem: "npm", command: "npm ci", reason: "package-lock.json encontrado", mutatesProject: true });
    else if (names.has("package.json")) commands.push({ ecosystem: "npm", command: "npm install", reason: "package.json encontrado", mutatesProject: true });
    if (names.has("requirements.txt")) commands.push({ ecosystem: "pip", command: "python -m pip install -r requirements.txt", reason: "requirements.txt encontrado", mutatesEnvironment: true });
    if (names.has("pyproject.toml")) commands.push({ ecosystem: "pip", command: "python -m pip install -e .", reason: "pyproject.toml encontrado", mutatesEnvironment: true });
    if (this.files.some((entry) => /\.(sln|csproj)$/i.test(entry.file))) commands.push({ ecosystem: "nuget", command: "dotnet restore", reason: "solucao/projeto C# encontrado", mutatesProject: true });
    return commands;
  }

  installation(input = {}) {
    const dependencyResult = this.dependencies(input);
    const dotnet = spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8", windowsHide: true });
    const python = spawnSync("python", ["--version"], { encoding: "utf8", windowsHide: true });
    return {
      provider: "project-intelligence",
      projectRoot: this.projectRoot,
      commands: dependencyResult.installation,
      missingDependencies: dependencyResult.missingDependencies,
      environments: {
        node: { available: true, version: process.version },
        python: { available: python.status === 0, version: (python.stdout || python.stderr || "").trim() || null },
        dotnetSdk: { available: dotnet.status === 0 && Boolean(dotnet.stdout.trim()), versions: dotnet.stdout.trim().split(/\r?\n/).filter(Boolean) }
      },
      safety: "Comandos sao apenas recomendados; nenhuma instalacao e executada automaticamente."
    };
  }

  relatedFiles(input = {}) {
    if (!input.file) throw new Error("A acao relatedFiles exige file.");
    const fileName = resolveProjectFile(this.projectRoot, input.file);
    const relativeFile = this.relative(fileName);
    const base = path.basename(relativeFile, path.extname(relativeFile)).replace(/[._-](test|spec)$/i, "").toLowerCase();
    const content = fs.readFileSync(fileName, "utf8");
    const related = this.files.filter((entry) => entry.file !== relativeFile).map((entry) => {
      let score = 0;
      const candidateBase = path.basename(entry.file, path.extname(entry.file)).replace(/[._-](test|spec)$/i, "").toLowerCase();
      if (candidateBase === base) score += 10;
      if (entry.file.toLowerCase().includes(base)) score += 4;
      if (content.includes(path.basename(entry.file)) || content.includes(candidateBase)) score += 3;
      if (path.dirname(entry.file) === path.dirname(relativeFile)) score += 1;
      return { ...entry, score };
    }).filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
    return { provider: "project-intelligence", file: relativeFile, relatedFiles: related.slice(0, input.maxResults || 50), total: related.length };
  }

  fileQuery(input = {}) {
    this.refresh();
    const query = String(input.query || "").toLowerCase();
    const category = input.category;
    const files = this.files.filter((entry) => (!query || entry.file.toLowerCase().includes(query)) && (!category || entry.category === category));
    const limit = input.maxResults || 100;
    return { provider: "project-intelligence", projectRoot: this.projectRoot, files: files.slice(0, limit), totalFiles: files.length, directories: this.directories.slice(0, limit), totalDirectories: this.directories.length, truncated: files.length > limit || this.directories.length > limit };
  }

  projectContext(input = {}) {
    this.refresh();
    const languages = {};
    const categories = {};
    for (const entry of this.files) {
      languages[entry.language] = (languages[entry.language] || 0) + 1;
      categories[entry.category] = (categories[entry.category] || 0) + 1;
    }
    const entryPoints = this.files.filter((entry) => /(^|\/)(index|main|app|server|program)\.[^.]+$/i.test(entry.file)).map((entry) => entry.file);
    const tests = this.files.filter((entry) => entry.category === "test").map((entry) => entry.file);
    const dependencies = this.dependencies({ maxResults: input.maxResults || 100, maxChars: Math.floor((input.maxChars || 20_000) / 2) });
    return compactToBudget({
      provider: "project-intelligence",
      projectRoot: this.projectRoot,
      projectName: path.basename(this.projectRoot),
      totalFiles: this.files.length,
      totalDirectories: this.directories.length,
      languages,
      categories,
      entryPoints,
      manifests: this.manifestFiles().map((entry) => entry.file),
      tests,
      dependencies: dependencies.dependencies,
      installation: dependencies.installation,
      capabilities: this.capabilityProvider?.() || []
    }, input.maxChars || 20_000);
  }

  languageCapabilities() {
    return { provider: "project-intelligence", projectRoot: this.projectRoot, capabilities: this.capabilityProvider?.() || [] };
  }

  query(input) {
    switch (input.action) {
      case "project": return this.projectContext(input);
      case "dependencies": return this.dependencies(input);
      case "installation": return this.installation(input);
      case "files": return this.fileQuery(input);
      case "relatedFiles": return this.relatedFiles(input);
      case "languageCapabilities": return this.languageCapabilities();
      default: throw new Error(`Acao de projeto nao suportada: ${input.action}`);
    }
  }

  invalidate() {
    this.refresh();
  }

  dispose() {
    this.files = [];
    this.directories = [];
  }
}
