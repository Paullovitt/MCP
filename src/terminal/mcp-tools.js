import { z } from "zod";
import { terminalStartSchema, terminalSendSchema, terminalReadSchema, terminalResizeSchema, terminalSessionId } from "./session-manager.js";

// Adaptador fino: as sessoes pertencem ao bootstrap, nunca ao transporte/reconexao MCP.
export function registerTerminalTools(server, manager) {
  const register = (name, description, schema, readOnlyHint, handler) => {
    server.registerTool(name, {
      description, inputSchema: schema.shape, outputSchema: { data: z.unknown() },
      annotations: { readOnlyHint, destructiveHint: !readOnlyHint, idempotentHint: readOnlyHint || name === "terminal_close", openWorldHint: !readOnlyHint }
    }, async (input) => {
      if (!manager) throw new Error("TerminalSessionManager nao foi configurado neste servidor MCP.");
      const result = { data: await handler(input) };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
  };
  const idSchema = z.object({ sessionId: terminalSessionId });
  register("terminal_start", "Abre PTY persistente (PowerShell, Python, Node ou executavel). Estado dura ate fechar/reiniciar MCP. Nao usa locks nem workers; prefira run_shell para comandos finitos.", terminalStartSchema, false, (input) => manager.start(input));
  register("terminal_send", "Envia texto/controles UTF-8 para a sessao. newline=true acrescenta Enter (CR); false envia exatamente o texto (ex.: Ctrl+C = \\u0003). Aceite nao significa comando concluido; leia a saida.", terminalSendSchema, false, (input) => manager.send(input));
  register("terminal_read", "Le saida incremental sem esperar nem consumir globalmente. Reutilize cursor como afterOffset; truncatedBefore sinaliza perda de historico. stdout/stderr sao combinados pela PTY.", terminalReadSchema, true, (input) => manager.read(input));
  register("terminal_status", "Estado e metadados da sessao; cwd e o diretorio inicial, nao acompanha cd interno.", idSchema, true, ({ sessionId }) => manager.status(sessionId));
  register("terminal_list", "Lista sessoes ativas e encerradas ainda retidas na memoria deste MCP.", z.object({}), true, () => manager.list());
  register("terminal_resize", "Redimensiona a PTY em colunas/linhas (2 a 500).", terminalResizeSchema, false, (input) => manager.resize(input));
  register("terminal_close", "Encerra a sessao e sua arvore de processos; tenta fechamento normal antes de forcar. Historico limitado fica temporariamente disponivel para leitura.", idSchema, false, ({ sessionId }) => manager.close(sessionId));
}
