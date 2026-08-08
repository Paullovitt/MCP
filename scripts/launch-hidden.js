import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const logsDirectory = path.join(projectRoot, "logs");
const stdoutPath = path.join(logsDirectory, "console.out.log");
const stderrPath = path.join(logsDirectory, "console.err.log");

fs.mkdirSync(logsDirectory, { recursive: true });

// Arquivos reais evitam que o processo oculto mantenha o pipe e a janela do start.bat abertos.
const stdoutFd = fs.openSync(stdoutPath, "w");
const stderrFd = fs.openSync(stderrPath, "w");
const child = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", path.join(projectRoot, "src", "index.js")],
  {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdoutFd, stderrFd]
  }
);

try {
  // Confirma que o Windows criou o processo antes de liberar o launcher.
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  process.stdout.write(String(child.pid));
} finally {
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
}
