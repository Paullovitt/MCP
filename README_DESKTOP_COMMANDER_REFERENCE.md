# Architecture reference for Desktop Commander maintainers

Paulo Augusto · 2026 · MCP Worker Coordinator 2.5.1 · [MIT license](LICENSE)

This is an implementation reference, not a proposal to replace Desktop Commander or a claim that these changes have been integrated upstream. Individual patterns can be evaluated independently. The AI client plans the work; the workers are deterministic Node.js processes, not additional language models.

## Architecture and source map

| Responsibility | Implementation |
|---|---|
| Three workers per team, DAG validation, LPT/EWMA scheduling, cancellation and recovery | [team-manager.js](src/workers/team-manager.js), [worker-process.js](src/workers/worker-process.js) |
| SQLite coordination state, hierarchical R/W path leases and duration statistics | [sqlite-store.js](src/storage/sqlite-store.js) |
| Shared incremental code analysis, MCP queries and worker IPC | [code-intelligence](src/code-intelligence) |
| Pre/post-edit diagnostics and index invalidation | [automatic-validator.js](src/code-intelligence/automatic-validator.js) |
| Persistent interactive sessions independent of workers | [session-manager.js](src/terminal/session-manager.js), [terminal-session.js](src/terminal/terminal-session.js) |
| Isolated native PTY host, bounded UTF-8 output and process cleanup | [pty-host.js](src/terminal/pty-host.js), [output-buffer.js](src/terminal/output-buffer.js), [process-tree.js](src/terminal/process-tree.js) |
| Finite direct shell commands and timeout/shutdown cancellation | [shell.js](src/tools/shell.js) |
| Local protected shutdown and Windows graceful/forced fallback | [local-shutdown.js](src/local-shutdown.js), [stop-server.ps1](scripts/stop-server.ps1) |

Each team has three workers. Independent operations can run concurrently; dependencies and declared path conflicts gate execution. Locks do not sandbox arbitrary shell commands. SQLite keeps coordination records, not live processes: restart recovery does not resume interrupted commands.

Code Intelligence is shared rather than duplicated per worker: TypeScript Language Service for JS/TS, Pyright for Python, language servers for HTML/CSS, and structural SQL/C# analysis. Capabilities differ by language; C# is not a Roslyn semantic implementation. `code_context`, `code_query` and `code_diagnostics` provide structured navigation and validation. Postflight reports regressions; it is not transactional rollback.

## Persistent terminal: implemented, not just planned

Seven tools are shipped: `terminal_start`, `terminal_send`, `terminal_read`, `terminal_status`, `terminal_list`, `terminal_resize`, `terminal_close`.

Each session owns a real PTY through optional `node-pty` 1.1.0 in a separate Node host. The session manager belongs to the server bootstrap, so MCP transport reconnections do not erase the running REPL. A server restart does erase sessions. The native host boundary provides lifecycle/failure isolation, not a security sandbox.

Features include stateful Python/Node/PowerShell, y/n responses, raw text without Enter, Ctrl+C, resize, independent UTF-8 cursors, explicit truncation, bounded retained output and optional inactivity expiry. Defaults are eight active sessions, 1 MiB output per session and 64 KiB per read. Closed-session retention is bounded by both age and count. Clients must wait for the actual prompt: accepted input is not proof of command completion.

The [terminal guide](docs/TERMINAL.md) contains contracts and an executable example that preserves `x = 50`, evaluates `x * 10`, and closes the session. Its test executes the documentation block itself.

## Additional hardening in 2.5.1

- Direct shell execution retains only the last 512 KiB of each output stream, with byte counts and truncation flags. The legacy result fields remain available.
- Timeout and server shutdown terminate the owned process tree; shutdown cancellation is distinguished from timeout. Termination failures are reported explicitly.
- Windows stop wrappers request application cleanup before forcing termination. They verify the owning process and recheck identity before the forced fallback. An unrelated listener is refused.
- The administrative shutdown channel requires an ephemeral local secret, loopback Host/peer and no Origin/forwarding headers. It is not a public MCP tool and does not change OAuth credentials.
- Operational terminal errors carry machine-readable codes; forced termination has a lifecycle event without recording terminal input, output or environment.

One-shot shell, background worker tasks and interactive terminals remain separate abstractions. Background work returns task identifiers instead of holding a client request open; terminals do not consume worker slots or automatically participate in worker locks/validation.

## Validation and limitations

Run `npm ci --include=optional`, then `npm test` with Node 24+. See [README](README.md) for installation and server operation. Windows/Node 24.11.0 is the real validation environment for this release.

[Terminal tests](test/terminal.test.js) cover real REPL interaction and session lifecycle. [Shell/lifecycle tests](test/shell-lifecycle.test.js) cover output flooding, exit codes, timeouts, child processes, unrelated-process survival, protected shutdown, structured errors, graceful stop, forced fallback and foreign-listener refusal. They use isolated temporary projects, not the installed server's credentials/database. Existing OAuth, timeout and documentation regression tests remain included.

This is not a comparative performance benchmark. Linux/macOS, external SSH/database services and full-screen TUIs are not certified by these Windows tests. Authorized MCP clients share the session registry; there is no per-user session isolation. Deliberately detached processes/services are outside the process-tree cleanup guarantee. Shells have the account's permissions. Dependency audit findings and remaining risks are disclosed in [SECURITY.md](SECURITY.md).

The reusable contribution here is the separation of execution models, shared analysis, explicit ownership/lifecycle and testable cleanup contracts. No adoption of the whole coordinator is required to reuse an individual idea.
