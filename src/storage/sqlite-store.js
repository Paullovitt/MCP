import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const TERMINAL_TASK_STATES = new Set(["concluido", "erro", "cancelado", "timeout"]);

function now() {
  return Date.now();
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parse(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapTeam(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    projectRoot: row.project_root,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    error: parse(row.error_json)
  };
}

function mapWorker(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    slot: row.slot,
    status: row.status,
    pid: row.pid,
    currentTaskId: row.current_task_id,
    directory: row.directory,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: parse(row.error_json)
  };
}

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientTaskId: row.client_task_id || null,
    teamId: row.team_id,
    workerId: row.worker_id,
    operation: row.operation,
    params: parse(row.params_json, {}),
    readPaths: parse(row.read_paths_json, []),
    writePaths: parse(row.write_paths_json, []),
    lockPolicy: row.lock_policy,
    timeoutMs: row.timeout_ms,
    status: row.status,
    sequence: row.sequence,
    queuedAt: row.queued_at,
    readyAt: row.ready_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelRequested: Boolean(row.cancel_requested),
    baseline: parse(row.baseline_json, {}),
    after: parse(row.after_json, {}),
    result: parse(row.result_json),
    error: parse(row.error_json),
    dependsOn: parse(row.depends_on_json, []),
    estimatedDurationMs: row.estimated_duration_ms,
    scheduler: parse(row.scheduler_json, {})
  };
}

function mapLog(row) {
  return {
    id: row.id,
    teamId: row.team_id,
    workerId: row.worker_id,
    taskId: row.task_id,
    level: row.level,
    event: row.event,
    message: row.message,
    data: parse(row.data_json),
    createdAt: row.created_at
  };
}

function mapLock(row) {
  return {
    id: row.id,
    path: row.path,
    mode: row.mode,
    teamId: row.team_id,
    workerId: row.worker_id,
    taskId: row.task_id,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at
  };
}

// Compara caminhos por hierarquia para impedir conflitos entre uma pasta e seus descendentes.
function normalizeLockPath(filePath) {
  const resolved = path.normalize(path.resolve(filePath));
  const root = path.parse(resolved).root;
  const withoutTrailingSeparator = resolved === root ? resolved : resolved.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

function pathsOverlap(leftPath, rightPath) {
  const left = normalizeLockPath(leftPath);
  const right = normalizeLockPath(rightPath);
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

export class CoordinatorStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    // Sobrescreve o conteudo de registros apagados em vez de apenas marcar paginas como livres.
    this.db.exec("PRAGMA secure_delete = ON;");
    this.initialize();
    this.recoverInterruptedState();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_root TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        error_json TEXT
      );

      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        slot INTEGER NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        current_task_id TEXT,
        directory TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error_json TEXT,
        FOREIGN KEY(team_id) REFERENCES teams(id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        params_json TEXT NOT NULL,
        read_paths_json TEXT NOT NULL,
        write_paths_json TEXT NOT NULL,
        lock_policy TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        baseline_json TEXT,
        after_json TEXT,
        result_json TEXT,
        error_json TEXT,
        FOREIGN KEY(team_id) REFERENCES teams(id),
        FOREIGN KEY(worker_id) REFERENCES workers(id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        worker_id TEXT,
        task_id TEXT,
        message TEXT NOT NULL,
        operation TEXT,
        params_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT,
        worker_id TEXT,
        task_id TEXT,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_locks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('read', 'write')),
        team_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        renewed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE(path, task_id)
      );

      CREATE TABLE IF NOT EXISTS operation_stats (
        operation TEXT PRIMARY KEY,
        sample_count INTEGER NOT NULL,
        ewma_ms REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workers_team ON workers(team_id, slot);
      CREATE INDEX IF NOT EXISTS idx_tasks_worker_queue ON tasks(worker_id, status, sequence);
      CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id, queued_at);
      CREATE INDEX IF NOT EXISTS idx_logs_lookup ON logs(team_id, worker_id, task_id, id);
    `);

    this.migrateSchema();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_locks_team ON file_locks(team_id);
      CREATE INDEX IF NOT EXISTS idx_locks_path ON file_locks(path, mode);
      CREATE INDEX IF NOT EXISTS idx_tasks_dependencies ON tasks(team_id, status);
    `);
  }

  migrateSchema() {
    const taskColumns = new Set(this.db.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name));
    const additions = [
      ["client_task_id", "TEXT"],
      ["depends_on_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["estimated_duration_ms", "INTEGER NOT NULL DEFAULT 1000"],
      ["scheduler_json", "TEXT"],
      ["ready_at", "INTEGER"]
    ];
    for (const [column, declaration] of additions) {
      if (!taskColumns.has(column)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${declaration};`);
    }

    const lockColumns = new Set(this.db.prepare("PRAGMA table_info(file_locks)").all().map((column) => column.name));
    if (!lockColumns.has("mode") || !lockColumns.has("id")) {
      // Bloqueios sao efemeros; a recuperacao de inicializacao tambem os removeria.
      this.db.exec(`
        DROP TABLE file_locks;
        CREATE TABLE file_locks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL,
          mode TEXT NOT NULL CHECK(mode IN ('read', 'write')),
          team_id TEXT NOT NULL,
          worker_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          renewed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          UNIQUE(path, task_id)
        );
      `);
    }
  }

  recoverInterruptedState() {
    const timestamp = now();
    const interruption = json({ code: "server_restarted", message: "Execucao interrompida por reinicio do coordenador." });
    this.db.prepare(`
      UPDATE tasks
      SET status = 'erro', finished_at = ?, error_json = ?
      WHERE status IN ('bloqueado', 'aguardando', 'executando')
    `).run(timestamp, interruption);
    this.db.prepare(`
      UPDATE workers
      SET status = 'parado', pid = NULL, current_task_id = NULL, updated_at = ?, error_json = ?
      WHERE status != 'parado'
    `).run(timestamp, interruption);
    this.db.prepare(`
      UPDATE teams
      SET status = 'interrompido', error_json = ?
      WHERE status IN ('ativo', 'fechando')
    `).run(interruption);
    this.db.exec("DELETE FROM file_locks;");
  }

  close() {
    this.db.close();
  }

  createTeam(team) {
    this.db.prepare(`
      INSERT INTO teams (id, name, project_root, status, created_at, closed_at, error_json)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
    `).run(team.id, team.name, team.projectRoot, team.status, team.createdAt);
    return this.getTeam(team.id);
  }

  updateTeam(teamId, patch) {
    const current = this.getTeam(teamId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db.prepare(`
      UPDATE teams SET name = ?, project_root = ?, status = ?, closed_at = ?, error_json = ? WHERE id = ?
    `).run(next.name, next.projectRoot, next.status, next.closedAt ?? null, json(next.error), teamId);
    return this.getTeam(teamId);
  }

  getTeam(teamId) {
    return mapTeam(this.db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId));
  }

  listTeams(limit = 100) {
    return this.db.prepare("SELECT * FROM teams ORDER BY created_at DESC LIMIT ?").all(limit).map(mapTeam);
  }

  deleteTeamHistory(teamId) {
    const deleted = {};
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      // A ordem respeita as chaves estrangeiras e remove todo dado identificavel do projeto.
      deleted.locks = this.db.prepare("DELETE FROM file_locks WHERE team_id = ?").run(teamId).changes;
      deleted.messages = this.db.prepare("DELETE FROM messages WHERE team_id = ?").run(teamId).changes;
      deleted.logs = this.db.prepare("DELETE FROM logs WHERE team_id = ?").run(teamId).changes;
      deleted.tasks = this.db.prepare("DELETE FROM tasks WHERE team_id = ?").run(teamId).changes;
      deleted.workers = this.db.prepare("DELETE FROM workers WHERE team_id = ?").run(teamId).changes;
      deleted.teams = this.db.prepare("DELETE FROM teams WHERE id = ?").run(teamId).changes;
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    // Trunca o WAL para que copias antigas das paginas nao permaneçam no arquivo auxiliar.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    return deleted;
  }

  createWorker(worker) {
    this.db.prepare(`
      INSERT INTO workers (id, team_id, slot, status, pid, current_task_id, directory, created_at, updated_at, error_json)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
    `).run(worker.id, worker.teamId, worker.slot, worker.status, worker.pid ?? null, worker.directory, worker.createdAt, worker.updatedAt);
    return this.getWorker(worker.id);
  }

  updateWorker(workerId, patch) {
    const current = this.getWorker(workerId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? now() };
    this.db.prepare(`
      UPDATE workers
      SET status = ?, pid = ?, current_task_id = ?, directory = ?, updated_at = ?, error_json = ?
      WHERE id = ?
    `).run(next.status, next.pid ?? null, next.currentTaskId ?? null, next.directory, next.updatedAt, json(next.error), workerId);
    return this.getWorker(workerId);
  }

  getWorker(workerId) {
    return mapWorker(this.db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId));
  }

  listWorkers(teamId) {
    return this.db.prepare("SELECT * FROM workers WHERE team_id = ? ORDER BY slot").all(teamId).map(mapWorker);
  }

  createTask(task) {
    this.db.prepare(`
      INSERT INTO tasks (
        id, team_id, worker_id, operation, params_json, read_paths_json, write_paths_json,
        lock_policy, timeout_ms, status, sequence, queued_at, started_at, finished_at,
        cancel_requested, baseline_json, after_json, result_json, error_json, client_task_id,
        depends_on_json, estimated_duration_ms, scheduler_json, ready_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.teamId,
      task.workerId,
      task.operation,
      json(task.params),
      json(task.readPaths),
      json(task.writePaths),
      task.lockPolicy,
      task.timeoutMs,
      task.status,
      task.sequence,
      task.queuedAt,
      json(task.baseline),
      task.clientTaskId ?? null,
      json(task.dependsOn || []),
      task.estimatedDurationMs,
      json(task.scheduler || {}),
      task.readyAt ?? null
    );
    return this.getTask(task.id);
  }

  updateTask(taskId, patch) {
    const current = this.getTask(taskId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db.prepare(`
      UPDATE tasks SET
        worker_id = ?, operation = ?, params_json = ?, read_paths_json = ?, write_paths_json = ?,
        lock_policy = ?, timeout_ms = ?, status = ?, sequence = ?, queued_at = ?, started_at = ?,
        finished_at = ?, cancel_requested = ?, baseline_json = ?, after_json = ?, result_json = ?, error_json = ?,
        client_task_id = ?, depends_on_json = ?, estimated_duration_ms = ?, scheduler_json = ?, ready_at = ?
      WHERE id = ?
    `).run(
      next.workerId,
      next.operation,
      json(next.params),
      json(next.readPaths),
      json(next.writePaths),
      next.lockPolicy,
      next.timeoutMs,
      next.status,
      next.sequence,
      next.queuedAt,
      next.startedAt ?? null,
      next.finishedAt ?? null,
      next.cancelRequested ? 1 : 0,
      json(next.baseline),
      json(next.after),
      json(next.result),
      json(next.error),
      next.clientTaskId ?? null,
      json(next.dependsOn || []),
      next.estimatedDurationMs,
      json(next.scheduler || {}),
      next.readyAt ?? null,
      taskId
    );
    return this.getTask(taskId);
  }

  getTask(taskId) {
    return mapTask(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
  }

  getNextQueuedTask(workerId) {
    return mapTask(this.db.prepare(`
      SELECT * FROM tasks WHERE worker_id = ? AND status = 'aguardando' ORDER BY sequence LIMIT 1
    `).get(workerId));
  }

  listTasks(teamId, limit = 500) {
    return this.db.prepare("SELECT * FROM tasks WHERE team_id = ? ORDER BY sequence DESC LIMIT ?").all(teamId, limit).map(mapTask);
  }

  countQueuedTasks(workerId) {
    return this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE worker_id = ? AND status = 'aguardando'").get(workerId).count;
  }

  getWorkerProjectedLoad(workerId, timestamp = now()) {
    const rows = this.db.prepare(`
      SELECT status, estimated_duration_ms, started_at
      FROM tasks
      WHERE worker_id = ? AND status IN ('aguardando', 'executando')
    `).all(workerId);
    return Math.round(rows.reduce((total, row) => {
      const estimate = Math.max(1, Number(row.estimated_duration_ms || 1000));
      if (row.status === "executando") {
        return total + Math.max(25, estimate - Math.max(0, timestamp - Number(row.started_at || timestamp)));
      }
      return total + estimate;
    }, 0));
  }

  getOperationEstimate(operation) {
    const row = this.db.prepare("SELECT * FROM operation_stats WHERE operation = ?").get(operation);
    return row ? { operation: row.operation, sampleCount: row.sample_count, ewmaMs: Math.round(row.ewma_ms), updatedAt: row.updated_at } : null;
  }

  listOperationStats() {
    return this.db.prepare("SELECT * FROM operation_stats ORDER BY operation").all().map((row) => ({
      operation: row.operation,
      sampleCount: row.sample_count,
      ewmaMs: Math.round(row.ewma_ms),
      updatedAt: row.updated_at
    }));
  }

  recordOperationDuration(operation, durationMs) {
    const measured = Math.max(1, Math.round(Number(durationMs)));
    const current = this.getOperationEstimate(operation);
    const sampleCount = (current?.sampleCount || 0) + 1;
    // EWMA reage a mudancas recentes sem descartar o historico de execucao.
    const ewmaMs = current ? (current.ewmaMs * 0.7) + (measured * 0.3) : measured;
    this.db.prepare(`
      INSERT INTO operation_stats (operation, sample_count, ewma_ms, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(operation) DO UPDATE SET
        sample_count = excluded.sample_count,
        ewma_ms = excluded.ewma_ms,
        updated_at = excluded.updated_at
    `).run(operation, sampleCount, ewmaMs, now());
    return this.getOperationEstimate(operation);
  }

  nextTaskSequence(teamId) {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM tasks WHERE team_id = ?").get(teamId);
    return Number(row.next);
  }

  addMessage(message) {
    const result = this.db.prepare(`
      INSERT INTO messages (team_id, worker_id, task_id, message, operation, params_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.teamId,
      message.workerId ?? null,
      message.taskId ?? null,
      message.message,
      message.operation ?? null,
      json(message.params),
      message.createdAt ?? now()
    );
    return Number(result.lastInsertRowid);
  }

  addLog(log) {
    const result = this.db.prepare(`
      INSERT INTO logs (team_id, worker_id, task_id, level, event, message, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.teamId ?? null,
      log.workerId ?? null,
      log.taskId ?? null,
      log.level ?? "info",
      log.event,
      log.message,
      json(log.data),
      log.createdAt ?? now()
    );
    return Number(result.lastInsertRowid);
  }

  getLogs({ teamId, workerId, taskId, limit = 200 }) {
    const clauses = [];
    const values = [];
    if (teamId) {
      clauses.push("team_id = ?");
      values.push(teamId);
    }
    if (workerId) {
      clauses.push("worker_id = ?");
      values.push(workerId);
    }
    if (taskId) {
      clauses.push("task_id = ?");
      values.push(taskId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    values.push(limit);
    return this.db.prepare(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ?`).all(...values).map(mapLog).reverse();
  }

  cleanupExpiredLocks(timestamp = now()) {
    return this.db.prepare("DELETE FROM file_locks WHERE expires_at <= ?").run(timestamp).changes;
  }

  acquireLocks({ readPaths = [], writePaths = [], teamId, workerId, taskId, ttlMs }) {
    const requestsByPath = new Map();
    for (const filePath of readPaths) requestsByPath.set(normalizeLockPath(filePath), "read");
    for (const filePath of writePaths) requestsByPath.set(normalizeLockPath(filePath), "write");
    const requests = [...requestsByPath].map(([filePath, mode]) => ({ path: filePath, mode })).sort((a, b) => a.path.localeCompare(b.path));
    if (requests.length === 0) {
      return { acquired: true, locks: [], conflict: null };
    }

    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare("DELETE FROM file_locks WHERE expires_at <= ?").run(timestamp);
      const activeLocks = this.db.prepare("SELECT * FROM file_locks WHERE task_id != ?").all(taskId);
      for (const request of requests) {
        const existing = activeLocks.find((lock) => pathsOverlap(request.path, lock.path) && (request.mode === "write" || lock.mode === "write"));
        if (existing) {
          this.db.exec("ROLLBACK;");
          return { acquired: false, locks: [], conflict: { requested: request, existing: mapLock(existing) } };
        }
      }

      this.db.prepare("DELETE FROM file_locks WHERE task_id = ?").run(taskId);
      const statement = this.db.prepare(`
        INSERT INTO file_locks (path, mode, team_id, worker_id, task_id, acquired_at, renewed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const request of requests) {
        statement.run(request.path, request.mode, teamId, workerId, taskId, timestamp, timestamp, timestamp + ttlMs);
      }
      this.db.exec("COMMIT;");
      return { acquired: true, locks: this.getLocks({ taskId }), conflict: null };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  renewLocks(taskId, ttlMs) {
    const timestamp = now();
    return this.db.prepare(`
      UPDATE file_locks SET renewed_at = ?, expires_at = ? WHERE task_id = ?
    `).run(timestamp, timestamp + ttlMs, taskId).changes;
  }

  releaseLocks(taskId) {
    return this.db.prepare("DELETE FROM file_locks WHERE task_id = ?").run(taskId).changes;
  }

  releaseTeamLocks(teamId) {
    return this.db.prepare("DELETE FROM file_locks WHERE team_id = ?").run(teamId).changes;
  }

  getLocks({ teamId, taskId } = {}) {
    const clauses = [];
    const values = [];
    if (teamId) {
      clauses.push("team_id = ?");
      values.push(teamId);
    }
    if (taskId) {
      clauses.push("task_id = ?");
      values.push(taskId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM file_locks ${where} ORDER BY path`).all(...values).map(mapLock);
  }

  isTaskTerminal(taskId) {
    const task = this.getTask(taskId);
    return task ? TERMINAL_TASK_STATES.has(task.status) : true;
  }
}

export { TERMINAL_TASK_STATES, normalizeLockPath, pathsOverlap };
