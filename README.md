# MCP Worker Coordinator

Aplicacao local em Node.js que conecta uma unica conversa do ChatGPT a tres processos workers operacionais por meio do Model Context Protocol (MCP).

O ChatGPT continua sendo o unico componente inteligente. Os workers nao usam modelos, OpenAI API, Ollama, LM Studio ou outros agentes. Eles apenas executam operacoes estruturadas decididas pelo GPT.

## Arquitetura

```text
ChatGPT (uma unica conversa)
        |
        | OAuth + MCP
        v
Servidor unico http://127.0.0.1:4194
        |-----------------------------|
        v                             v
Coordenador de tarefas
 (DAG + LPT/EWMA + locks R/W)
                              CodeIntelligenceEngine
                              (TS + LSP + SQL + projetos)
   |        |        |
Worker 1 Worker 2 Worker 3
   \        |        /       /
     Projeto local escolhido
```

O mesmo servidor e a mesma porta atendem:

- interface local em `http://127.0.0.1:4194`;
- endpoint MCP em `http://127.0.0.1:4194/mcp`;
- health check em `http://127.0.0.1:4194/health`;
- descoberta OAuth em `/.well-known/...`;
- registro, autorizacao e token OAuth em `/oauth/...`.

A interface e `/api/status` aceitam somente acesso pelo host local. O endpoint MCP e os endpoints OAuth podem ser publicados por um tunel HTTPS.

## Requisitos

- Windows 10 ou 11;
- Node.js 24 ou superior;
- npm;
- um tunel HTTPS para cadastrar o MCP no ChatGPT, como Cloudflare Tunnel.

Python e analisado pelo Pyright empacotado no projeto, sem exigir instalacao global. Para C#, a analise estrutural funciona imediatamente. Roslyn nao esta integrado nesta versao e um futuro adapter tambem exigira um SDK .NET instalado no computador.

O armazenamento usa o modulo SQLite nativo do Node.js. Nenhum pacote SQLite externo e necessario.

Dependencias npm principais: `@modelcontextprotocol/sdk`, `express`, `zod`, `typescript` 6.0.3, `pyright`, `vscode-langservers-extracted` e `node-sql-parser`. As versoes exatas ficam registradas em `package-lock.json`.

## Instalacao

```powershell
cd C:\Users\USER\Downloads\CODIGOS\MCP
npm install
```

## Inicializacao e parada

Iniciar:

```text
INICIAR MCP.bat
```

Ao ser aberto por duplo clique, o script inicia o processo Node oculto e desacoplado da janela. Em seguida, aguarda o health check confirmar o funcionamento e fecha automaticamente a janela após exibir o resumo por um instante. O servidor continua ligado em segundo plano. Se uma instância valida ja estiver ativa, o script apenas confirma o estado e tambem fecha; ele nao reinicia nem encerra a instancia existente.

O iniciador da raiz usa `node.exe` e `.npm-local` na pasta do projeto e gerencia o Cloudflare configurado em `C:\Cloudflared`. Para instalacoes com Node.js/npm no PATH e tunel ja gerenciado externamente, os iniciadores compativeis `scripts/start.bat` e `scripts/stop.bat` continuam disponiveis: iniciam/param somente o MCP. `scripts/launch-hidden.js` mantem o servidor oculto. Essa alternativa preserva a chave OAuth local e nao deriva automaticamente a chave compartilhada do Cloudflare.

Parar com verificacao de identidade do processo:

```text
STOP MCP.bat
```

O script de parada encerra o processo somente quando todas estas condicoes sao verdadeiras:

1. o PID possui a porta 4194;
2. o PID e o mesmo registrado em `data/runtime.json`;
3. o registro aponta para esta pasta;
4. a linha de comando do processo Node contem o caminho absoluto desta copia.

Se outro processo estiver usando a porta, ele nao sera encerrado.

Logs do servidor:

```text
logs\server.log
```

As saídas do processo oculto ficam disponíveis em `logs\console.out.log` e `logs\console.err.log`. Falhas operacionais detalhadas continuam registradas em `logs\server.log`.

Ao iniciar, o terminal mostra somente o estado operacional consolidado, sem repetir o JSON interno do logger:

```text
MCP Worker Coordinator iniciado
Interface local: http://127.0.0.1:4194
Servidor MCP local: http://127.0.0.1:4194/mcp
Provedor do túnel: cloudflare
Autenticação MCP: OAuth
URL MCP pública: não configurada
Status do túnel: não configurado
Status do servidor: ligado
Logs: C:\Users\USER\Downloads\CODIGOS\MCP\logs\server.log
```

Quando `PUBLIC_MCP_URL` estiver configurada, o terminal mostra a URL e o status do túnel como `ligado`. Os eventos detalhados continuam disponíveis em `logs\server.log`.

## Modulos principais

- `src/index.js`: compoe configuracao, logger, servidor HTTP, tunel e coordenador;
- `src/timeouts.js`: centraliza os tetos usados como padrao na configuracao, tools e coordenador;
- `src/mcp-server.js`: publica tools MCP, OAuth, health check e interface na porta unica;
- `src/ui-server.js` e `src/public/`: entregam o painel restrito ao host local;
- `src/workers/team-manager.js`: gerencia equipes, dependencias, scheduler, filas, processos, bloqueios e recuperacao;
- `src/workers/worker-process.js`: executa operacoes estruturadas e pequenos lotes em cada worker;
- `src/storage/sqlite-store.js`: persiste equipes, tarefas, metricas, logs e bloqueios no SQLite;
- `src/code-intelligence/`: mantem o roteador central, cliente LSP, sessoes incrementais, parsers estruturais e inteligencia de projeto/dependencias;
- `src/tools/`: implementa filesystem, shell, Git, processos, npm, projeto e screenshot;
- `INICIAR MCP.bat` e `STOP MCP.bat`: iniciam, detectam e encerram a instancia Windows com seguranca.

Manter interface, MCP e OAuth no mesmo processo e na mesma porta reduz configuracao e pontos de falha. A interface continua isolada por `requireLocalRequest`, portanto um host separado para o painel nao e necessario no uso local atual.

## Configuracao local

Na primeira inicializacao, a aplicacao gera credenciais novas em:

```text
data\config.json
```

Esse arquivo e ignorado pelo Git. Os campos principais sao:

```json
{
  "INSTALL_ID": "gerado_localmente",
  "OAUTH_LOGIN_PASSWORD": "gerada_localmente",
  "OAUTH_SHARED_TOKEN_SECRET": "segredo_compartilhado_com_32_ou_mais_caracteres",
  "SERVER_PORT": 4194,
  "MCP_PORT": 4194,
  "WORKER_COUNT": 3,
  "WORKER_TASK_TIMEOUT_MS": 86400000,
  "FILE_LOCK_TTL_MS": 30000,
  "OAUTH_ACCESS_TOKEN_TTL_SECONDS": 31536000,
  "OAUTH_REFRESH_TOKEN_TTL_SECONDS": 63072000,
  "PUBLIC_MCP_URL": null
}
```

Nao existe token estatico de compatibilidade. O endpoint MCP aceita somente access tokens emitidos pelo fluxo OAuth e assinados com `OAUTH_SHARED_TOKEN_SECRET`.

`OAUTH_LOGIN_PASSWORD` pode ser diferente em cada computador. `OAUTH_SHARED_TOKEN_SECRET` deve ser igual em todas as instalacoes que alternam o mesmo dominio publico. Ao iniciar pelos scripts Windows, essa chave e derivada automaticamente da credencial do mesmo Cloudflare Tunnel e gravada apenas no `data/config.json` local.

## URL publica

O ChatGPT precisa acessar uma URL HTTPS publica. Configure um hostname exclusivo para esta nova aplicacao, por exemplo:

```text
https://mcp-workers.seu-dominio.com/mcp
```

A rota do tunel deve apontar para:

```text
mcp-workers.seu-dominio.com -> http://127.0.0.1:4194
```

No Windows, os scripts procuram automaticamente em `C:\Cloudflared` o arquivo `.yml` ou `.yaml` que contem `hostname: mcp2.luckytrevo.com`. O nome do arquivo pode ser diferente em casa e no servico.

Depois, defina `PUBLIC_MCP_URL` em `data/config.json`:

```json
{
  "PUBLIC_MCP_URL": "https://mcp-workers.seu-dominio.com/mcp"
}
```

Nao reutilize um hostname que ainda esteja apontando para outra aplicacao local.

## Cadastro no ChatGPT

1. Inicie a aplicacao com `INICIAR MCP.bat`.
2. Abra `http://127.0.0.1:4194` no navegador local.
3. Confirme que o endpoint MCP publico aparece como configurado.
4. No ChatGPT, abra as configuracoes de aplicativos ou conectores MCP.
5. Crie um novo aplicativo MCP.
6. Informe a URL publica completa terminando em `/mcp`.
7. Escolha autenticacao OAuth.
8. Inicie a conexao.
9. Na pagina de autorizacao, informe a senha OAuth mostrada apenas na interface local.
10. Conclua a autorizacao e volte ao ChatGPT.

O servidor implementa descoberta OAuth, registro dinamico de cliente, authorization code com PKCE S256, `offline_access` e access/refresh tokens assinados.

Referencia: [autenticacao de servidores MCP na documentacao oficial da OpenAI](https://developers.openai.com/plugins/build/auth).

## Uso em casa e no servico sem reconectar

Quando o mesmo dominio, como `https://mcp2.luckytrevo.com/mcp`, alterna entre dois computadores, as duas copias precisam usar a mesma chave de assinatura. Sem isso, o token criado no servico nao e reconhecido em casa e o ChatGPT pede a senha novamente.

Faca a atualizacao uma unica vez:

1. Atualize o projeto nos dois computadores com `git pull`.
2. Pare o MCP nos dois computadores.
3. Confirme que o YAML do Cloudflare nos dois computadores usa o mesmo tunel e contem a rota `hostname: mcp2.luckytrevo.com` com `credentials-file` configurado.
4. Confirme que `PUBLIC_MCP_URL` e a mesma nas duas copias.
5. Inicie apenas um dos computadores com `INICIAR MCP.bat`. O script deriva e salva a mesma chave nos dois ambientes sem exibi-la.
6. Reconecte o MCP no ChatGPT uma ultima vez para receber os novos tokens assinados.
7. Depois disso, pare uma instalacao antes de iniciar a outra. O mesmo token sera aceito nas duas.

Se uma instalacao nao usar o script ou nao tiver `credentials-file`, sincronize manualmente apenas o valor de `OAUTH_SHARED_TOKEN_SECRET` nos dois arquivos `data/config.json`.

Nao envie essa chave por chat, nao a coloque no README e nao a adicione ao Git. Nao e necessario copiar `OAUTH_LOGIN_PASSWORD`, `oauth-store.json` ou o banco SQLite. Alterar `OAUTH_SHARED_TOKEN_SECRET` revoga os tokens assinados anteriormente e exige uma nova autorizacao.

## Tools de coordenacao

- `create_worker_team`
- `run_shell_background`
- `assign_worker_task`
- `run_parallel_tasks`
- `get_team_status`
- `get_worker_status`
- `get_worker_logs`
- `get_worker_result`
- `send_worker_instruction`
- `cancel_worker_task`
- `wait_for_worker_tasks`
- `close_worker_team`

Cada equipe possui exatamente tres processos Node independentes.

## Comandos longos sem o limite pratico de 120 segundos

`run_shell` continua sincrono e deve ser usado para comandos que normalmente terminam em ate 90 segundos. Embora aceite ate 10 minutos, a chamada pode expirar no cliente MCP antes do processo local.

Para treino, build, instalacao ou outro processo demorado, use `run_shell_background`. A tool responde imediatamente com `teamId`, `workerId` e `taskId`; o worker continua executando por ate 24 horas. Tarefas comuns dos workers tambem usam 24 horas por padrao, sem precisar informar `timeoutMs`.

```json
{
  "projectPath": "C:\\caminho\\do\\projeto",
  "command": "python treinar.py",
  "cwd": ".",
  "timeoutMs": 86400000,
  "mutatesFiles": true,
  "writePaths": ["resultados", "checkpoints"]
}
```

Consulte com `get_worker_result`, acompanhe a saida com `get_worker_logs` e interrompa com `cancel_worker_task`. Comandos mutantes continuam exigindo `writePaths`, e a validacao automatica de Code Intelligence permanece ativa por padrao.

### Tempos padrao no maximo

| Operacao | Padrao quando o prazo e omitido | Teto aceito pela tool |
| --- | --- | --- |
| Tarefa de worker, inclusive em lotes e instrucoes seguintes | 24 horas | 24 horas por tarefa |
| `run_shell_background` | 24 horas | 24 horas |
| `run_shell` e `npm_install` diretos | 10 minutos | 10 minutos |
| `run_tests` direto | 5 minutos | 5 minutos |
| `wait_for_worker_tasks` e espera de `run_parallel_tasks` | 5 minutos | 5 minutos por chamada |

Um `timeoutMs` explicito menor continua sendo respeitado. A espera de resultados nao cancela uma tarefa: ao expirar, retorna o estado atual. O timeout da execucao cancela a operacao; comandos dos workers encerram sua arvore de processos. Estes valores limitam a execucao, nao a duracao total da equipe nem o tempo em fila.

Na primeira inicializacao, o prazo antigo de `120000` ms em `data/config.json` migra automaticamente para `86400000` ms. Outros prazos validos personalizados sao preservados; use `WORKER_TASK_TIMEOUT_MS: 86400000` para ativar o maximo e reinicie o MCP. Tarefas ja atribuidas mantem o prazo gravado no momento da atribuicao. Novas instalacoes ja recebem 24 horas por padrao.

Prazos maiores toleram operacoes demoradas, mas tambem demoram mais a interromper comandos travados. Para acompanhar comandos longos, prefira a tool em segundo plano: aumentar o prazo local nao altera limites de espera do cliente MCP ou do tunel.

Os tempos internos de protecao permanecem independentes: Language Server (15 segundos por requisicao), inicializacao de worker (8 segundos), locks (30 segundos, renovados a cada 10 segundos), limpeza de historico (12 horas) e validade OAuth nao foram ampliados.

### Testes dos limites

```powershell
npm test
```

`test/timeouts.test.js` verifica schemas pelo protocolo MCP, configuracao, execucao com tres workers, espera sem cancelamento, cancelamento explicito, timeout e regressao de escrita. Os testes usam diretorios temporarios e SQLite isolado, removidos ao finalizar. Os valores de 24 horas sao verificados sem esperar um dia; a interrupcao real e exercitada com prazos curtos.

`test/oauth.test.js` verifica descoberta, senha, PKCE, uso unico de codigo, refresh entre instalacoes com a mesma chave e rejeicao de assinatura/recurso invalidos. Tokens locais antigos tambem sao testados. Servidores HTTP de teste escutam apenas em loopback e usam credenciais temporarias.

## Tools de Code Intelligence

- `code_context`: contexto composto de um simbolo, com definicao, assinatura, referencias, chamadas, imports, dependentes, testes, trecho e diagnosticos;
- `code_query`: consulta pontual com as acoes semanticas `symbols`, `definition`, `references`, `hover`, `callHierarchy`, `imports` e `completion`, alem de `project`, `dependencies`, `installation`, `files`, `relatedFiles` e `languageCapabilities`;
- `code_diagnostics`: erros sintaticos, semanticos e sugestoes do projeto ou de um arquivo.

As tres tools usam uma unica sessao incremental por projeto. O mesmo motor atende o MCP e requisicoes IPC dos workers; os Language Servers nao sao carregados tres vezes.

## Operacoes dos workers

- `read_file`
- `list_files`
- `search_files`
- `write_file`
- `apply_patch`
- `create_directory`
- `copy_path`
- `move_path`
- `delete_path`
- `run_shell`
- `run_tests`
- `git_status`
- `git_diff`
- `batch_operations`
- `code_context`
- `code_query`
- `code_diagnostics`

Para comandos de terminal que alteram arquivos, use `params.mutatesFiles: true` e declare todos os caminhos em `writePaths`. O coordenador recusara uma tarefa mutante sem caminhos declarados.

## Exemplos de uso

Criar uma equipe para um projeto:

```json
{
  "projectPath": "C:\\Users\\USER\\Downloads\\CODIGOS\\MEU-PROJETO",
  "name": "Revisao do projeto"
}
```

Obter contexto estrutural antes de alterar um simbolo:

```json
{
  "projectPath": "C:\\Users\\USER\\Downloads\\CODIGOS\\MCP",
  "symbol": "acquireLocks",
  "maxReferences": 100,
  "maxChars": 20000
}
```

Localizar simbolos ou pedir completion em uma posicao:

```json
{
  "projectPath": "C:\\Users\\USER\\Downloads\\CODIGOS\\MCP",
  "action": "definition",
  "symbol": "runParallelTasks"
}
```

Um worker usa a mesma inteligencia com `assign_worker_task`:

```json
{
  "teamId": "ID_DA_EQUIPE",
  "operation": "code_context",
  "params": { "symbol": "acquireLocks", "maxChars": 12000 }
}
```

## Funcionamento do Code Intelligence

O `MultiLanguageWorkspace` escolhe automaticamente o provider pela extensao do arquivo ou localiza um simbolo em todos os providers quando apenas o nome e informado:

- JavaScript/TypeScript: TypeScript Language Service 6.0.3, com tipos, referencias, chamadas, completion e diagnosticos;
- Python: Pyright Language Server, com inferencia de tipos, imports, completion, referencias e diagnosticos;
- HTML: VS Code HTML Language Server, incluindo simbolos, atributos, completion e diagnosticos;
- CSS/SCSS/LESS: VS Code CSS Language Server;
- SQL: parser estrutural com tabelas, colunas, views, procedures, referencias, completion e diagnosticos por dialeto (`sqlite`, `postgresql`, `mysql` ou `transactsql`);
- C#: scanner estrutural para namespaces, classes, records, interfaces, metodos, propriedades, campos, variaveis, referencias e completion. Roslyn completo e anunciado como nao integrado, e o computador atual tambem nao possui SDK .NET;
- Projeto: inventario de arquivos/pastas, manifests, linguagens, testes, arquivos relacionados, dependencias npm/pip/NuGet/web e comandos seguros de instalacao.

Cada sessao mantem versoes e snapshots incrementais. Escritas feitas pelas tools ou workers invalidam os caminhos afetados imediatamente; alteracoes externas sao detectadas por tamanho e `mtimeNs`. Resultados possuem limites de itens/caracteres e informam truncamento.

Os servidores sao iniciados sob demanda e encerrados ao fechar a ultima equipe do projeto. Pastas como `node_modules`, `.git`, builds, ambientes Python e cobertura sao ignoradas. A acao `installation` somente recomenda comandos e verifica ambientes; ela nunca instala ou altera dependencias automaticamente.

### Validacao automatica das escritas

Tarefas `write_file`, `apply_patch`, `copy_path`, `move_path`, `delete_path`, lotes e comandos mutantes usam `intelligenceMode: "always"` por padrao. O coordenador aplica a validacao somente a linguagens suportadas e manifests; imagens, logs e textos comuns nao pagam esse custo.

Enquanto mantem o bloqueio do arquivo, o coordenador:

1. coleta diagnosticos, simbolos e arquivos relacionados antes da escrita;
2. executa a operacao no worker;
3. invalida o indice central;
4. coleta os diagnosticos depois;
5. separa erros novos, resolvidos e antigos inalterados;
6. compara alteracoes de dependencias e bibliotecas;
7. inclui o resumo em `result.intelligence`.

Os modos aceitos sao `always` (padrao), `auto` (mesma selecao automatica de providers) e `off`. Um erro antigo deslocado de linha nao e classificado como novo porque a comparacao usa arquivo, provider, codigo, categoria e mensagem. Quando aparece um erro novo, `result.intelligence.status` recebe `failed`; a escrita e preservada para permitir correcao, e o evento fica registrado nos logs. O worker nao inventa uma correcao sem instrucao do GPT.

Consultar dependencias e comandos de instalacao:

```json
{
  "projectPath": "C:\\projetos\\aplicacao",
  "action": "installation"
}
```

Obter contexto de uma tabela SQL:

```json
{
  "projectPath": "C:\\projetos\\aplicacao",
  "file": "database/schema.sql",
  "symbol": "users",
  "dialect": "postgresql"
}
```

Pedir completion Python:

```json
{
  "projectPath": "C:\\projetos\\aplicacao",
  "action": "completion",
  "file": "src/service.py",
  "line": 42,
  "column": 18
}
```

Enviar uma leitura ao Worker 1:

```json
{
  "teamId": "ID_DA_EQUIPE",
  "workerId": "ID_DO_WORKER_1",
  "operation": "read_file",
  "params": {
    "path": "src/index.js"
  }
}
```

Aplicar um patch com bloqueio automatico:

```json
{
  "teamId": "ID_DA_EQUIPE",
  "workerId": "ID_DO_WORKER_2",
  "operation": "apply_patch",
  "params": {
    "path": "src/config.js",
    "search": "const oldValue = true;",
    "replace": "const oldValue = false;"
  },
  "intelligenceMode": "always",
  "lockPolicy": "wait"
}
```

Executar tres tarefas independentes em paralelo:

```json
{
  "teamId": "ID_DA_EQUIPE",
  "wait": true,
  "tasks": [
    {
      "operation": "search_files",
      "params": { "path": "src", "query": "TODO" }
    },
    {
      "operation": "git_diff",
      "params": { "cwd": "." }
    },
    {
      "operation": "run_tests",
      "params": { "cwd": ".", "command": "npm test" },
      "timeoutMs": 86400000
    }
  ]
}
```

Encadear tarefas por dependencias. Os IDs em `dependsOn` sao locais ao lote e ciclos sao rejeitados antes da persistencia:

```json
{
  "teamId": "ID_DA_EQUIPE",
  "wait": true,
  "tasks": [
    {
      "id": "gerar",
      "operation": "write_file",
      "params": { "path": "build/input.txt", "content": "alpha" },
      "estimatedDurationMs": 80
    },
    {
      "id": "ajustar",
      "dependsOn": ["gerar"],
      "operation": "apply_patch",
      "params": { "path": "build/input.txt", "search": "alpha", "replace": "beta" }
    }
  ]
}
```

Agrupar operacoes pequenas em uma unica tarefa e uma unica troca IPC:

```json
{
  "teamId": "ID_DA_EQUIPE",
  "operation": "batch_operations",
  "params": {
    "operations": [
      { "operation": "write_file", "params": { "path": "a.txt", "content": "A" } },
      { "operation": "write_file", "params": { "path": "b.txt", "content": "B" } }
    ]
  }
}
```

Comando que modifica arquivo:

```json
{
  "teamId": "ID_DA_EQUIPE",
  "operation": "run_shell",
  "params": {
    "cwd": ".",
    "command": "npm run format",
    "mutatesFiles": true
  },
  "writePaths": [
    "src",
    "test"
  ]
}
```

## Scheduler, dependencias e bloqueios

Tarefas prontas usam LPT (maior duracao primeiro) e seguem para o worker com menor carga estimada. A estimativa pode ser informada por `estimatedDurationMs`; sem esse campo, o coordenador usa a media movel exponencial (EWMA) do historico da operacao. `get_team_status` mostra carga projetada, espera media e estatisticas aprendidas.

`run_parallel_tasks` aceita um DAG por `id` e `dependsOn`. Uma tarefa bloqueada so recebe snapshot e entra na fila depois que todas as dependencias concluem. Falha, timeout ou cancelamento se propaga aos descendentes com `dependency_failed`.

Antes de executar uma tarefa, o coordenador:

1. normaliza e valida os caminhos dentro do projeto da equipe;
2. registra hash SHA-256, tamanho e data de alteracao;
3. adquire bloqueios compartilhados de leitura e exclusivos de escrita em uma transacao SQLite;
4. identifica equipe, worker e tarefa proprietarios do bloqueio;
5. rele o arquivo antes de enviar a tarefa ao worker;
6. recusa a escrita se outro processo tiver alterado o arquivo;
7. renova o bloqueio durante a execucao;
8. libera automaticamente em sucesso, erro, timeout, cancelamento ou encerramento.

Os bloqueios sao hierarquicos e sem diferenca entre maiusculas e minusculas no Windows. Por exemplo, uma escrita em `src` conflita com leitura ou escrita em `src/api/index.js`; duas leituras da mesma arvore podem executar em paralelo.

`lockPolicy` pode ser:

- `wait`: aguarda a liberacao; se o arquivo tiver mudado, exige nova leitura e nova instrucao;
- `reject`: falha imediatamente com os dados do proprietario do bloqueio.

## Armazenamento

Banco local:

```text
data\coordinator.sqlite
```

O banco registra:

- equipes;
- workers;
- tarefas e filas;
- mensagens e instrucoes;
- estados;
- resultados;
- logs;
- bloqueios;
- dependencias entre tarefas;
- estimativas e historico EWMA por operacao;
- horarios;
- erros;
- arquivos utilizados.

O SQLite usa WAL, foreign keys e timeout de concorrencia.

### Retencao automatica

O banco continua centralizado em `data\coordinator.sqlite`, sem criar arquivos ocultos dentro dos projetos trabalhados. Ao iniciar e depois a cada doze horas, o coordenador verifica o `projectRoot` de cada equipe. Quando a pasta realmente nao existe (`ENOENT` ou `ENOTDIR`), ele encerra qualquer worker relacionado e remove, em transacao, equipe, workers, tarefas, mensagens, logs e bloqueios.

Erros temporarios de acesso ou permissao preservam o historico. O SQLite usa `secure_delete` e o WAL e truncado depois da limpeza. As metricas EWMA globais permanecem porque nao contem caminho, conteudo nem identificacao do projeto.

O indice de Code Intelligence permanece somente em memoria: codigo-fonte, ASTs e respostas estruturais nao sao gravados no SQLite. A sessao e descartada ao fechar a ultima equipe do projeto, apagar sua pasta ou encerrar o servidor.

## Benchmark da validacao automatica

Em cinco rodadas no Windows com Node.js 24, tres escritas JavaScript paralelas levaram mediana de 95 ms com validacao desligada e 303 ms com a sessao aquecida em modo `always`: custo absoluto de 208 ms por lote. A inicializacao fria levou 699 ms. Operacoes sem escrita permaneceram no mesmo caminho rapido; seis tarefas de 600 ms obtiveram mediana de 1745 ms com tres workers e 4910 ms com um worker, speedup de 2,814x.

## Seguranca

- A aplicacao escuta somente em `127.0.0.1`.
- A interface administrativa e a senha OAuth nao sao servidas pelo host publico.
- O MCP exige access token OAuth valido.
- Senhas, tokens, banco, runtime e logs nao sao rastreados pelo Git.
- A senha OAuth usa comparacao resistente a diferenca de tempo.
- Tentativas repetidas de senha sao limitadas temporariamente.
- Redirect URIs dinamicas aceitam apenas HTTPS ou callback HTTP local.
- Workers so aceitam caminhos declarados dentro do projeto da equipe.
- Escritas conflitantes nao sobrescrevem arquivos silenciosamente.
- Comandos e resultados ficam registrados.

Veja tambem `SECURITY.md`.

## Licenca e autoria

MIT License. Autor: Paulo Augusto. Ano: 2026. Consulte `LICENSE` para o texto completo.
