import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  applyExactPatch,
  copyPath,
  createDirectory,
  deletePath,
  listFiles,
  movePath,
  readFileText,
  searchFiles,
  writeFileText
} from "./tools/filesystem.js";
import { runShellCommand } from "./tools/shell.js";
import { gitDiff, gitStatus } from "./tools/git.js";
import { captureBrowserScreenshot } from "./tools/browser.js";
import { projectOverview } from "./tools/project.js";
import { killProcess, listProcesses, startProcess } from "./tools/process.js";
import { npmInstall } from "./tools/package-manager.js";
import { createOAuthRouter, getOAuthChallenge, isValidOAuthAccessToken } from "./oauth.js";
import { mountUiRoutes } from "./ui-server.js";

function jsonToolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
}

const pathEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["directory", "file"])
});

const commandResultOutputSchema = {
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number()
};

const projectOverviewOutputSchema = {
  projectRoot: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  license: z.string().nullable(),
  packageManager: z.string(),
  scripts: z.record(z.string()),
  dependencies: z.record(z.string()),
  devDependencies: z.record(z.string()),
  rootEntries: z.array(pathEntrySchema),
  readme: z.object({ exists: z.boolean(), truncated: z.boolean(), preview: z.string() }),
  git: z.object({ available: z.boolean(), status: z.string(), error: z.string().nullable() }),
  mainFiles: z.array(z.string())
};

const listFilesOutputSchema = {
  root: z.string(),
  count: z.number(),
  entries: z.array(pathEntrySchema)
};

const readFileOutputSchema = {
  path: z.string(),
  truncated: z.boolean(),
  content: z.string()
};

const writeFileOutputSchema = {
  path: z.string(),
  bytes: z.number(),
  createdDirectories: z.boolean()
};

const createDirectoryOutputSchema = { path: z.string(), recursive: z.boolean() };
const deletePathOutputSchema = { path: z.string(), type: z.enum(["directory", "file"]), recursive: z.boolean(), force: z.boolean() };
const movePathOutputSchema = { source: z.string(), destination: z.string(), overwritten: z.boolean() };
const copyPathOutputSchema = {
  source: z.string(),
  destination: z.string(),
  type: z.enum(["directory", "file"]),
  recursive: z.boolean(),
  overwritten: z.boolean()
};
const searchFilesOutputSchema = {
  query: z.string(),
  count: z.number(),
  matches: z.array(z.object({ path: z.string(), line: z.number(), column: z.number(), text: z.string() }))
};
const applyPatchOutputSchema = { path: z.string(), backupPath: z.string().nullable(), replacements: z.number() };
const startProcessOutputSchema = { pid: z.number().optional(), cwd: z.string(), command: z.string(), detached: z.boolean() };
const listProcessesOutputSchema = {
  ...commandResultOutputSchema,
  processes: z.union([z.array(z.unknown()), z.record(z.unknown())]).optional()
};
const browserScreenshotOutputSchema = {
  browser: z.string(),
  executable: z.string(),
  outputPath: z.string(),
  fileUrl: z.string(),
  bytes: z.number(),
  commandExitCode: z.number().nullable(),
  stderr: z.string()
};
const dataOutputSchema = { data: z.unknown() };

function registerJsonTool(server, name, description, inputSchema, outputSchema, annotations, handler) {
  server.registerTool(
    name,
    { description, inputSchema, outputSchema, annotations },
    async (input) => jsonToolResult(await handler(input))
  );
}

function registerDataTool(server, name, description, inputSchema, annotations, handler) {
  registerJsonTool(server, name, description, inputSchema, dataOutputSchema, annotations, async (input) => ({ data: await handler(input) }));
}

function getBearerToken(request) {
  const authHeader = request.get("authorization") || "";
  const [scheme, token] = authHeader.split(/\s+/);
  if (scheme?.toLowerCase() === "bearer" && token) return token;
  return request.get("x-mcp-access-token");
}

function requireAccessToken(config) {
  return async (request, response, next) => {
    if (config.ALLOW_UNAUTHENTICATED_MCP === true) {
      next();
      return;
    }
    const token = getBearerToken(request);
    if (!token || !(await isValidOAuthAccessToken(config, token))) {
      response.set("WWW-Authenticate", getOAuthChallenge(config, request));
      response.status(401).json({ error: "unauthorized", message: "Token MCP ausente ou invalido." });
      return;
    }
    next();
  };
}

const workerOperationSchema = z.enum([
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

const codeProjectInputSchema = {
  teamId: z.string().optional(),
  projectPath: z.string().optional()
};

const codeLocationInputSchema = {
  ...codeProjectInputSchema,
  symbol: z.string().min(1).optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  maxResults: z.number().int().positive().max(1000).optional().default(100)
};

const workerTaskDefinitionSchema = z.object({
  id: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).optional().default([]),
  workerId: z.string().optional(),
  operation: workerOperationSchema,
  params: z.record(z.unknown()).optional().default({}),
  readPaths: z.array(z.string()).optional().default([]),
  writePaths: z.array(z.string()).optional().default([]),
  lockPolicy: z.enum(["wait", "reject"]).optional().default("wait"),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  estimatedDurationMs: z.number().int().positive().max(600_000).optional()
});

export function createMcpServer(projectRoot, teamManager) {
  const server = new McpServer({ name: "MCP Worker Coordinator", version: "2.0.0" });

  registerJsonTool(
    server,
    "project_overview",
    "Resume um projeto local: package.json, scripts, dependencias, estrutura raiz, README e status Git.",
    {
      path: z.string().optional().default("."),
      maxEntries: z.number().int().positive().max(500).optional().default(80),
      readmeMaxChars: z.number().int().positive().max(20_000).optional().default(2500)
    },
    projectOverviewOutputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => projectOverview(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "list_files",
    "Lista arquivos e pastas locais.",
    {
      path: z.string().optional().default("."),
      recursive: z.boolean().optional().default(false),
      maxEntries: z.number().int().positive().max(5000).optional().default(200),
      maxDepth: z.number().int().nonnegative().max(20).optional().default(4)
    },
    listFilesOutputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => listFiles(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "read_file",
    "Le um arquivo texto.",
    {
      path: z.string(),
      encoding: z.string().optional().default("utf8"),
      maxChars: z.number().int().positive().max(5_000_000).optional().default(200_000)
    },
    readFileOutputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => readFileText(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "write_file",
    "Escreve conteudo texto em arquivo.",
    { path: z.string(), content: z.string(), createDirectories: z.boolean().optional().default(true) },
    writeFileOutputSchema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (input) => {
      const result = await writeFileText(input, { projectRoot });
      teamManager.codeIntelligence.invalidatePaths([result.path]);
      return result;
    }
  );

  registerJsonTool(
    server,
    "create_directory",
    "Cria uma pasta local.",
    { path: z.string(), recursive: z.boolean().optional().default(true) },
    createDirectoryOutputSchema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (input) => {
      const result = await createDirectory(input, { projectRoot });
      teamManager.codeIntelligence.invalidatePaths([result.path]);
      return result;
    }
  );

  registerJsonTool(
    server,
    "delete_path",
    "Exclui arquivo ou pasta local.",
    { path: z.string(), recursive: z.boolean().optional().default(false), force: z.boolean().optional().default(false) },
    deletePathOutputSchema,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (input) => {
      const result = await deletePath(input, { projectRoot });
      teamManager.codeIntelligence.invalidatePaths([result.path]);
      return result;
    }
  );

  registerJsonTool(
    server,
    "move_path",
    "Move ou renomeia arquivo/pasta local.",
    {
      source: z.string(),
      destination: z.string(),
      overwrite: z.boolean().optional().default(false),
      createDirectories: z.boolean().optional().default(true)
    },
    movePathOutputSchema,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (input) => {
      const result = await movePath(input, { projectRoot });
      teamManager.codeIntelligence.invalidatePaths([result.source, result.destination]);
      return result;
    }
  );

  registerJsonTool(
    server,
    "copy_path",
    "Copia arquivo ou pasta local.",
    {
      source: z.string(),
      destination: z.string(),
      recursive: z.boolean().optional().default(false),
      overwrite: z.boolean().optional().default(false),
      createDirectories: z.boolean().optional().default(true)
    },
    copyPathOutputSchema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (input) => {
      const result = await copyPath(input, { projectRoot });
      teamManager.codeIntelligence.invalidatePaths([result.destination]);
      return result;
    }
  );

  registerJsonTool(
    server,
    "search_files",
    "Busca texto em arquivos, ignorando node_modules e .git.",
    {
      path: z.string().optional().default("."),
      query: z.string(),
      recursive: z.boolean().optional().default(true),
      caseSensitive: z.boolean().optional().default(false),
      includePattern: z.string().optional(),
      maxMatches: z.number().int().positive().max(5000).optional().default(100),
      maxDepth: z.number().int().nonnegative().max(20).optional().default(8)
    },
    searchFilesOutputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => searchFiles(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "apply_patch",
    "Aplica substituicao exata em arquivo com backup automatico por padrao.",
    {
      path: z.string(),
      search: z.string(),
      replace: z.string(),
      replaceAll: z.boolean().optional().default(false),
      backup: z.boolean().optional().default(true)
    },
    applyPatchOutputSchema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (input) => {
      const result = await applyExactPatch(input, { projectRoot });
      teamManager.codeIntelligence.invalidatePaths([result.path]);
      return result;
    }
  );

  registerJsonTool(
    server,
    "run_shell",
    "Executa comando no terminal local.",
    {
      command: z.string(),
      cwd: z.string().optional().default("."),
      timeoutMs: z.number().int().positive().max(120_000).optional().default(30_000)
    },
    commandResultOutputSchema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (input) => runShellCommand(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "npm_install",
    "Executa npm install no diretorio informado.",
    {
      cwd: z.string().optional().default("."),
      packages: z.array(z.string()).optional().default([]),
      flags: z.array(z.string()).optional().default([]),
      timeoutMs: z.number().int().positive().max(600_000).optional().default(300_000)
    },
    commandResultOutputSchema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    (input) => npmInstall(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "start_process",
    "Inicia um processo em segundo plano.",
    { command: z.string(), cwd: z.string().optional().default(".") },
    startProcessOutputSchema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (input) => startProcess(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "list_processes",
    "Lista processos locais.",
    { filter: z.string().optional().default(""), limit: z.number().int().positive().max(500).optional().default(80) },
    listProcessesOutputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => listProcesses(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "kill_process",
    "Encerra um processo local por PID.",
    {
      pid: z.number().int().positive(),
      force: z.boolean().optional().default(true),
      signal: z.string().optional().default("SIGTERM")
    },
    commandResultOutputSchema,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    (input) => killProcess(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "git_status",
    "Executa git status --short --branch.",
    { cwd: z.string().optional().default(".") },
    commandResultOutputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => gitStatus(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "git_diff",
    "Executa git diff ou git diff --staged.",
    { cwd: z.string().optional().default("."), staged: z.boolean().optional().default(false), pathspec: z.string().optional() },
    commandResultOutputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => gitDiff(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "run_tests",
    "Executa comando de teste do projeto.",
    {
      cwd: z.string().optional().default("."),
      command: z.string().optional().default("npm test"),
      timeoutMs: z.number().int().positive().max(300_000).optional().default(120_000)
    },
    commandResultOutputSchema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (input) => runShellCommand(input, { projectRoot })
  );

  registerJsonTool(
    server,
    "browser_screenshot",
    "Abre uma URL em navegador headless e salva screenshot PNG.",
    {
      url: z.string().url(),
      browser: z.enum(["chrome", "edge", "brave", "firefox", "auto"]).optional().default("auto"),
      width: z.number().int().positive().max(7680).optional().default(1280),
      height: z.number().int().positive().max(4320).optional().default(720),
      waitMs: z.number().int().nonnegative().max(30_000).optional().default(1000),
      outputDir: z.string().optional().default("screenshots")
    },
    browserScreenshotOutputSchema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (input) => captureBrowserScreenshot(input, { projectRoot })
  );

  registerDataTool(
    server,
    "code_context",
    "Retorna contexto estrutural compacto de um simbolo: definicao, assinatura, referencias, chamadas, imports, dependentes, testes e diagnosticos.",
    {
      ...codeLocationInputSchema,
      maxReferences: z.number().int().positive().max(1000).optional().default(100),
      maxRelatedTests: z.number().int().positive().max(100).optional().default(30),
      maxDiagnostics: z.number().int().positive().max(500).optional().default(50),
      maxExcerptChars: z.number().int().positive().max(20_000).optional().default(5000),
      maxChars: z.number().int().positive().max(100_000).optional().default(20_000)
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => teamManager.codeContext(input)
  );

  registerDataTool(
    server,
    "code_query",
    "Consulta estrutural de codigo. Acoes: symbols, definition, references, hover, callHierarchy, imports e completion.",
    {
      ...codeLocationInputSchema,
      action: z.enum(["symbols", "definition", "references", "hover", "callHierarchy", "imports", "completion"]),
      query: z.string().optional()
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => teamManager.codeQuery(input)
  );

  registerDataTool(
    server,
    "code_diagnostics",
    "Analisa erros sintaticos, semanticos e sugestoes do projeto ou de um arquivo usando o Language Service.",
    {
      ...codeProjectInputSchema,
      file: z.string().optional(),
      includeSuggestions: z.boolean().optional().default(true),
      maxFiles: z.number().int().positive().max(1000).optional().default(100),
      maxResults: z.number().int().positive().max(2000).optional().default(200)
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => teamManager.codeDiagnostics(input)
  );

  registerDataTool(
    server,
    "create_worker_team",
    "Cria uma equipe com exatamente tres processos workers para um projeto local.",
    { projectPath: z.string(), name: z.string().optional().default("Equipe de workers") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (input) => teamManager.createTeam(input)
  );

  registerDataTool(
    server,
    "assign_worker_task",
    "Enfileira uma operacao estruturada para um worker especifico ou para o worker menos ocupado.",
    {
      teamId: z.string(),
      workerId: z.string().optional(),
      clientTaskId: z.string().min(1).optional(),
      dependsOn: z.array(z.string()).optional().default([]),
      operation: workerOperationSchema,
      params: z.record(z.unknown()).optional().default({}),
      readPaths: z.array(z.string()).optional().default([]),
      writePaths: z.array(z.string()).optional().default([]),
      lockPolicy: z.enum(["wait", "reject"]).optional().default("wait"),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
      estimatedDurationMs: z.number().int().positive().max(600_000).optional()
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (input) => teamManager.assignTask(input)
  );

  registerDataTool(
    server,
    "run_parallel_tasks",
    "Distribui tarefas com LPT/carga estimada, dependencias DAG e bloqueios hierarquicos de leitura/escrita.",
    {
      teamId: z.string(),
      tasks: z.array(workerTaskDefinitionSchema).min(1).max(30),
      wait: z.boolean().optional().default(false),
      waitTimeoutMs: z.number().int().positive().max(300_000).optional().default(120_000)
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (input) => teamManager.runParallelTasks(input)
  );

  registerDataTool(
    server,
    "get_team_status",
    "Consulta equipe, tres workers, filas, resumo de tarefas e bloqueios ativos.",
    { teamId: z.string() },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => teamManager.getTeamStatus(input.teamId)
  );

  registerDataTool(
    server,
    "get_worker_status",
    "Consulta estado, tarefa atual, fila e historico recente de um worker.",
    { teamId: z.string(), workerId: z.string() },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => teamManager.getWorkerStatus(input)
  );

  registerDataTool(
    server,
    "get_worker_logs",
    "Consulta logs persistidos por equipe, worker ou tarefa.",
    {
      teamId: z.string().optional(),
      workerId: z.string().optional(),
      taskId: z.string().optional(),
      limit: z.number().int().positive().max(2000).optional().default(200)
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => teamManager.getLogs(input)
  );

  registerDataTool(
    server,
    "get_worker_result",
    "Obtem resultado estruturado, erro, arquivos usados e hashes de uma tarefa.",
    { taskId: z.string() },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => teamManager.getTaskResult(input.taskId)
  );

  registerDataTool(
    server,
    "send_worker_instruction",
    "Registra uma nova instrucao e, opcionalmente, cria uma tarefa de seguimento para o mesmo worker.",
    {
      teamId: z.string(),
      workerId: z.string(),
      taskId: z.string().optional(),
      message: z.string(),
      operation: workerOperationSchema.optional(),
      params: z.record(z.unknown()).optional().default({}),
      readPaths: z.array(z.string()).optional().default([]),
      writePaths: z.array(z.string()).optional().default([]),
      lockPolicy: z.enum(["wait", "reject"]).optional().default("wait"),
      timeoutMs: z.number().int().positive().max(600_000).optional()
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    (input) => teamManager.sendInstruction(input)
  );

  registerDataTool(
    server,
    "cancel_worker_task",
    "Cancela uma tarefa aguardando ou em execucao e libera seus bloqueios.",
    { taskId: z.string(), reason: z.string().optional().default("Cancelado pelo GPT coordenador.") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    (input) => teamManager.cancelTask(input.taskId, input.reason)
  );

  registerDataTool(
    server,
    "wait_for_worker_tasks",
    "Espera ate as tarefas informadas terminarem ou ate o limite de espera.",
    {
      taskIds: z.array(z.string()).min(1).max(100),
      timeoutMs: z.number().int().positive().max(300_000).optional().default(120_000),
      pollMs: z.number().int().positive().max(5000).optional().default(50)
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (input) => teamManager.waitForTasks(input)
  );

  registerDataTool(
    server,
    "close_worker_team",
    "Cancela pendencias, encerra os tres processos workers e libera todos os bloqueios da equipe.",
    { teamId: z.string() },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    (input) => teamManager.closeTeam(input.teamId)
  );

  return server;
}

export async function startMcpHttpServer({ config, teamManager, tunnelController }) {
  const app = express();
  const sessions = new Map();
  const authRequired = config.ALLOW_UNAUTHENTICATED_MCP !== true;
  let httpServer = null;
  const serverState = { isRunning: () => Boolean(httpServer?.listening) };

  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(createOAuthRouter(config));

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "mcp-worker-coordinator",
      port: config.SERVER_PORT,
      mcpPath: "/mcp",
      authRequired,
      workerCount: 3
    });
  });

  app.all("/mcp", requireAccessToken(config));

  app.post("/mcp", async (request, response) => {
    const sessionId = request.get("mcp-session-id");
    try {
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId);
        await transport.handleRequest(request, response, request.body);
        return;
      }

      if (!sessionId && isInitializeRequest(request.body)) {
        const mcpServer = createMcpServer(config.PROJECT_ROOT, teamManager);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => sessions.set(newSessionId, { transport, mcpServer })
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          mcpServer.close();
        };
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, request.body);
        return;
      }

      response.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: sessao MCP ausente ou invalida." },
        id: null
      });
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: `Erro interno MCP: ${error.message}` },
          id: null
        });
      }
    }
  });

  app.get("/mcp", async (request, response) => {
    const sessionId = request.get("mcp-session-id");
    if (!sessionId || !sessions.has(sessionId)) {
      response.status(400).send("Sessao MCP ausente ou invalida.");
      return;
    }
    await sessions.get(sessionId).transport.handleRequest(request, response);
  });

  app.delete("/mcp", async (request, response) => {
    const sessionId = request.get("mcp-session-id");
    if (!sessionId || !sessions.has(sessionId)) {
      response.status(400).send("Sessao MCP ausente ou invalida.");
      return;
    }
    await sessions.get(sessionId).transport.handleRequest(request, response);
  });

  mountUiRoutes(app, { config, tunnelController, teamManager, serverState });

  httpServer = await new Promise((resolve, reject) => {
    const instance = app.listen(config.SERVER_PORT, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : config.SERVER_PORT;

  return {
    app,
    port,
    localUrl: `http://127.0.0.1:${port}`,
    localMcpUrl: `http://127.0.0.1:${port}/mcp`,
    isRunning: serverState.isRunning,
    stop: async () => {
      for (const { transport, mcpServer } of sessions.values()) {
        await transport.close().catch(() => {});
        mcpServer.close();
      }
      sessions.clear();
      await new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
    }
  };
}
