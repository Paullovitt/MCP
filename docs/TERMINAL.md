# Referencia do terminal persistente

Versao 2.5.1 · Paulo Augusto · 2026 · [Licenca MIT](../LICENSE).

Este guia descreve o contrato implementado em [src/terminal](../src/terminal), sem substituir a [visao geral do projeto](../README.md). O objetivo e manter processos interativos com estado entre chamadas MCP. Nao e interface grafica, modelo de autocomplete ou substituto dos workers.

## Escolha da ferramenta

| Necessidade | Ferramenta |
|---|---|
| Comando curto com resultado e exit code | `run_shell` |
| Build/teste demorado que termina sozinho | `run_shell_background` + consulta por taskId |
| Tarefas paralelas com locks e Code Intelligence | Tools dos workers |
| Python/Node/PowerShell com estado ou CLI que pergunta y/n | `terminal_start` + send/read/close |

Um manager central atende todas as conexoes MCP. Cada sessao possui host Node isolado e uma PTY; nao ocupa nenhum dos tres workers. O addon e carregado somente no host, sob demanda. Reconectar o transporte MCP preserva o registro; reiniciar o servidor encerra os processos e perde as sessoes.

## Contrato comum

O resultado de sucesso contem o mesmo objeto em `structuredContent` e em `content[0].text` serializado como JSON. Nas sete tools novas, os dados ficam em `structuredContent.data`. Essas tools nao sao funcoes globais JavaScript: envie seus nomes e argumentos por `tools/call`, ou use a API interna do exemplo executavel mais abaixo.

`sessionId` tem formato `term_` seguido de UUID e deve ser o valor retornado por `terminal_start`. Um ID encerrado nunca e reutilizado. As tools de leitura nao compartilham nem avancam um cursor global: cada consumidor guarda seu proprio offset.

Confira `isError` antes de consumir `structuredContent.data`. Erros operacionais retornam `{data: null, error: {code, message}}` em `structuredContent`, sem stack; exemplos: `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, `CWD_NOT_FOUND` e `TERMINAL_ERROR`. Falhas nativas preservam seus codigos PTY. Erros de schema seguem o formato do SDK MCP; rede/OAuth/transporte sao independentes. Metadados de uma sessao retida podem apresentar `errorCode`.

### terminal_start

| Argumento | Tipo/padrao | Regra |
|---|---|---|
| `shell` | string, `powershell` | Perfil `powershell`, `python`, `node` ou executavel; nao e uma linha de comando shell |
| `cwd` | string, `.` | Relativo a raiz do MCP ou caminho absoluto; deve existir e ser diretorio |
| `args` | array de strings, opcional | Substitui, nao acrescenta, os argumentos do perfil; ate 128 argumentos de 8192 caracteres |
| `env` | objeto string/string, opcional | Ate 128 entradas e 64 KiB de JSON; valor ate 16384 caracteres, sem NUL; nomes `A-Z`, `a-z`, digitos e `_`, sem digito inicial |
| `cols` | inteiro, 120 | 2–500 |
| `rows` | inteiro, 30 | 2–500 |
| `idleTimeoutMs` | inteiro, configuracao local | 0 desativa; maximo 2147483647 ms |

PowerShell inicia com `-NoLogo -NoProfile`; Node usa o executavel do servidor com `-i`; Python usa `python.exe` no Windows ou `python3` fora dele com `-i -q`. `PYTHON_BASIC_REPL=1` evita depender de posicionamento visual do cursor; pode ser sobrescrito explicitamente em `env`.

O ambiente da CLI herda variaveis do MCP, exceto `MCP_*`; sobrescritas desse prefixo sao recusadas. O ambiente customizado pertence a CLI, nao ao host auxiliar. Nomes sao tratados sem distinguir maiusculas no Windows.

Retorna snapshot da sessao. O inicio tem prazo interno de 10 segundos. `running` confirma processo iniciado, nao que seu prompt ja esteja pronto. Nao existe timeout total de execucao para a sessao.

### terminal_send

Argumentos: `sessionId`, `data` (string obrigatoria) e `newline` (booleano, padrao `true`). O padrao acrescenta um unico CR (`\r`), equivalente a Enter. Com `false`, envia o texto/controles UTF-8 exatamente como fornecidos. Nao converte automaticamente um script multilinha em fila de comandos.

Entrada por chamada, incluindo Enter, limitada a 65536 bytes; envios IPC pendentes tambem sao limitados a 262144 bytes. Dados binarios arbitrarios fora de UTF-8 nao sao o contrato desta tool. `acceptedBytes` confirma envio ao host, nao execucao, conclusao ou sucesso do comando.

Retorno: `{sessionId, acceptedBytes, status}`. Para Ctrl+C, envie `{"sessionId":"ID_RETORNADO","data":"\u0003","newline":false}`. Para responder y/n, envie a resposta com Enter quando a CLI estiver aguardando.

### terminal_read

Argumentos: `sessionId`, `afterOffset` (inteiro >= 0, padrao 0), `maxBytes` (inteiro >= 4, padrao configurado) e `stripAnsi` (booleano, padrao `false`). O schema admite ate 262144 bytes, mas o manager recusa valores acima de `TERMINAL_READ_MAX_BYTES` da instalacao.

Retorno:

| Campo | Significado |
|---|---|
| `sessionId`, `status` | Sessao consultada e estado atual |
| `stream` | Sempre `combined`: stdout/stderr nao sao separados em PTY |
| `output` | Texto da pagina, mantendo ANSI salvo se solicitado filtro |
| `cursor` | Offset para a proxima leitura |
| `startOffset`, `endOffset` | Janela ainda retida e total de bytes recebidos |
| `truncatedBefore` | O cursor solicitado precede o historico retido; houve perda de dados antigos |
| `hasMore` | Existem mais bytes retidos a paginar |
| `bytes` | Bytes da pagina antes do filtro ANSI |

Uma leitura sem novidades retorna texto vazio imediatamente. Nao faz long polling e nao sinaliza fim de comando. Offset maior que `endOffset`, negativo ou nao inteiro e invalido. Reutilize sempre `cursor` com a mesma sessao, em vez de contar caracteres ou bytes do texto filtrado.

O buffer preserva caracteres UTF-8 completos nas paginas. Quando sobrescreve conteudo antigo, pode descartar tambem o inicio incompleto de um caractere. `stripAnsi` e um filtro por pagina, nao um emulador que reconstroi a tela; controles cortados entre paginas ou redesenhos podem exigir interpretacao do consumidor.

### terminal_status

Argumento: `sessionId`. Retorna snapshot com:

- identidade: `sessionId`, `pid` da CLI, `shell` resolvido, `backend: "pty"`, `stream: "combined"`;
- diretorio inicial: `cwd`, `cwdIsInitial: true` (nao acompanha `cd` feito dentro da CLI);
- tela: `cols`, `rows`;
- estado: `status`, `exitCode`, `signal`, `closeReason`, `errorCode`;
- horarios ISO: `createdAt`, `lastActivityAt`, `endedAt` (nulo enquanto ativa);
- limites: `idleTimeoutMs`, `bufferBytes`, `bufferLimitBytes`, `startOffset`, `endOffset`.

`exitCode` e `signal` podem ser nulos quando indisponiveis. Encerramento forcado nao inventa um exit code da CLI. Argumentos, ambiente e entrada nao aparecem no snapshot.

### terminal_list

Sem argumentos (`{}`). Retorna array de snapshots das sessoes ativas e encerradas ainda retidas. Nao inclui sessoes expiradas ou de outra instancia do servidor.

### terminal_resize

Argumentos obrigatorios: `sessionId`, `cols` e `rows` (inteiros entre 2 e 500). Retorna snapshot com as dimensoes solicitadas. Exige sessao `running`; entrega do IPC nao significa que a aplicacao ja terminou o redesenho.

### terminal_close

Argumento: `sessionId`. Aguarda encerramento da sessao e retorna snapshot. Repetir enquanto o ID ainda esta retido e seguro; apos expiracao, o ID e inexistente. Nao limpa imediatamente o historico retido e nao cria nova sessao.

No Windows, o alvo e o PID do host criado para a sessao, usando `taskkill /T`, seguido de `/F` se necessario. O processo nao e selecionado pelo nome de uma CLI nem por PID arbitrario recebido do cliente. Outros sistemas possuem caminho de encerramento por grupo da PTY, mas somente Windows foi validado nesta entrega.

## Estados e manutencao

```text
starting -> running -> exited (saida espontanea, mesmo com exit code diferente de zero)
    |          |
    +----------+-> closing -> closed (pedido, idle ou shutdown)
    +----------+------------> error (falha/crash detectado)
```

`starting` reserva vaga desde o primeiro instante, impedindo exceder o limite com aberturas concorrentes. Falha de inicializacao rejeita `terminal_start`; use `terminal_list` para consultar eventual registro de erro ainda retido.

`closeReason` pode indicar `requested`, `idle_timeout`, `shutdown`, `start_timeout`, `start_error` ou `ipc_error`. `errorCode` identifica falhas como `PTY_UNAVAILABLE`, `PTY_ERROR`, `PTY_CRASH`, `PTY_START_TIMEOUT`, `PTY_HOST_ERROR`, `PTY_HOST_CRASH` e `PTY_IPC_ERROR`; mensagens de sistema podem variar.

Ociosidade considera entrada, saida ou resize, nao consultas. Manutencao ocorre a cada 500 ms. Defaults e faixas dos cinco campos `TERMINAL_*` estao no [README](../README.md). A retencao por tempo e limitada tambem pela quantidade de sessoes encerradas. Saida intensa descarta historico antigo, nao cresce indefinidamente.

## Exemplo executavel sem OAuth

O exemplo abaixo exercita a mesma API interna usada pelas tools, sem HTTP, credenciais, banco ou workers. Salve-o como arquivo `.mjs` na raiz do repositorio e execute `node nome-do-arquivo.mjs`, ou envie o conteudo a `node --input-type=module`. Use Node 24+ e dependencias instaladas. Ele deve imprimir `500` e fechar a PTY no `finally`.

<!-- tested-terminal-example -->
```javascript
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { TerminalSessionManager } from "./src/terminal/session-manager.js";

const manager = new TerminalSessionManager({ projectRoot: process.cwd() });
let cursor = 0;
async function waitFor(sessionId, pattern) {
  let text = "";
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const page = manager.read({ sessionId, afterOffset: cursor, stripAnsi: true });
    if (page.truncatedBefore) throw new Error("Historico insuficiente para validar a resposta.");
    cursor = page.cursor;
    text += page.output;
    if (pattern.test(text)) return text;
    if (!page.hasMore) await delay(50);
  }
  throw new Error("Prompt/resultado nao chegou no prazo do exemplo.");
}

try {
  const { sessionId } = await manager.start({ shell: "node" });
  await waitFor(sessionId, /> /);
  await manager.send({ sessionId, data: "var x = 50" });
  await waitFor(sessionId, /undefined[\s\S]*> /);
  await manager.send({ sessionId, data: "console.log(x * 10)" });
  const output = await waitFor(sessionId, /^500\r?$/m);
  assert.match(output, /^500\r?$/m);
  console.log("500");
  await manager.close(sessionId);
} finally {
  // Libera hosts e handles mesmo se o exemplo falhar.
  await manager.stop();
}
```

O teste de documentacao extrai e executa esse bloco. Para integrar outro modulo, crie um unico `TerminalSessionManager` no bootstrap, injete-o em `startMcpHttpServer`/`createMcpServer` e chame `stop()` no shutdown; nao crie managers diferentes por requisicao. O bootstrap atual ja faz essa integracao. O construtor aceita `{projectRoot, logger, config}`; logger e opcional e config usa os campos `TERMINAL_*`.

## Atualizacao e operacao

Na 2.5.1, os scripts Windows pedem shutdown normal por canal local protegido e aguardam ate 15 segundos antes de forcar a arvore. O MCP bloqueia novas requisicoes, fecha terminais, cancela shells diretos e para workers/HTTP. A credencial efemera fica somente em `data/runtime.json`; nao e senha OAuth e nunca deve ser publicada. Instancias antigas usam fallback. Logs de lifecycle incluem `forced_termination` quando necessario, sem registrar entrada/saida.

1. Finalize/cancele tarefas e feche terminais que nao podem ser interrompidos. Guarde arquivos de trabalho; estado de REPL nao e salvo.
2. Confira `git status` e preserve alteracoes locais. Nao use reset forcado nem apague `data/` para atualizar.
3. Para tunel gerenciado externamente, execute `scripts\stop.bat`. O `STOP MCP.bat` da raiz tambem tenta parar o Cloudflare.
4. Execute `git pull --ff-only` e `npm ci --include=optional` na raiz; o npm recria somente sua arvore de dependencias, nao as credenciais do MCP.
5. Execute `npm test`.
6. Reinicie com `scripts\start.bat` no ambiente com Node global e tunel externo. O iniciador da raiz exige Node/npm locais e a configuracao especifica descrita no README.
7. Confirme `/health`, descoberta OAuth e uma chamada autenticada de `tools/list` (41 tools nesta versao). Health 200 sozinho nao comprova login OAuth nem execucao das tools.

A atualizacao nao requer novo dominio, senha ou tunel. As tools novas podem depender de nova descoberta do catalogo pelo cliente MCP. Nao revogue credenciais para atualizar apenas uma lista de tools.

## Diagnostico e limites conhecidos

| Sintoma | Verificacao |
|---|---|
| `PTY_UNAVAILABLE` | `npm ls node-pty --depth=0`; reinstale opcionais e confira logs npm/compatibilidade nativa |
| `PTY_ERROR` ao abrir | Executavel instalado, argumentos separados, cwd existente e permissoes |
| `PTY_START_TIMEOUT` | Host nao ficou pronto em 10 s; verifique ambiente/antivirus/addon sem compartilhar segredos |
| Limite de sessoes | Consulte `terminal_list`, feche as ativas desnecessarias ou ajuste limite conscientemente |
| Sem resposta ao envio | Aguarde prompt, verifique Enter, `status` e pagina de saida; nao envie repetidamente enquanto ocupado |
| Cursor invalido | Use o cursor retornado pela mesma sessao; nao reinicie offsets usando contagem de caracteres |
| `truncatedBefore: true` | Parte do historico foi descartada; leia mais frequentemente ou amplie buffer com custo de RAM |
| Sessao inexistente | Pode ter expirado, o servidor reiniciou ou outra instancia atende a URL |
| OAuth 401 | Falha de autenticacao; o terminal nao contorna a protecao existente |

As sessoes nao usam locks nem Code Intelligence automatico. Evite editar os mesmos arquivos simultaneamente por terminal e workers. Elas tem as permissoes da conta do MCP e compartilham estado entre clientes autorizados. Considere segredos ecoados, historico gravado pela propria CLI e processos deliberadamente destacados: veja [SECURITY.md](../SECURITY.md).

Nenhum teste desta entrega certifica conexoes SSH/bancos externos, tela inteira, isolamento multiusuario ou todos os sistemas operacionais. Sem integracao de persistencia SQLite e sem garantia de apagamento criptografico da RAM. Os testes nao sao benchmark de velocidade.

## Validacao

Execute `npm test` para regressao de OAuth, workers, limites, terminal e documentacao. Os testes de PTY exigem `node-pty` instalado; Python/PowerShell podem ser explicitamente ignorados se ausentes na plataforma. No ambiente Windows desta entrega ambos foram executados. Fixtures de banco/arquivos sao temporarias e isoladas; a suite nao altera configuracao, OAuth ou banco da instalacao real.
