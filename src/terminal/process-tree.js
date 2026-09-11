import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function taskkill(pid, force) {
  // PID vem exclusivamente do fork desta sessao; nenhum nome de processo ou comando do usuario e interpolado.
  await new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      windowsHide: true, stdio: "ignore"
    });
    const timer = setTimeout(() => { killer.kill(); resolve(); }, 2000);
    const done = () => { clearTimeout(timer); resolve(); };
    killer.once("error", done);
    killer.once("exit", done);
  });
}

export async function terminateProcessTree(child, graceMs = 300) {
  if (!child.pid || hasExited(child)) return;
  if (process.platform === "win32") {
    await taskkill(child.pid, false);
    if (!hasExited(child)) await delay(graceMs);
    if (!hasExited(child)) await taskkill(child.pid, true);
  } else {
    // O host encaminha o encerramento ao grupo da PTY antes de sair.
    if (child.connected) child.send({ type: "close" }, () => {});
    await delay(graceMs);
    if (!hasExited(child)) child.kill("SIGKILL");
  }
  // Aguarda o evento exit sem deixar uma falha de encerramento travar o shutdown para sempre.
  for (let attempt = 0; attempt < 20 && !hasExited(child); attempt++) await delay(50);
  if (!hasExited(child)) throw new Error("Nao foi possivel encerrar a arvore do terminal.");
}
