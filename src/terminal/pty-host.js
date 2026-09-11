// Isola o addon nativo e seus handles do HTTP/SQLite/workers. Este arquivo so roda por fork.
let terminal;
let exiting = false;
let initialized = false;
let backendLoaded = false;

function notify(message, callback = () => {}) {
  if (!process.connected) return callback();
  process.send(message, (error) => { callback(); if (error) shutdown(); });
}

function shutdown() {
  if (exiting) return;
  exiting = true;
  if (terminal) {
    try {
      if (process.platform !== "win32") process.kill(-terminal.pid, "SIGTERM");
      terminal.kill();
    } catch { /* A PTY pode ter terminado antes do fechamento do IPC. */ }
  }
  // ConPTY/node-pty pode manter MessagePorts apos onExit; sair do host libera esses handles.
  setTimeout(() => {
    if (terminal && process.platform !== "win32") {
      try { process.kill(-terminal.pid, "SIGKILL"); } catch { /* Grupo ja encerrado. */ }
    }
    process.exit(0);
  }, 200);
}

process.on("message", async (message) => {
  try {
    if (message.type === "start" && !initialized) {
      initialized = true;
      const pty = await import("node-pty");
      backendLoaded = true;
      if (exiting || !process.connected) return;
      terminal = pty.spawn(message.executable, message.args, {
        name: "xterm-256color", cols: message.cols, rows: message.rows,
        cwd: message.cwd, env: message.env, useConpty: true
      });
      terminal.onData((data) => {
        // Backpressure no IPC evita uma segunda fila ilimitada fora do ring buffer.
        terminal.pause();
        notify({ type: "data", data }, () => { if (!exiting) terminal.resume(); });
      });
      terminal.onExit(({ exitCode, signal }) => {
        exiting = true;
        notify({ type: "exit", exitCode, signal }, () => process.exit(0));
      });
      notify({ type: "ready", pid: terminal.pid });
    } else if (message.type === "write" && terminal && !exiting) {
      terminal.write(message.data);
    } else if (message.type === "resize" && terminal && !exiting) {
      terminal.resize(message.cols, message.rows);
    } else if (message.type === "close") {
      shutdown();
    }
  } catch (error) {
    // Nao transporta stack/argumentos/env: esses campos podem conter senhas digitadas.
    notify({ type: "failure", code: !backendLoaded ? "PTY_UNAVAILABLE" : "PTY_ERROR" });
    shutdown();
  }
});

// O iniciador Windows pode matar o MCP a forca: perder o IPC tambem encerra a PTY.
process.once("disconnect", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
process.once("uncaughtException", () => { notify({ type: "failure", code: "PTY_CRASH" }); shutdown(); });
process.once("unhandledRejection", () => { notify({ type: "failure", code: "PTY_CRASH" }); shutdown(); });
