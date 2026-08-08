import fs from "node:fs/promises";
import path from "node:path";
import { compactToBudget, DEFAULT_IGNORED_DIRECTORIES, isInside, normalizeSlashes, unique } from "./workspace-utils.js";

const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".pyi", ".cs", ".sql", ".html", ".htm", ".css", ".scss", ".less"
]);
const MANIFEST_NAMES = new Set(["package.json", "requirements.txt", "pyproject.toml", "packages.config", "nuget.config"]);

function targetKind(fileName) {
  const base = path.basename(fileName).toLowerCase();
  if (CODE_EXTENSIONS.has(path.extname(base))) return "code";
  if (MANIFEST_NAMES.has(base) || /\.(csproj|sln|props|targets)$/i.test(base)) return "manifest";
  return null;
}

function diagnosticKey(diagnostic) {
  return [diagnostic.file, diagnostic.source, diagnostic.code, diagnostic.category, diagnostic.message].map((value) => String(value ?? "")).join("|");
}

function dependencyKey(dependency) {
  return `${dependency.ecosystem}|${dependency.name}|${dependency.scope || "runtime"}`;
}

export class AutomaticIntelligenceValidator {
  constructor({ engine, logger, maxFiles = 50, maxChars = 20_000 } = {}) {
    this.engine = engine;
    this.logger = logger;
    this.maxFiles = maxFiles;
    this.maxChars = maxChars;
  }

  async collectTargets(projectRoot, writePaths = []) {
    const normalizedRoot = path.resolve(projectRoot);
    const targets = new Map();
    const pending = unique(writePaths.map((filePath) => path.resolve(filePath)));
    let truncated = false;
    while (pending.length > 0) {
      const candidate = pending.pop();
      if (!isInside(normalizedRoot, candidate)) continue;
      const stats = await fs.stat(candidate).catch(() => null);
      if (stats?.isDirectory()) {
        const entries = await fs.readdir(candidate, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isSymbolicLink() || (entry.isDirectory() && DEFAULT_IGNORED_DIRECTORIES.has(entry.name))) continue;
          pending.push(path.join(candidate, entry.name));
        }
        continue;
      }
      const kind = targetKind(candidate);
      if (!kind) continue;
      targets.set(candidate, { path: candidate, file: normalizeSlashes(path.relative(normalizedRoot, candidate)), kind, exists: Boolean(stats?.isFile()) });
      if (targets.size >= this.maxFiles) {
        truncated = pending.length > 0;
        break;
      }
    }
    return { targets: [...targets.values()].sort((left, right) => left.file.localeCompare(right.file)), truncated };
  }

  async safe(action, fallback, metadata) {
    try {
      return await action();
    } catch (error) {
      this.logger?.warn("Validacao automatica de Code Intelligence indisponivel para um item.", { ...metadata, error: error.message });
      return { ...fallback, error: error.message };
    }
  }

  async analyzeCodeFile(projectRoot, target, { includeImpact }) {
    if (!target.exists) return { file: target.file, exists: false, diagnostics: [], symbols: [], relatedFiles: [] };
    const diagnosticsPromise = this.safe(
      () => this.engine.diagnostics(projectRoot, { file: target.file, maxResults: 200 }),
      { diagnostics: [] },
      { projectRoot, file: target.file, phase: includeImpact ? "before" : "after" }
    );
    if (!includeImpact) {
      const diagnostics = await diagnosticsPromise;
      return { file: target.file, exists: true, diagnostics: diagnostics.diagnostics || [], provider: diagnostics.provider || null };
    }
    const [diagnostics, symbols, related] = await Promise.all([
      diagnosticsPromise,
      this.safe(
        () => this.engine.query(projectRoot, { action: "symbols", file: target.file, query: "", maxResults: 30 }),
        { symbols: [] },
        { projectRoot, file: target.file, phase: "symbols" }
      ),
      this.safe(
        () => this.engine.query(projectRoot, { action: "relatedFiles", file: target.file, maxResults: 20 }),
        { relatedFiles: [] },
        { projectRoot, file: target.file, phase: "related" }
      )
    ]);
    return {
      file: target.file,
      exists: true,
      provider: diagnostics.provider || symbols.provider || null,
      diagnostics: diagnostics.diagnostics || [],
      symbols: (symbols.symbols || []).map((symbol) => ({ name: symbol.name, kind: symbol.kind, line: symbol.line, column: symbol.column })),
      relatedFiles: (related.relatedFiles || []).map((item) => ({ file: item.file, category: item.category, score: item.score }))
    };
  }

  async dependencies(projectRoot) {
    const result = await this.safe(
      () => this.engine.query(projectRoot, { action: "dependencies", maxResults: 500, maxChars: 50_000 }),
      { dependencies: [], missingDependencies: [], installation: [] },
      { projectRoot, phase: "dependencies" }
    );
    return {
      dependencies: result.dependencies || [],
      missingDependencies: result.missingDependencies || [],
      installation: result.installation || [],
      error: result.error || null
    };
  }

  async prepare(projectRoot, writePaths, mode = "always") {
    const startedAt = Date.now();
    if (mode === "off") return { mode, applicable: false, status: "disabled", files: [], durationMs: 0 };
    const collected = await this.collectTargets(projectRoot, writePaths);
    if (collected.targets.length === 0) {
      return { mode, applicable: false, status: "not_applicable", files: [], truncated: collected.truncated, durationMs: Date.now() - startedAt };
    }
    const codeTargets = collected.targets.filter((target) => target.kind === "code");
    const hasManifest = collected.targets.some((target) => target.kind === "manifest");
    const files = await Promise.all(codeTargets.map((target) => this.analyzeCodeFile(projectRoot, target, { includeImpact: true })));
    const dependencyState = hasManifest ? await this.dependencies(projectRoot) : null;
    return {
      mode,
      applicable: true,
      status: "prepared",
      files,
      manifests: collected.targets.filter((target) => target.kind === "manifest").map((target) => target.file),
      dependencyState,
      truncated: collected.truncated,
      durationMs: Date.now() - startedAt
    };
  }

  compareDiagnostics(beforeFiles, afterFiles) {
    const before = beforeFiles.flatMap((file) => file.diagnostics || []);
    const after = afterFiles.flatMap((file) => file.diagnostics || []);
    const beforeMap = new Map(before.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic]));
    const afterMap = new Map(after.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic]));
    return {
      before,
      after,
      added: [...afterMap].filter(([key]) => !beforeMap.has(key)).map(([, diagnostic]) => diagnostic),
      resolved: [...beforeMap].filter(([key]) => !afterMap.has(key)).map(([, diagnostic]) => diagnostic),
      unchanged: [...afterMap.keys()].filter((key) => beforeMap.has(key)).length
    };
  }

  compareDependencies(beforeState, afterState) {
    if (!beforeState && !afterState) return null;
    const before = new Map((beforeState?.dependencies || []).map((dependency) => [dependencyKey(dependency), dependency]));
    const after = new Map((afterState?.dependencies || []).map((dependency) => [dependencyKey(dependency), dependency]));
    return {
      added: [...after].filter(([key]) => !before.has(key)).map(([, dependency]) => dependency),
      removed: [...before].filter(([key]) => !after.has(key)).map(([, dependency]) => dependency),
      changed: [...after].filter(([key, dependency]) => before.has(key) && before.get(key).version !== dependency.version).map(([key, dependency]) => ({ before: before.get(key), after: dependency })),
      missing: afterState?.missingDependencies || [],
      installation: afterState?.installation || []
    };
  }

  async verify(projectRoot, writePaths, baseline) {
    const startedAt = Date.now();
    // Toda escrita invalida os snapshots, mesmo quando o arquivo nao possui provider semantico.
    this.engine.invalidate(projectRoot, writePaths);
    if (baseline?.status === "disabled") return { ...baseline, phase: "after", totalDurationMs: baseline.durationMs || 0 };
    if (baseline?.status === "unavailable") return { ...baseline, verified: false, phase: "after", totalDurationMs: baseline.durationMs || 0 };
    const collected = await this.collectTargets(projectRoot, writePaths);
    if (!baseline?.applicable && collected.targets.length === 0) return { ...baseline, phase: "after", totalDurationMs: baseline?.durationMs || 0 };
    // Copias/movimentos de diretorios podem criar arquivos de codigo que nao existiam no preflight.
    if (!baseline?.applicable) baseline = { ...(baseline || {}), mode: baseline?.mode || "always", applicable: true, status: "prepared", files: [], manifests: [], dependencyState: null, durationMs: baseline?.durationMs || 0 };
    const beforeFileNames = new Set((baseline.files || []).map((file) => file.file));
    const beforeExistence = new Map((baseline.files || []).map((file) => [file.file, file.exists]));
    const targetByFile = new Map(collected.targets.filter((target) => target.kind === "code").map((target) => [target.file, target]));
    for (const file of beforeFileNames) {
      if (!targetByFile.has(file)) targetByFile.set(file, { file, path: path.resolve(projectRoot, file), kind: "code", exists: false });
    }
    const afterFiles = await Promise.all([...targetByFile.values()].map((target) => this.analyzeCodeFile(projectRoot, target, { includeImpact: false })));
    const diagnostics = this.compareDiagnostics(baseline.files || [], afterFiles);
    const manifestChanged = baseline.manifests?.length > 0 || collected.targets.some((target) => target.kind === "manifest");
    const afterDependencies = manifestChanged ? await this.dependencies(projectRoot) : null;
    const dependencyChanges = this.compareDependencies(baseline.dependencyState, afterDependencies);
    const newErrors = diagnostics.added.filter((diagnostic) => diagnostic.category === "error");
    const newWarnings = diagnostics.added.filter((diagnostic) => diagnostic.category !== "error");
    const status = newErrors.length > 0 ? "failed" : newWarnings.length > 0 || dependencyChanges?.missing?.length > 0 ? "warnings" : "passed";
    const result = {
      mode: baseline.mode,
      applicable: true,
      status,
      verified: true,
      files: afterFiles.map((file) => ({ file: file.file, exists: file.exists, provider: file.provider })),
      createdFiles: afterFiles.filter((file) => file.exists && beforeExistence.get(file.file) !== true).map((file) => file.file),
      removedFiles: afterFiles.filter((file) => !file.exists).map((file) => file.file),
      impact: (baseline.files || []).map((file) => ({ file: file.file, symbols: file.symbols || [], relatedFiles: file.relatedFiles || [] })),
      diagnostics: {
        before: diagnostics.before.length,
        after: diagnostics.after.length,
        unchanged: diagnostics.unchanged,
        added: diagnostics.added.slice(0, 50),
        resolved: diagnostics.resolved.slice(0, 50),
        addedTotal: diagnostics.added.length,
        resolvedTotal: diagnostics.resolved.length,
        newErrors: newErrors.length,
        newWarnings: newWarnings.length
      },
      dependencyChanges: dependencyChanges ? {
        ...dependencyChanges,
        added: dependencyChanges.added.slice(0, 50),
        removed: dependencyChanges.removed.slice(0, 50),
        changed: dependencyChanges.changed.slice(0, 50),
        missing: dependencyChanges.missing.slice(0, 50)
      } : null,
      truncated: baseline.truncated || collected.truncated,
      preflightDurationMs: baseline.durationMs,
      postflightDurationMs: Date.now() - startedAt,
      totalDurationMs: baseline.durationMs + (Date.now() - startedAt)
    };
    return compactToBudget(result, this.maxChars);
  }
}

export { CODE_EXTENSIONS, targetKind };
