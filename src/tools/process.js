import { spawn } from "node:child_process";
import os from "node:os";
import { resolveInsideProject } from "./path-utils.js";
import { runShellCommand } from "./shell.js";

function quoteShellArg(value) {
  const text = String(value);

  // Protege filtros simples contra quebra acidental da linha de comando.
  if (os.platform() === "win32") {
    return `'${text.replaceAll("'", "''")}'`;
  }

  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

export async function listProcesses(input = {}, { projectRoot }) {
  const filter = input.filter || "";
  const limit = input.limit ?? 80;

  // No Windows, PowerShell retorna metadados estruturados para o ChatGPT inspecionar.
  if (os.platform() === "win32") {
    const filterExpression = filter
      ? ` | Where-Object { $_.ProcessName -like ${quoteShellArg(`*${filter}*`)} -or [string]$_.Id -eq ${quoteShellArg(filter)} }`
      : "";
    const command = `Get-Process${filterExpression} | Select-Object -First ${limit} Id,ProcessName,CPU,WorkingSet,StartTime | ConvertTo-Json -Depth 3`;
    const result = await runShellCommand({ command, cwd: ".", timeoutMs: 15_000 }, { projectRoot });

    return {
      ...result,
      processes: result.stdout.trim() ? JSON.parse(result.stdout) : []
    };
  }

  const command = filter ? `ps aux | grep -i ${quoteShellArg(filter)} | head -n ${limit}` : `ps aux | head -n ${limit}`;
  return runShellCommand({ command, cwd: ".", timeoutMs: 15_000 }, { projectRoot });
}

export async function killProcess(input, { projectRoot }) {
  const signal = input.signal || "SIGTERM";

  if (os.platform() === "win32") {
    const forceFlag = input.force === false ? "" : " -Force";
    return runShellCommand(
      {
        command: `Stop-Process -Id ${Number(input.pid)}${forceFlag}`,
        cwd: ".",
        timeoutMs: 15_000
      },
      { projectRoot }
    );
  }

  return runShellCommand(
    {
      command: `kill -s ${quoteShellArg(signal)} ${Number(input.pid)}`,
      cwd: ".",
      timeoutMs: 15_000
    },
    { projectRoot }
  );
}

export async function startProcess(input, { projectRoot }) {
  const cwd = resolveInsideProject(projectRoot, input.cwd || ".");
  const shell = os.platform() === "win32" ? "powershell.exe" : "/bin/sh";
  const args =
    os.platform() === "win32"
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", input.command]
      : ["-lc", input.command];
  const child = spawn(shell, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });

  // Processo em segundo plano nao deve prender a resposta da tool MCP.
  child.unref();

  return {
    pid: child.pid,
    cwd,
    command: input.command,
    detached: true
  };
}
