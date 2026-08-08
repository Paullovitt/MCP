import { runShellCommand } from "./shell.js";
import os from "node:os";

function quoteShellArg(value) {
  const text = String(value);

  // Pacotes podem conter escopos ou simbolos; aspas evitam parsing errado pelo shell.
  if (os.platform() === "win32") {
    return `'${text.replaceAll("'", "''")}'`;
  }

  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

export async function npmInstall(input = {}, { projectRoot }) {
  const packages = Array.isArray(input.packages) ? input.packages : [];
  const flags = Array.isArray(input.flags) ? input.flags : [];
  const packageArgs = packages.map(quoteShellArg).join(" ");
  const flagArgs = flags.join(" ");
  // Sem pacotes, o comando instala o projeto atual; com pacotes, atua como npm install pacote.
  const command = ["npm install", packageArgs, flagArgs].filter(Boolean).join(" ");

  return runShellCommand(
    {
      command,
      cwd: input.cwd || ".",
      timeoutMs: input.timeoutMs ?? 300_000
    },
    { projectRoot }
  );
}
