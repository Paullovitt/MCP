import { spawn } from "node:child_process";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { resolveInsideProject } from "./path-utils.js";

function getShellCommand(command) {
  if (os.platform() === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
    };
  }

  return {
    executable: "/bin/sh",
    args: ["-lc", command]
  };
}

export async function runShellCommand(input, { projectRoot }) {
  const cwd = resolveInsideProject(projectRoot, input.cwd || ".");
  const timeoutMs = input.timeoutMs ?? 30_000;
  const startedAt = performance.now();
  const shellCommand = getShellCommand(input.command);

  return new Promise((resolve) => {
    const child = spawn(shellCommand.executable, shellCommand.args, {
      cwd,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + error.message,
        exitCode: 1,
        timedOut,
        durationMs: Math.round(performance.now() - startedAt)
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        durationMs: Math.round(performance.now() - startedAt)
      });
    });
  });
}
