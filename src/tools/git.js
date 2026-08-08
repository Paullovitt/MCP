import os from "node:os";
import { runShellCommand } from "./shell.js";

function quoteShellArg(value) {
  if (os.platform() === "win32") {
    return `'${value.replaceAll("'", "''")}'`;
  }

  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export async function gitStatus(input, { projectRoot }) {
  return runShellCommand(
    {
      command: "git status --short --branch",
      cwd: input.cwd || ".",
      timeoutMs: 30_000
    },
    { projectRoot }
  );
}

export async function gitDiff(input, { projectRoot }) {
  const stagedFlag = input.staged ? "--staged" : "";
  const pathspec = input.pathspec ? ` -- ${quoteShellArg(input.pathspec)}` : "";

  return runShellCommand(
    {
      command: `git diff ${stagedFlag}${pathspec}`.trim(),
      cwd: input.cwd || ".",
      timeoutMs: 60_000
    },
    { projectRoot }
  );
}
