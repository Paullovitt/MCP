import { fork } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CoordinatorStore, TERMINAL_TASK_STATES } from "../storage/sqlite-store.js";
import { CodeIntelligenceEngine } from "../code-intelligence/engine.js";
import { findSnapshotChanges, snapshotPaths } from "./file-state.js";

const SUPPORTED_OPERATIONS = new Set([
  "read_file",
  "list_files",
  "search_files",
  "write_file",
  "apply_patch",
  "create_directory",
  "copy_path",
  "move_path",
  "delete_path",
  "run_shell",
  "run_tests",
  "git_status",
  "git_diff",
  "batch_operations",
  "code_context",
  "code_query",
  "code_diagnostics"
]);

const DEFAULT_OPERATION_ESTIMATES_MS = {
  read_file: 40,
  list_files: 80,
  search_files: 180,
  write_file: 60,
  apply_patch: 80,
  create_directory: 30,
  copy_path: 180,
  move_path: 120,
  delete_path: 80,
  run_shell: 1000,
  run_tests: 3000,
  git_status: 250,
  git_diff: 350,
  batch_operations: 200,
  code_context: 500,
  code_query: 250,
  code_diagnostics: 800
};

const PROJECT_HISTORY_CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function errorObject(code, message, details = null) {
  return { code, message, details };
}

export class WorkerTeamManager {
  constructor({ projectRoot, databasePath, logger, workerCount = 3, defaultTimeoutMs = 120_000, lockTtlMs = 30_000, codeIntelligenceEngine }) {
    this.projectRoot = path.resolve(projectRoot);
    this.databasePath = databasePath || path.join(this.projectRoot, "data", "coordinator.sqlite");
    this.logger = logger;
    this.workerCount = workerCount;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.lockTtlMs = lockTtlMs;
    this.workerScript = path.join(this.projectRoot, "src", "workers", "worker-process.js");
    this.store = new CoordinatorStore(this.databasePath);
    this.codeIntelligence = codeIntelligenceEngine || new CodeIntelligenceEngine({ logger });
    this.runtimes = new Map();
    this.retryTimers = new Map();
    this.mutationChain = Promise.resolve();
    this.dependencyReleaseChain = Promise.resolve();
    this.maintenanceTimer = null;
    this.stopped = false;
  }

  serializeMutation(callback) {
    const next = this.mutationChain.then(callback, callback);
    this.mutationChain = next.catch(() => {});
    return next;
  }

  async cleanupMissingProjectHistories() {
    return this.serializeMutation(async () => {
      const removed = [];
      const teams = this.store.listTeams(1_000_000);
      for (const team of teams) {
        let projectMissing = false;
        try {
          const stats = await fs.stat(team.projectRoot);
          projectMissing = !stats.isDirectory();
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") projectMissing = true;
          else {
            this.logger?.warn("Nao foi possivel verificar a pasta do projeto; historico preservado.", { teamId: team.id, projectRoot: team.projectRoot, error: error.message });
          }
        }
        if (!projectMissing) continue;

        if (team.status === "ativo" || team.status === "fechando") {
          await this.closeTeamInternal(team.id, { reason: "Pasta do projeto removida; equipe encerrada para limpar o historico." });
        }
        const deleted = this.store.deleteTeamHistory(team.id);
        await this.codeIntelligence.disposeProject(team.projectRoot);
        removed.push({ teamId: team.id, projectRoot: team.projectRoot, deleted });
        this.logger?.info("Historico removido porque a pasta do projeto nao existe mais.", { teamId: team.id, projectRoot: team.projectRoot, deleted });
      }
      return { checked: teams.length, removed };
    });
  }

  startMaintenance(intervalMs = PROJECT_HISTORY_CLEANUP_INTERVAL_MS) {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      this.cleanupMissingProjectHistories().catch((error) => {
        this.logger?.error("Falha na limpeza periodica de projetos ausentes.", { error: error.message });
      });
    }, Math.max(10_000, intervalMs));
    this.maintenanceTimer.unref?.();
  }

  addLog(log) {
    this.store.addLog(log);
    const level = log.level || "info";
    const payload = {
      teamId: log.teamId || null,
      workerId: log.workerId || null,
      taskId: log.taskId || null,
      event: log.event,
      data: log.data || null
    };
    if (level === "error") this.logger?.error(log.message, payload);
    else if (level === "warn") this.logger?.warn(log.message, payload);
    else this.logger?.info(log.message, payload);
  }

  resolveCodeProject({ teamId, projectPath } = {}) {
    if (teamId) {
      const team = this.store.getTeam(teamId);
      if (!team) throw new Error("Equipe nao encontrada para consulta de codigo.");
      return team.projectRoot;
    }
    return path.resolve(projectPath || this.projectRoot);
  }

  async codeQuery(input = {}) {
    const projectRoot = this.resolveCodeProject(input);
    return this.codeIntelligence.query(projectRoot, input);
  }

  async codeContext(input = {}) {
    const projectRoot = this.resolveCodeProject(input);
    return this.codeIntelligence.context(projectRoot, input);
  }

  async codeDiagnostics(input = {}) {
    const projectRoot = this.resolveCodeProject(input);
    return this.codeIntelligence.diagnostics(projectRoot, input);
  }

  invalidateCodeIntelligence(projectRoot, paths = []) {
    this.codeIntelligence.invalidate(projectRoot, paths);
  }

  async createTeam({ projectPath, name = "Equipe de workers" }) {
    return this.serializeMutation(async () => {
      if (this.stopped) throw new Error("Coordenador encerrado.");
      const projectRoot = path.resolve(projectPath);
      const stats = await fs.stat(projectRoot).catch(() => null);
      if (!stats?.isDirectory()) {
        throw new Error(`Projeto local nao encontrado: ${projectRoot}`);
      }

      const teamId = randomUUID();
      const createdAt = Date.now();
      const team = this.store.createTeam({ id: teamId, name, projectRoot, status: "ativo", createdAt });
      const workers = [];

      try {
        for (let slot = 1; slot <= this.workerCount; slot += 1) {
          const workerId = `${teamId}:worker-${slot}`;
          this.store.createWorker({
            id: workerId,
            teamId,
            slot,
            status: "parado",
            pid: null,
            directory: projectRoot,
            createdAt,
            updatedAt: createdAt
          });
          workers.push(await this.spawnWorker(workerId));
        }
      } catch (error) {
        this.store.updateTeam(teamId, { status: "erro", error: errorObject("worker_start_failed", error.message) });
        await this.closeTeamInternal(teamId, { reason: "Falha ao iniciar workers.", preserveTeamError: true });
        throw error;
      }

      this.addLog({
        teamId,
        level: "info",
        event: "team_created",
        message: "Equipe criada com tres processos workers.",
        data: { projectRoot, workerIds: workers.map((worker) => worker.id) }
      });

      return this.getTeamStatus(team.id);
    });
  }

  async spawnWorker(workerId) {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new Error(`Worker nao encontrado: ${workerId}`);

    const child = fork(this.workerScript, [], {
      cwd: this.projectRoot,
      env: {
        ...process.env,
        WORKER_ID: worker.id,
        WORKER_TEAM_ID: worker.teamId,
        WORKER_SLOT: String(worker.slot)
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true
    });

    let readyResolve;
    let readyReject;
    const readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const readyTimeout = setTimeout(() => readyReject(new Error(`Worker ${workerId} nao ficou pronto.`)), 8000);

    const runtime = {
      workerId,
      teamId: worker.teamId,
      child,
      ready: false,
      currentTaskId: null,
      pumping: false,
      lockRenewal: null,
      closing: false,
      readyPromise
    };
    this.runtimes.set(workerId, runtime);

    child.stdout.on("data", (chunk) => {
      this.addLog({ teamId: worker.teamId, workerId, level: "info", event: "worker_stdout", message: chunk.toString().trim(), data: null });
    });
    child.stderr.on("data", (chunk) => {
      this.addLog({ teamId: worker.teamId, workerId, level: "warn", event: "worker_stderr", message: chunk.toString().trim(), data: null });
    });
    child.on("message", (message) => this.handleWorkerMessage(workerId, message));
    child.on("error", (error) => {
      readyReject(error);
      this.addLog({ teamId: worker.teamId, workerId, level: "error", event: "worker_process_error", message: error.message, data: null });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(readyTimeout);
      if (!runtime.ready) readyReject(new Error(`Worker ${workerId} encerrou antes de ficar pronto.`));
      this.handleWorkerExit(workerId, code, signal).catch((error) => {
        this.logger?.error("Falha ao tratar encerramento de worker.", { workerId, error: error.message });
      });
    });

    runtime.resolveReady = (message) => {
      clearTimeout(readyTimeout);
      runtime.ready = true;
      this.store.updateWorker(workerId, { status: "aguardando", pid: message.pid, currentTaskId: null, error: null });
      readyResolve(this.store.getWorker(workerId));
    };

    return readyPromise;
  }

  async handleWorkerExit(workerId, code, signal) {
    const runtime = this.runtimes.get(workerId);
    if (!runtime) return;
    if (runtime.lockRenewal) clearInterval(runtime.lockRenewal);
    this.runtimes.delete(workerId);

    const worker = this.store.getWorker(workerId);
    const taskId = runtime.currentTaskId || worker?.currentTaskId;
    if (taskId) {
      const task = this.store.getTask(taskId);
      this.store.releaseLocks(taskId);
      if (task && !TERMINAL_TASK_STATES.has(task.status)) {
        this.store.updateTask(taskId, {
          status: "erro",
          finishedAt: Date.now(),
          error: errorObject("worker_process_exited", "Processo worker encerrou inesperadamente.", { code, signal })
        });
        await this.releaseDependentTasks(task.teamId);
      }
    }

    this.store.updateWorker(workerId, {
      status: runtime.closing ? "parado" : "erro",
      pid: null,
      currentTaskId: null,
      error: runtime.closing ? null : errorObject("worker_process_exited", "Processo worker encerrou inesperadamente.", { code, signal })
    });

    this.addLog({
      teamId: runtime.teamId,
      workerId,
      taskId: taskId || null,
      level: runtime.closing ? "info" : "error",
      event: "worker_exited",
      message: runtime.closing ? "Worker encerrado." : "Worker encerrou inesperadamente.",
      data: { code, signal }
    });

    const team = this.store.getTeam(runtime.teamId);
    if (!runtime.closing && team?.status === "ativo" && !this.stopped) {
      await delay(150);
      try {
        await this.spawnWorker(workerId);
        this.addLog({ teamId: runtime.teamId, workerId, level: "info", event: "worker_recovered", message: "Worker reiniciado apos falha.", data: null });
        this.pumpWorker(workerId).catch(() => {});
      } catch (error) {
        this.store.updateWorker(workerId, { status: "erro", error: errorObject("worker_restart_failed", error.message) });
      }
    }
  }

  handleWorkerMessage(workerId, message) {
    const runtime = this.runtimes.get(workerId);
    if (!runtime || !message || typeof message !== "object") return;
    const worker = this.store.getWorker(workerId);

    if (message.type === "ready") {
      runtime.resolveReady?.(message);
      this.addLog({ teamId: worker.teamId, workerId, level: "info", event: "worker_ready", message: "Worker pronto.", data: { pid: message.pid } });
      this.pumpWorker(workerId).catch(() => {});
      return;
    }

    if (message.type === "log") {
      this.addLog({
        teamId: worker.teamId,
        workerId,
        taskId: message.taskId || runtime.currentTaskId,
        level: message.level || "info",
        event: message.event || "worker_log",
        message: message.message || "",
        data: message.data || null,
        createdAt: message.createdAt || Date.now()
      });
      return;
    }

    if (message.type === "code_intelligence_request") {
      this.handleWorkerCodeIntelligenceRequest(runtime, worker, message).catch((error) => {
        runtime.child.send({ type: "code_intelligence_response", requestId: message.requestId, error: { code: error.code || "code_intelligence_error", message: error.message } });
      });
      return;
    }

    if (message.type === "result") {
      this.completeTaskFromWorker(workerId, message).catch((error) => {
        this.logger?.error("Falha ao registrar resultado do worker.", { workerId, error: error.message });
      });
      return;
    }

    if (message.type === "fatal") {
      this.addLog({
        teamId: worker.teamId,
        workerId,
        taskId: message.taskId || runtime.currentTaskId,
        level: "error",
        event: "worker_fatal",
        message: message.error?.message || "Erro fatal no worker.",
        data: message.error || null
      });
    }
  }

  async handleWorkerCodeIntelligenceRequest(runtime, worker, message) {
    const team = this.store.getTeam(worker.teamId);
    if (!team || runtime.currentTaskId !== message.taskId) throw new Error("Solicitacao de Code Intelligence fora da tarefa ativa.");
    let result;
    if (message.action === "context") result = await this.codeIntelligence.context(team.projectRoot, message.params || {});
    else if (message.action === "diagnostics") result = await this.codeIntelligence.diagnostics(team.projectRoot, message.params || {});
    else if (message.action === "query") result = await this.codeIntelligence.query(team.projectRoot, message.params || {});
    else throw new Error(`Acao interna de Code Intelligence nao suportada: ${message.action}`);
    runtime.child.send({ type: "code_intelligence_response", requestId: message.requestId, result, error: null });
  }

  resolveProjectPath(teamRoot, inputPath = ".") {
    const resolved = path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(teamRoot, inputPath);
    if (!isInside(teamRoot, resolved)) {
      throw new Error(`Caminho fora do projeto da equipe: ${resolved}`);
    }
    return resolved;
  }

  inferTaskPaths(team, operation, params, declaredReadPaths = [], declaredWritePaths = []) {
    const reads = [...declaredReadPaths];
    const writes = [...declaredWritePaths];

    switch (operation) {
      case "read_file":
        reads.push(params.path);
        break;
      case "list_files":
      case "search_files":
        reads.push(params.path || ".");
        break;
      case "write_file":
      case "apply_patch":
      case "delete_path":
      case "create_directory":
        writes.push(params.path);
        break;
      case "copy_path":
        reads.push(params.source);
        writes.push(params.destination);
        break;
      case "move_path":
        reads.push(params.source);
        writes.push(params.source, params.destination);
        break;
      case "run_shell":
        if (params.mutatesFiles === true && declaredWritePaths.length === 0) {
          throw new Error("Tarefas de terminal que alteram arquivos exigem writePaths declarados.");
        }
        break;
      case "run_tests":
        reads.push(params.cwd || ".");
        if (params.mutatesFiles === true && declaredWritePaths.length === 0) {
          throw new Error("Tarefas de terminal que alteram arquivos exigem writePaths declarados.");
        }
        break;
      case "git_status":
      case "git_diff":
        reads.push(params.cwd || ".");
        break;
      case "batch_operations": {
        const operations = params.operations;
        if (!Array.isArray(operations) || operations.length === 0 || operations.length > 50) {
          throw new Error("batch_operations exige de 1 a 50 operacoes.");
        }
        for (const [index, definition] of operations.entries()) {
          if (!definition || typeof definition !== "object" || !SUPPORTED_OPERATIONS.has(definition.operation) || definition.operation === "batch_operations") {
            throw new Error(`Operacao invalida no lote, indice ${index}.`);
          }
          const inferred = this.inferTaskPaths(
            team,
            definition.operation,
            definition.params || {},
            definition.readPaths || [],
            definition.writePaths || []
          );
          reads.push(...inferred.readPaths);
          writes.push(...inferred.writePaths);
        }
        break;
      }
      default:
        break;
    }

    const readPaths = unique(reads).map((filePath) => this.resolveProjectPath(team.projectRoot, filePath));
    const writePaths = unique(writes).map((filePath) => this.resolveProjectPath(team.projectRoot, filePath));
    return { readPaths, writePaths };
  }

  estimateDuration(operation, params = {}, explicitEstimate) {
    if (explicitEstimate !== undefined && explicitEstimate !== null) {
      const estimate = Math.round(Number(explicitEstimate));
      if (!Number.isFinite(estimate) || estimate < 1 || estimate > 600_000) {
        throw new Error("estimatedDurationMs deve estar entre 1 e 600000.");
      }
      return estimate;
    }
    if (operation === "batch_operations") {
      return Math.max(1, (params.operations || []).reduce(
        (total, definition) => total + this.estimateDuration(definition.operation, definition.params || {}, definition.estimatedDurationMs),
        0
      ));
    }
    return this.store.getOperationEstimate(operation)?.ewmaMs || DEFAULT_OPERATION_ESTIMATES_MS[operation] || 1000;
  }

  chooseWorker(teamId, virtualLoads = null) {
    const workers = this.store.listWorkers(teamId);
    if (workers.length === 0) throw new Error("Equipe sem workers.");
    return workers
      .map((worker) => ({
        worker,
        score: virtualLoads?.get(worker.id) ?? this.store.getWorkerProjectedLoad(worker.id)
      }))
      .sort((a, b) => a.score - b.score || a.worker.slot - b.worker.slot)[0].worker;
  }

  async assignTask(input) {
    return this.serializeMutation(() => this.assignTaskInternal(input));
  }

  async assignTaskInternal({
    teamId,
    workerId,
    operation,
    params = {},
    readPaths = [],
    writePaths = [],
    lockPolicy = "wait",
    timeoutMs,
    taskId = randomUUID(),
    clientTaskId = null,
    dependsOn = [],
    estimatedDurationMs,
    initialStatus,
    scheduler = {},
    skipDependencyValidation = false
  }) {
    const team = this.store.getTeam(teamId);
    if (!team || team.status !== "ativo") throw new Error("Equipe inexistente ou inativa.");
    if (!SUPPORTED_OPERATIONS.has(operation)) throw new Error(`Operacao nao suportada: ${operation}`);

    const estimate = this.estimateDuration(operation, params, estimatedDurationMs);
    const worker = workerId ? this.store.getWorker(workerId) : this.chooseWorker(teamId);
    if (!worker || worker.teamId !== teamId) throw new Error("Worker nao pertence a equipe.");
    if (!this.runtimes.has(worker.id)) throw new Error("Processo worker indisponivel.");

    const normalized = this.inferTaskPaths(team, operation, params, readPaths, writePaths);
    const dependencyTasks = dependsOn.map((dependencyId) => this.store.getTask(dependencyId));
    if (!skipDependencyValidation && dependencyTasks.some((dependency) => !dependency || dependency.teamId !== teamId)) {
      throw new Error("Dependencia inexistente ou pertencente a outra equipe.");
    }
    const dependencyFailed = dependencyTasks.some((dependency) => dependency && TERMINAL_TASK_STATES.has(dependency.status) && dependency.status !== "concluido");
    const hasPendingDependency = dependencyTasks.some((dependency) => dependency && dependency.status !== "concluido");
    const status = initialStatus || (dependencyFailed ? "cancelado" : hasPendingDependency ? "bloqueado" : "aguardando");
    const readyAt = status === "aguardando" ? Date.now() : null;
    const baseline = status === "aguardando" ? await snapshotPaths(normalized.writePaths) : {};
    const task = this.store.createTask({
      id: taskId,
      clientTaskId,
      teamId,
      workerId: worker.id,
      operation,
      params,
      readPaths: normalized.readPaths,
      writePaths: normalized.writePaths,
      lockPolicy,
      timeoutMs: Math.max(100, Number(timeoutMs || this.defaultTimeoutMs)),
      status,
      sequence: this.store.nextTaskSequence(teamId),
      queuedAt: Date.now(),
      readyAt,
      baseline,
      dependsOn,
      estimatedDurationMs: estimate,
      scheduler: {
        strategy: workerId ? "explicit_worker" : "least_estimated_load",
        estimatedDurationMs: estimate,
        ...scheduler
      }
    });

    if (dependencyFailed) {
      this.store.updateTask(task.id, {
        finishedAt: Date.now(),
        error: errorObject("dependency_failed", "Tarefa cancelada porque uma dependencia falhou.")
      });
    }

    this.addLog({
      teamId,
      workerId: worker.id,
      taskId: task.id,
      level: "info",
      event: status === "bloqueado" ? "task_blocked" : "task_queued",
      message: status === "bloqueado" ? "Tarefa aguardando dependencias." : "Tarefa adicionada a fila do worker.",
      data: { operation, readPaths: normalized.readPaths, writePaths: normalized.writePaths, lockPolicy, dependsOn, estimatedDurationMs: estimate }
    });

    if (status === "aguardando") {
      queueMicrotask(() => this.pumpWorker(worker.id).catch((error) => {
        this.logger?.error("Falha ao iniciar tarefa enfileirada.", { workerId: worker.id, taskId: task.id, error: error.message });
      }));
    }
    return this.store.getTask(task.id);
  }

  async runParallelTasks({ teamId, tasks, wait = false, waitTimeoutMs = 120_000 }) {
    return this.serializeMutation(async () => {
      const team = this.store.getTeam(teamId);
      if (!team || team.status !== "ativo") throw new Error("Equipe inexistente ou inativa.");
      if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("Informe ao menos uma tarefa.");
      const workers = this.store.listWorkers(teamId);
      const definitions = tasks.map((definition, index) => ({
        ...definition,
        index,
        clientTaskId: definition.id || `task-${index + 1}`,
        dependsOnClientIds: definition.dependsOn || [],
        taskId: randomUUID(),
        estimatedDurationMs: this.estimateDuration(definition.operation, definition.params || {}, definition.estimatedDurationMs)
      }));
      const byClientId = new Map();
      for (const definition of definitions) {
        if (byClientId.has(definition.clientTaskId)) throw new Error(`ID de tarefa duplicado: ${definition.clientTaskId}`);
        byClientId.set(definition.clientTaskId, definition);
      }
      for (const definition of definitions) {
        for (const dependencyId of definition.dependsOnClientIds) {
          if (!byClientId.has(dependencyId)) throw new Error(`Dependencia inexistente: ${dependencyId}`);
          if (dependencyId === definition.clientTaskId) throw new Error(`Tarefa nao pode depender de si mesma: ${dependencyId}`);
        }
      }

      // DFS valida ciclos antes que qualquer tarefa seja persistida.
      const visiting = new Set();
      const visited = new Set();
      const visit = (definition) => {
        if (visiting.has(definition.clientTaskId)) throw new Error(`Ciclo de dependencias detectado em: ${definition.clientTaskId}`);
        if (visited.has(definition.clientTaskId)) return;
        visiting.add(definition.clientTaskId);
        for (const dependencyId of definition.dependsOnClientIds) visit(byClientId.get(dependencyId));
        visiting.delete(definition.clientTaskId);
        visited.add(definition.clientTaskId);
      };
      for (const definition of definitions) visit(definition);

      const assigned = new Array(definitions.length);
      const virtualLoads = new Map(workers.map((worker) => [worker.id, this.store.getWorkerProjectedLoad(worker.id)]));
      const readyDefinitions = definitions
        .filter((definition) => definition.dependsOnClientIds.length === 0)
        .sort((left, right) => right.estimatedDurationMs - left.estimatedDurationMs || left.index - right.index);

      // LPT envia primeiro as tarefas longas para reduzir o makespan do lote.
      for (const definition of readyDefinitions) {
        const selected = definition.workerId ? this.store.getWorker(definition.workerId) : this.chooseWorker(teamId, virtualLoads);
        if (!selected || selected.teamId !== teamId) throw new Error("Worker nao pertence a equipe.");
        const loadBefore = virtualLoads.get(selected.id) || 0;
        virtualLoads.set(selected.id, loadBefore + definition.estimatedDurationMs);
        assigned[definition.index] = await this.assignTaskInternal({
          ...definition,
          id: undefined,
          teamId,
          workerId: selected.id,
          dependsOn: [],
          initialStatus: "aguardando",
          skipDependencyValidation: true,
          scheduler: {
            strategy: definition.workerId ? "explicit_worker" : "lpt_least_estimated_load",
            projectedLoadBeforeMs: loadBefore,
            projectedLoadAfterMs: loadBefore + definition.estimatedDurationMs,
            requestedWorkerId: definition.workerId || null
          }
        });
      }

      for (const definition of definitions.filter((item) => item.dependsOnClientIds.length > 0)) {
        const selected = definition.workerId ? this.store.getWorker(definition.workerId) : workers[0];
        if (!selected || selected.teamId !== teamId) throw new Error("Worker nao pertence a equipe.");
        assigned[definition.index] = await this.assignTaskInternal({
          ...definition,
          id: undefined,
          teamId,
          workerId: selected.id,
          dependsOn: definition.dependsOnClientIds.map((dependencyId) => byClientId.get(dependencyId).taskId),
          initialStatus: "bloqueado",
          skipDependencyValidation: true,
          scheduler: {
            strategy: "dependency_deferred",
            requestedWorkerId: definition.workerId || null
          }
        });
      }
      const result = { tasks: assigned };
      if (wait) {
        result.wait = await this.waitForTasks({ taskIds: assigned.map((task) => task.id), timeoutMs: waitTimeoutMs });
      }
      return result;
    });
  }

  releaseDependentTasks(teamId) {
    const next = this.dependencyReleaseChain.then(
      () => this.releaseDependentTasksInternal(teamId),
      () => this.releaseDependentTasksInternal(teamId)
    );
    this.dependencyReleaseChain = next.catch(() => {});
    return next;
  }

  async releaseDependentTasksInternal(teamId) {
    let transitioned = true;
    while (transitioned) {
      transitioned = false;
      const blockedTasks = this.store.listTasks(teamId, 5000).filter((task) => task.status === "bloqueado");
      for (const task of blockedTasks) {
        const dependencies = task.dependsOn.map((taskId) => this.store.getTask(taskId));
        const failed = dependencies.find((dependency) => !dependency || (TERMINAL_TASK_STATES.has(dependency.status) && dependency.status !== "concluido"));
        if (failed) {
          this.store.updateTask(task.id, {
            status: "cancelado",
            finishedAt: Date.now(),
            error: errorObject("dependency_failed", "Tarefa cancelada porque uma dependencia falhou.", { dependencyTaskId: failed?.id || null })
          });
          this.addLog({ teamId, workerId: task.workerId, taskId: task.id, level: "warn", event: "dependency_failed", message: "Tarefa dependente cancelada.", data: { dependencyTaskId: failed?.id || null } });
          transitioned = true;
          continue;
        }
        if (dependencies.length > 0 && dependencies.every((dependency) => dependency.status === "concluido")) {
          const requestedWorkerId = task.scheduler?.requestedWorkerId;
          const selected = requestedWorkerId ? this.store.getWorker(requestedWorkerId) : this.chooseWorker(teamId);
          const readyAt = Date.now();
          const baseline = await snapshotPaths(task.writePaths);
          const projectedLoadBeforeMs = this.store.getWorkerProjectedLoad(selected.id);
          this.store.updateTask(task.id, {
            workerId: selected.id,
            status: "aguardando",
            readyAt,
            baseline,
            scheduler: {
              ...task.scheduler,
              strategy: requestedWorkerId ? "dependency_ready_explicit" : "dependency_ready_least_estimated_load",
              projectedLoadBeforeMs,
              projectedLoadAfterMs: projectedLoadBeforeMs + task.estimatedDurationMs
            }
          });
          this.addLog({ teamId, workerId: selected.id, taskId: task.id, level: "info", event: "dependencies_satisfied", message: "Dependencias concluidas; tarefa liberada.", data: { dependsOn: task.dependsOn } });
          queueMicrotask(() => this.pumpWorker(selected.id).catch(() => {}));
          transitioned = true;
        }
      }
    }
  }

  async pumpWorker(workerId) {
    const runtime = this.runtimes.get(workerId);
    if (!runtime || !runtime.ready || runtime.currentTaskId || runtime.closing || runtime.pumping) return;
    // Mais de um evento pode pedir o bombeamento simultaneamente; apenas um pode despachar.
    runtime.pumping = true;
    try {
    const worker = this.store.getWorker(workerId);
    const team = this.store.getTeam(worker.teamId);
    if (!team || team.status !== "ativo") return;

    const task = this.store.getNextQueuedTask(workerId);
    if (!task) return;
    if (task.cancelRequested) {
      this.store.updateTask(task.id, { status: "cancelado", finishedAt: Date.now(), error: errorObject("canceled", "Tarefa cancelada antes da execucao.") });
      await this.releaseDependentTasks(task.teamId);
      queueMicrotask(() => this.pumpWorker(workerId).catch(() => {}));
      return;
    }

    const lockResult = this.store.acquireLocks({
      readPaths: task.readPaths,
      writePaths: task.writePaths,
      teamId: task.teamId,
      workerId,
      taskId: task.id,
      ttlMs: this.lockTtlMs
    });

    if (!lockResult.acquired) {
      if (task.lockPolicy === "reject") {
        this.store.updateTask(task.id, {
          status: "erro",
          finishedAt: Date.now(),
          error: errorObject("file_lock_conflict", "Caminho bloqueado por outro worker.", lockResult.conflict)
        });
        await this.releaseDependentTasks(task.teamId);
        this.addLog({ teamId: task.teamId, workerId, taskId: task.id, level: "error", event: "lock_rejected", message: "Tarefa recusada por conflito de bloqueio.", data: lockResult.conflict });
        queueMicrotask(() => this.pumpWorker(workerId).catch(() => {}));
        return;
      }

      if (!this.retryTimers.has(workerId)) {
        this.addLog({ teamId: task.teamId, workerId, taskId: task.id, level: "info", event: "lock_wait", message: "Tarefa aguardando liberacao de arquivo.", data: lockResult.conflict });
        const timer = setTimeout(() => {
          this.retryTimers.delete(workerId);
          this.pumpWorker(workerId).catch(() => {});
        }, 150);
        this.retryTimers.set(workerId, timer);
      }
      return;
    }

    const actual = await snapshotPaths(task.writePaths);
    const changes = findSnapshotChanges(task.baseline, actual);
    if (changes.length > 0) {
      this.store.releaseLocks(task.id);
      this.store.updateTask(task.id, {
        status: "erro",
        finishedAt: Date.now(),
        error: errorObject("file_changed_before_execution", "Arquivo mudou depois da atribuicao; releitura obrigatoria.", changes)
      });
      await this.releaseDependentTasks(task.teamId);
      this.store.updateWorker(workerId, { status: "erro", currentTaskId: null, error: errorObject("file_changed_before_execution", "Arquivo mudou antes da execucao.") });
      this.addLog({ teamId: task.teamId, workerId, taskId: task.id, level: "error", event: "external_change_detected", message: "Alteracao externa detectada antes da escrita.", data: changes });
      queueMicrotask(() => this.pumpWorker(workerId).catch(() => {}));
      return;
    }

    runtime.currentTaskId = task.id;
    this.store.updateTask(task.id, { status: "executando", startedAt: Date.now() });
    this.store.updateWorker(workerId, { status: "executando", currentTaskId: task.id, error: null });
    runtime.lockRenewal = setInterval(() => {
      const renewed = this.store.renewLocks(task.id, this.lockTtlMs);
      if (renewed > 0) {
        this.store.addLog({ teamId: task.teamId, workerId, taskId: task.id, level: "info", event: "lock_renewed", message: "Bloqueio de arquivo renovado.", data: { renewed } });
      }
    }, Math.max(100, Math.floor(this.lockTtlMs / 3)));

    this.addLog({ teamId: task.teamId, workerId, taskId: task.id, level: "info", event: "task_dispatched", message: "Tarefa enviada ao processo worker.", data: { operation: task.operation } });
    runtime.child.send({
      type: "execute",
      task: {
        id: task.id,
        operation: task.operation,
        params: task.params,
        projectRoot: team.projectRoot,
        readPaths: task.readPaths,
        writePaths: task.writePaths,
        expectedSnapshots: actual,
        timeoutMs: task.timeoutMs
      }
    });
    } finally {
      runtime.pumping = false;
    }
  }

  async completeTaskFromWorker(workerId, message) {
    const runtime = this.runtimes.get(workerId);
    if (!runtime) return;
    if (runtime.lockRenewal) {
      clearInterval(runtime.lockRenewal);
      runtime.lockRenewal = null;
    }

    const task = this.store.getTask(message.taskId);
    if (!task) return;
    this.store.releaseLocks(task.id);

    const rawResult = message.result ? { ...message.result } : null;
    const after = rawResult?.after || {};
    if (rawResult && "after" in rawResult) delete rawResult.after;
    const status = ["concluido", "erro", "cancelado", "timeout"].includes(message.status) ? message.status : "erro";
    this.store.updateTask(task.id, {
      status,
      startedAt: message.startedAt || task.startedAt,
      finishedAt: message.finishedAt || Date.now(),
      result: rawResult,
      error: message.error || null,
      after
    });
    if (task.writePaths.length > 0) {
      const team = this.store.getTeam(task.teamId);
      if (team) this.codeIntelligence.invalidate(team.projectRoot, task.writePaths);
    }
    if (status === "concluido" && message.finishedAt && (message.startedAt || task.startedAt)) {
      this.store.recordOperationDuration(task.operation, message.finishedAt - (message.startedAt || task.startedAt));
    }

    runtime.currentTaskId = null;
    const workerStatus = status === "concluido" ? "concluido" : "erro";
    this.store.updateWorker(workerId, {
      status: workerStatus,
      currentTaskId: null,
      error: status === "concluido" ? null : message.error || errorObject(status, `Tarefa terminou como ${status}.`)
    });
    this.addLog({
      teamId: task.teamId,
      workerId,
      taskId: task.id,
      level: status === "concluido" ? "info" : "error",
      event: "task_finished",
      message: `Tarefa finalizada: ${status}.`,
      data: { status, result: rawResult, error: message.error || null }
    });

    await this.releaseDependentTasks(task.teamId);

    const next = this.store.getNextQueuedTask(workerId);
    if (next) {
      this.store.updateWorker(workerId, { status: "aguardando", error: null });
      queueMicrotask(() => this.pumpWorker(workerId).catch(() => {}));
    }
  }

  getTeamStatus(teamId) {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error("Equipe nao encontrada.");
    const workers = this.store.listWorkers(teamId).map((worker) => ({
      ...worker,
      queuedTasks: this.store.countQueuedTasks(worker.id),
      projectedLoadMs: this.store.getWorkerProjectedLoad(worker.id),
      currentTask: worker.currentTaskId ? this.store.getTask(worker.currentTaskId) : null
    }));
    const tasks = this.store.listTasks(teamId, 200);
    const summary = tasks.reduce((acc, task) => {
      acc[task.status] = (acc[task.status] || 0) + 1;
      return acc;
    }, {});
    const completed = tasks.filter((task) => task.status === "concluido" && task.startedAt && task.finishedAt);
    const scheduler = {
      strategy: "LPT + menor carga estimada (EWMA)",
      operationStats: this.store.listOperationStats(),
      completedTasks: completed.length,
      averageExecutionMs: completed.length
        ? Math.round(completed.reduce((total, task) => total + task.finishedAt - task.startedAt, 0) / completed.length)
        : 0,
      averageReadyQueueMs: completed.length
        ? Math.round(completed.reduce((total, task) => total + task.startedAt - (task.readyAt || task.queuedAt), 0) / completed.length)
        : 0
    };
    return { team, workers, taskSummary: summary, locks: this.store.getLocks({ teamId }), scheduler };
  }

  getWorkerStatus({ teamId, workerId }) {
    const worker = this.store.getWorker(workerId);
    if (!worker || worker.teamId !== teamId) throw new Error("Worker nao encontrado na equipe.");
    const queued = this.store.listTasks(teamId, 500).filter((task) => task.workerId === workerId && task.status === "aguardando");
    return {
      worker,
      currentTask: worker.currentTaskId ? this.store.getTask(worker.currentTaskId) : null,
      queuedTasks: queued,
      recentTasks: this.store.listTasks(teamId, 100).filter((task) => task.workerId === workerId).slice(0, 20)
    };
  }

  getLogs(input) {
    return this.store.getLogs(input);
  }

  getTaskResult(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Tarefa nao encontrada.");
    return task;
  }

  async cancelTask(taskId, reason = "Cancelado pelo coordenador.") {
    return this.serializeMutation(async () => {
      const task = this.store.getTask(taskId);
      if (!task) throw new Error("Tarefa nao encontrada.");
      if (TERMINAL_TASK_STATES.has(task.status)) return task;

      this.store.updateTask(taskId, { cancelRequested: true });
      if (task.status === "aguardando" || task.status === "bloqueado") {
        this.store.updateTask(taskId, {
          status: "cancelado",
          finishedAt: Date.now(),
          error: errorObject("canceled", reason),
          cancelRequested: true
        });
        this.store.releaseLocks(taskId);
        this.addLog({ teamId: task.teamId, workerId: task.workerId, taskId, level: "warn", event: "task_canceled", message: reason, data: null });
        await this.releaseDependentTasks(task.teamId);
        queueMicrotask(() => this.pumpWorker(task.workerId).catch(() => {}));
        return this.store.getTask(taskId);
      }

      const runtime = this.runtimes.get(task.workerId);
      runtime?.child.send({ type: "cancel", taskId, reason: "cancelado" });
      this.addLog({ teamId: task.teamId, workerId: task.workerId, taskId, level: "warn", event: "cancel_requested", message: reason, data: null });
      return this.store.getTask(taskId);
    });
  }

  async sendInstruction({ teamId, workerId, taskId = null, message, operation = null, params = {}, readPaths = [], writePaths = [], lockPolicy = "wait", timeoutMs }) {
    const worker = this.store.getWorker(workerId);
    if (!worker || worker.teamId !== teamId) throw new Error("Worker nao encontrado na equipe.");
    const messageId = this.store.addMessage({ teamId, workerId, taskId, message, operation, params, createdAt: Date.now() });
    this.addLog({ teamId, workerId, taskId, level: "info", event: "instruction_sent", message, data: { operation } });
    this.runtimes.get(workerId)?.child.send({ type: "instruction", taskId, message, data: { operation } });

    let followupTask = null;
    if (operation) {
      followupTask = await this.assignTask({ teamId, workerId, operation, params, readPaths, writePaths, lockPolicy, timeoutMs });
    }
    return { messageId, followupTask };
  }

  async waitForTasks({ taskIds, timeoutMs = 120_000, pollMs = 50 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const tasks = taskIds.map((taskId) => this.store.getTask(taskId)).filter(Boolean);
      if (tasks.length === taskIds.length && tasks.every((task) => TERMINAL_TASK_STATES.has(task.status))) {
        return { completed: true, timedOut: false, tasks };
      }
      await delay(Math.max(10, pollMs));
    }
    return {
      completed: false,
      timedOut: true,
      tasks: taskIds.map((taskId) => this.store.getTask(taskId)).filter(Boolean)
    };
  }

  async closeTeam(teamId) {
    return this.serializeMutation(() => this.closeTeamInternal(teamId));
  }

  async closeTeamInternal(teamId, { reason = "Equipe encerrada.", preserveTeamError = false } = {}) {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error("Equipe nao encontrada.");
    if (team.status === "fechado") return this.getTeamStatus(teamId);
    this.store.updateTeam(teamId, { status: "fechando" });

    const tasks = this.store.listTasks(teamId, 1000);
    for (const task of tasks) {
      if (!TERMINAL_TASK_STATES.has(task.status)) {
        if (task.status === "executando") {
          const runtime = this.runtimes.get(task.workerId);
          runtime?.child.send({ type: "cancel", taskId: task.id, reason: "cancelado" });
        } else {
          this.store.updateTask(task.id, {
            status: "cancelado",
            finishedAt: Date.now(),
            error: errorObject("team_closed", reason),
            cancelRequested: true
          });
        }
      }
    }

    const workers = this.store.listWorkers(teamId);
    await Promise.all(workers.map(async (worker) => {
      const runtime = this.runtimes.get(worker.id);
      if (!runtime) {
        this.store.updateWorker(worker.id, { status: "parado", pid: null, currentTaskId: null });
        return;
      }
      runtime.closing = true;
      if (runtime.lockRenewal) clearInterval(runtime.lockRenewal);
      const exitPromise = new Promise((resolve) => runtime.child.once("exit", resolve));
      runtime.child.send({ type: "shutdown" });
      await Promise.race([exitPromise, delay(3000)]);
      if (runtime.child.exitCode === null) runtime.child.kill("SIGTERM");
      this.store.updateWorker(worker.id, { status: "parado", pid: null, currentTaskId: null, error: null });
    }));

    this.store.releaseTeamLocks(teamId);
    this.store.updateTeam(teamId, {
      status: preserveTeamError ? "erro" : "fechado",
      closedAt: Date.now(),
      error: preserveTeamError ? this.store.getTeam(teamId).error : null
    });
    this.addLog({ teamId, level: "info", event: "team_closed", message: reason, data: null });
    const sharedActiveProject = this.store.listTeams(10_000).some((candidate) => candidate.id !== teamId && candidate.status === "ativo" && candidate.projectRoot === team.projectRoot);
    if (!sharedActiveProject) await this.codeIntelligence.disposeProject(team.projectRoot);
    return this.getTeamStatus(teamId);
  }

  getOverview() {
    const teams = this.store.listTeams(20);
    const activeTeams = teams.filter((team) => team.status === "ativo");
    return {
      databasePath: this.databasePath,
      workerCountPerTeam: this.workerCount,
      codeIntelligence: this.codeIntelligence.getStatus(),
      activeTeams: activeTeams.map((team) => this.getTeamStatus(team.id)),
      recentTeams: teams
    };
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    const activeTeamIds = this.store.listTeams(100).filter((team) => team.status === "ativo" || team.status === "fechando").map((team) => team.id);
    for (const teamId of activeTeamIds) {
      await this.closeTeamInternal(teamId, { reason: "Coordenador encerrado." }).catch(() => {});
    }
    this.store.close();
    await this.codeIntelligence.close();
  }
}

export { PROJECT_HISTORY_CLEANUP_INTERVAL_MS, SUPPORTED_OPERATIONS };
