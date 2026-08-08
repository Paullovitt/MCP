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
scripts\start.bat
```

Ao ser aberto por duplo clique, o script usa `scripts/launch-hidden.js` para iniciar o processo Node oculto e totalmente desacoplado da janela. Em seguida, aguarda o health check confirmar o funcionamento e fecha automaticamente a janela após exibir o resumo por um instante. O servidor continua ligado em segundo plano. Se uma instância válida já estiver ativa, o script apenas confirma o estado e também fecha; ele não reinicia nem encerra a instância existente.

Parar com verificacao de identidade do processo:

```text
scripts\stop.bat
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
- `src/mcp-server.js`: publica tools MCP, OAuth, health check e interface na porta unica;
- `src/ui-server.js` e `src/public/`: entregam o painel restrito ao host local;
- `src/workers/team-manager.js`: gerencia equipes, dependencias, scheduler, filas, processos, bloqueios e recuperacao;
- `src/workers/worker-process.js`: executa operacoes estruturadas e pequenos lotes em cada worker;
- `src/storage/sqlite-store.js`: persiste equipes, tarefas, metricas, logs e bloqueios no SQLite;
- `src/code-intelligence/`: mantem o roteador central, cliente LSP, sessoes incrementais, parsers estruturais e inteligencia de projeto/dependencias;
- `src/tools/`: implementa filesystem, shell, Git, processos, npm, projeto e screenshot;
- `scripts/start.bat` e `scripts/stop.bat`: iniciam, detectam e encerram a instancia Windows com seguranca.
- `scripts/launch-hidden.js`: desacopla o processo Node da janela de inicializacao e redireciona sua saida para logs.

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
  "SERVER_PORT": 4194,
  "MCP_PORT": 4194,
  "WORKER_COUNT": 3,
  "OAUTH_ACCESS_TOKEN_TTL_SECONDS": 31536000,
  "OAUTH_REFRESH_TOKEN_TTL_SECONDS": 63072000,
  "PUBLIC_MCP_URL": null
}
```

Nao existe token estatico de compatibilidade. O endpoint MCP aceita somente access tokens emitidos pelo fluxo OAuth desta copia.

## URL publica

O ChatGPT precisa acessar uma URL HTTPS publica. Configure um hostname exclusivo para esta nova aplicacao, por exemplo:

```text
https://mcp-workers.seu-dominio.com/mcp
```

A rota do tunel deve apontar para:

```text
mcp-workers.seu-dominio.com -> http://127.0.0.1:4194
```

Depois, defina `PUBLIC_MCP_URL` em `data/config.json`:

```json
{
  "PUBLIC_MCP_URL": "https://mcp-workers.seu-dominio.com/mcp"
}
```

Nao reutilize um hostname que ainda esteja apontando para outra aplicacao local.

## Cadastro no ChatGPT

1. Inicie a aplicacao com `scripts\start.bat`.
2. Abra `http://127.0.0.1:4194` no navegador local.
3. Confirme que o endpoint MCP publico aparece como configurado.
4. No ChatGPT, abra as configuracoes de aplicativos ou conectores MCP.
5. Crie um novo aplicativo MCP.
6. Informe a URL publica completa terminando em `/mcp`.
7. Escolha autenticacao OAuth.
8. Inicie a conexao.
9. Na pagina de autorizacao, informe a senha OAuth mostrada apenas na interface local.
10. Conclua a autorizacao e volte ao ChatGPT.

O servidor implementa descoberta OAuth, registro dinamico de cliente, authorization code com PKCE S256, `offline_access`, refresh token com rotacao e Bearer access token.

## Tools de coordenacao

- `create_worker_team`
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
      "timeoutMs": 120000
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

## Testes

Executar a suite automatizada:

```powershell
npm test
```

Os testes criam projetos temporarios e validam contexto, definicao, referencias, completion, diagnosticos e invalidação para Python, C#, HTML/CSS e SQL. Tambem validam dependencias/instalacoes, o contrato das tools MCP, consultas simultaneas dos tres workers e comparacao automatica de erros antigos/novos depois de escritas. Nenhuma instalacao recomendada por `code_query` e executada durante os testes.

### Benchmark da validacao automatica

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
