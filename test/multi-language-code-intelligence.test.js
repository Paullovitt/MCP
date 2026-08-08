import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeIntelligenceEngine } from "../src/code-intelligence/engine.js";
import { WorkerTeamManager } from "../src/workers/team-manager.js";
import { createMcpServer } from "../src/mcp-server.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-multilang-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fixture-multilang",
    dependencies: { zod: "^3.25.0" }
  }, null, 2));
  await fs.writeFile(path.join(root, "requirements.txt"), "requests==2.32.0\n");
  await fs.writeFile(path.join(root, "fixture.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup>
</Project>`);
  await fs.writeFile(path.join(root, "app.py"), `class UserService:
    def find_user(self, user_id: int) -> str:
        return str(user_id)

service = UserService()
result = service.find_user(1)
`);
  await fs.writeFile(path.join(root, "broken.py"), `def invalid_reference() -> int:
    return missing_name
`);
  await fs.writeFile(path.join(root, "completion.py"), `from app import UserService
service = UserService()
service.
`);
  await fs.writeFile(path.join(root, "LockManager.cs"), `namespace Fixture;

public class LockManager
{
    public bool Acquire(string path) { return true; }
    public void Release(string path) { }
}

public class Program
{
    public void Run()
    {
        var manager = new LockManager();
        manager.Acquire("file.txt");
    }
}
`);
  await fs.writeFile(path.join(root, "schema.sql"), `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id)
);

SELECT users.email FROM users JOIN orders ON orders.user_id = users.id;
`);
  await fs.writeFile(path.join(root, "invalid.sql"), "SELECT FROM WHERE;\n");
  await fs.writeFile(path.join(root, "index.html"), `<!doctype html>
<html>
<body>
  <div id="app" class="card"></div>
</body>
</html>
`);
  await fs.writeFile(path.join(root, "style.css"), `.card {
  color: red;
}
`);
  return root;
}

test("motor central entende projeto, dependencias, C# e SQL", { timeout: 60_000 }, async (context) => {
  const fixture = await createFixture();
  const engine = new CodeIntelligenceEngine();
  context.after(async () => {
    await engine.close();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  const project = await engine.query(fixture, { action: "project", maxChars: 50_000 });
  assert.equal(project.provider, "project-intelligence");
  assert.equal(project.languages.python, 3);
  assert.equal(project.languages.csharp, 1);
  assert.equal(project.languages.sql, 2);
  assert.ok(project.capabilities.some((item) => item.language === "python"));

  const dependencies = await engine.query(fixture, { action: "dependencies", maxChars: 50_000 });
  assert.ok(dependencies.dependencies.some((item) => item.name === "zod" && item.ecosystem === "npm"));
  assert.ok(dependencies.dependencies.some((item) => item.name === "requests" && item.ecosystem === "pip"));
  assert.ok(dependencies.dependencies.some((item) => item.name === "Newtonsoft.Json" && item.ecosystem === "nuget"));

  const installation = await engine.query(fixture, { action: "installation" });
  assert.ok(installation.commands.some((item) => item.command === "npm install"));
  assert.ok(installation.commands.some((item) => item.command.includes("requirements.txt")));
  assert.equal(installation.safety.includes("nenhuma instalacao"), true);

  const csharp = await engine.context(fixture, { symbol: "Acquire", file: "LockManager.cs", line: 5, column: 17 });
  assert.equal(csharp.provider, "csharp-structural-fallback");
  assert.equal(csharp.definition.file, "LockManager.cs");
  assert.ok(csharp.totalReferences >= 2);
  assert.equal(csharp.capabilities.roslynActive, false);
  const csharpCompletion = await engine.query(fixture, { action: "completion", file: "LockManager.cs", line: 14, column: 17, maxResults: 50 });
  assert.ok(csharpCompletion.entries.some((item) => item.name === "Acquire"));
  assert.ok(csharpCompletion.entries.some((item) => item.name === "Release"));

  const sql = await engine.context(fixture, { symbol: "users", file: "schema.sql", line: 1, column: 14, dialect: "sqlite" });
  assert.equal(sql.provider, "sql-structural-parser");
  assert.equal(sql.definition.file, "schema.sql");
  assert.ok(sql.references.some((item) => item.line > 1));
  const sqlCompletion = await engine.query(fixture, { action: "completion", file: "schema.sql", line: 10, column: 7 });
  assert.ok(sqlCompletion.entries.some((item) => item.name === "users"));
  const invalidSql = await engine.diagnostics(fixture, { file: "invalid.sql", dialect: "sqlite" });
  assert.ok(invalidSql.totalDiagnostics > 0);

  await fs.appendFile(path.join(fixture, "schema.sql"), "\nCREATE TABLE audit_log (id INTEGER PRIMARY KEY);\n");
  engine.invalidate(fixture, [path.join(fixture, "schema.sql")]);
  const refreshed = await engine.query(fixture, { action: "symbols", query: "audit_log" });
  assert.ok(refreshed.symbols.some((item) => item.name === "audit_log"));

  await assert.rejects(
    engine.query(fixture, { action: "completion", file: "README.md", line: 1, column: 1 }),
    /Linguagem ainda nao suportada/
  );
});

test("Pyright e servidores HTML/CSS oferecem contexto, completion e diagnosticos", { timeout: 90_000 }, async (context) => {
  const fixture = await createFixture();
  const engine = new CodeIntelligenceEngine();
  context.after(async () => {
    await engine.close();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  const python = await engine.context(fixture, { symbol: "UserService", maxChars: 50_000 });
  assert.equal(python.provider, "pyright-language-server");
  assert.equal(python.definition.file, "app.py");
  assert.ok(python.signature?.includes("UserService"));

  const pythonCompletion = await engine.query(fixture, { action: "completion", file: "completion.py", line: 3, column: 9, maxResults: 100 });
  assert.ok(pythonCompletion.entries.some((item) => item.name === "find_user"));
  const pythonDiagnostics = await engine.diagnostics(fixture, { file: "broken.py", settleMs: 800 });
  assert.ok(pythonDiagnostics.diagnostics.some((item) => item.message.includes("missing_name")));

  const htmlSymbols = await engine.query(fixture, { action: "symbols", file: "index.html", query: "", maxResults: 50 });
  assert.equal(htmlSymbols.provider, "vscode-html-language-server");
  assert.ok(htmlSymbols.symbols.length > 0);
  const htmlCompletion = await engine.query(fixture, { action: "completion", file: "index.html", line: 4, column: 8, maxResults: 100 });
  assert.ok(htmlCompletion.entries.length > 0);

  const cssCompletion = await engine.query(fixture, { action: "completion", file: "style.css", line: 2, column: 10, maxResults: 100 });
  assert.equal(cssCompletion.provider, "vscode-css-language-server");
  assert.ok(cssCompletion.entries.length > 0);
});

test("os tres workers compartilham a inteligencia multilíngue central por IPC", { timeout: 90_000 }, async (context) => {
  const fixture = await createFixture();
  const databasePath = path.join(fixture, "coordinator.sqlite");
  const manager = new WorkerTeamManager({ projectRoot, databasePath, workerCount: 3 });
  context.after(async () => {
    await manager.stop();
    await fs.rm(fixture, { recursive: true, force: true });
  });

  const team = await manager.createTeam({ projectPath: fixture, name: "Multilanguage IPC" });
  const batch = await manager.runParallelTasks({
    teamId: team.team.id,
    wait: true,
    waitTimeoutMs: 60_000,
    tasks: [
      { operation: "code_context", params: { symbol: "UserService" } },
      { operation: "code_context", params: { symbol: "Acquire", file: "LockManager.cs", line: 5, column: 17 } },
      { operation: "code_context", params: { symbol: "users", file: "schema.sql", line: 1, column: 14, dialect: "sqlite" } }
    ]
  });
  assert.equal(batch.wait.tasks.length, 3);
  assert.ok(batch.wait.tasks.every((task) => task.status === "concluido"));
  const providers = new Set(batch.wait.tasks.map((task) => task.result.output.provider));
  assert.deepEqual(providers, new Set(["pyright-language-server", "csharp-structural-fallback", "sql-structural-parser"]));
  assert.equal(manager.codeIntelligence.getStatus().activeSessions, 1);
  await manager.closeTeam(team.team.id);
});

test("escritas dos workers comparam diagnosticos antes e depois automaticamente", { timeout: 120_000 }, async (context) => {
  const fixture = await createFixture();
  const databasePath = path.join(fixture, "automatic-coordinator.sqlite");
  const manager = new WorkerTeamManager({ projectRoot, databasePath, workerCount: 3 });
  context.after(async () => {
    await manager.stop();
    await fs.rm(fixture, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(fixture, "existing-error.js"), "export const oldValue = missingBefore;\nexport const edited = 1;\n");
  await fs.writeFile(path.join(fixture, "new-error.js"), "export const edited = 1;\n");
  await fs.writeFile(path.join(fixture, "notes.txt"), "antes\n");
  await fs.mkdir(path.join(fixture, "source-dir"));
  await fs.writeFile(path.join(fixture, "source-dir", "copied.js"), "export const copied = true;\n");

  const team = await manager.createTeam({ projectPath: fixture, name: "Automatic intelligence" });
  const unchangedOldError = await manager.assignTask({
    teamId: team.team.id,
    operation: "apply_patch",
    params: { path: "existing-error.js", search: "edited = 1", replace: "edited = 2" }
  });
  const oldErrorResult = (await manager.waitForTasks({ taskIds: [unchangedOldError.id], timeoutMs: 60_000 })).tasks[0];
  assert.equal(oldErrorResult.status, "concluido");
  assert.equal(oldErrorResult.result.intelligence.status, "passed");
  assert.equal(oldErrorResult.result.intelligence.diagnostics.newErrors, 0);
  assert.ok(oldErrorResult.result.intelligence.diagnostics.unchanged >= 1);

  const introducedError = await manager.assignTask({
    teamId: team.team.id,
    operation: "apply_patch",
    params: { path: "new-error.js", search: "edited = 1", replace: "edited = missingAfter" }
  });
  const newErrorResult = (await manager.waitForTasks({ taskIds: [introducedError.id], timeoutMs: 60_000 })).tasks[0];
  assert.equal(newErrorResult.status, "concluido");
  assert.equal(newErrorResult.result.intelligence.status, "failed");
  assert.ok(newErrorResult.result.intelligence.diagnostics.newErrors >= 1);
  assert.match(await fs.readFile(path.join(fixture, "new-error.js"), "utf8"), /missingAfter/);

  const textTask = await manager.assignTask({
    teamId: team.team.id,
    operation: "write_file",
    params: { path: "notes.txt", content: "depois\n" }
  });
  const textResult = (await manager.waitForTasks({ taskIds: [textTask.id], timeoutMs: 30_000 })).tasks[0];
  assert.equal(textResult.result.intelligence.status, "not_applicable");

  const manifestTask = await manager.assignTask({
    teamId: team.team.id,
    operation: "write_file",
    params: {
      path: "package.json",
      content: JSON.stringify({ name: "fixture-multilang", dependencies: { zod: "^3.25.0", express: "^4.22.2" } }, null, 2)
    }
  });
  const manifestResult = (await manager.waitForTasks({ taskIds: [manifestTask.id], timeoutMs: 30_000 })).tasks[0];
  assert.ok(manifestResult.result.intelligence.dependencyChanges.added.some((item) => item.name === "express"));

  const copyTask = await manager.assignTask({
    teamId: team.team.id,
    operation: "copy_path",
    params: { source: "source-dir", destination: "copied-dir", recursive: true }
  });
  const copyResult = (await manager.waitForTasks({ taskIds: [copyTask.id], timeoutMs: 30_000 })).tasks[0];
  assert.equal(copyResult.result.intelligence.applicable, true);
  assert.ok(copyResult.result.intelligence.createdFiles.includes("copied-dir/copied.js"));

  const disabledTask = await manager.assignTask({
    teamId: team.team.id,
    operation: "write_file",
    params: { path: "disabled.py", content: "return missing_disabled\n" },
    intelligenceMode: "off"
  });
  const disabledResult = (await manager.waitForTasks({ taskIds: [disabledTask.id], timeoutMs: 30_000 })).tasks[0];
  assert.equal(disabledResult.result.intelligence.status, "disabled");
  await manager.closeTeam(team.team.id);
});

test("contrato MCP expoe as novas acoes sem criar tools duplicadas", async (context) => {
  const calls = [];
  const manager = {
    codeContext: async (input) => ({ provider: "test", input }),
    codeQuery: async (input) => {
      calls.push(input);
      return { provider: "test", action: input.action };
    },
    codeDiagnostics: async (input) => ({ provider: "test", input })
  };
  const server = createMcpServer(projectRoot, manager);
  context.after(() => server.close());

  const tools = Object.keys(server._registeredTools).filter((name) => name.startsWith("code_"));
  assert.deepEqual(tools.sort(), ["code_context", "code_diagnostics", "code_query"]);
  const schema = server._registeredTools.code_query.inputSchema;
  for (const action of ["project", "dependencies", "installation", "files", "relatedFiles", "languageCapabilities"]) {
    assert.equal(schema.safeParse({ action, file: action === "relatedFiles" ? "src/index.js" : undefined }).success, true);
  }
  const response = await server._registeredTools.code_query.handler({ action: "languageCapabilities" });
  assert.equal(response.structuredContent.data.action, "languageCapabilities");
  assert.equal(calls.length, 1);
  const workerSchema = server._registeredTools.assign_worker_task.inputSchema;
  assert.equal(workerSchema.safeParse({ teamId: "team", operation: "write_file", params: {} }).data.intelligenceMode, "always");
});
