# Seguranca

## Limites de confianca

O ChatGPT decide o trabalho. O coordenador e os workers apenas executam operacoes locais estruturadas. Os workers nao interpretam linguagem natural e nao possuem modelo de IA.

O usuario deve revisar comandos destrutivos antes de envia-los. Uma tarefa `run_shell` pode executar qualquer comando permitido pela conta do Windows.

## Controles implementados

### Rede

- Listener exclusivo em `127.0.0.1:4194`.
- MCP, OAuth e descoberta no mesmo servidor.
- Interface e `/api/status` restritos ao host local.
- `X-Powered-By` desativado.
- Limite de corpo JSON de 10 MB e formulario de 1 MB.

### Autenticacao

- MCP exige access token OAuth valido. Tokens novos sao assinados; tokens opacos antigos ainda validos no store local continuam aceitos na migracao.
- Authorization code com PKCE S256.
- `offline_access` e refresh tokens assinados para manter a conexao ao alternar entre instalacoes autorizadas.
- Senha OAuth gerada aleatoriamente por copia.
- Chave de assinatura com pelo menos 32 caracteres, mantida fora do Git; `INICIAR MCP.bat` pode deriva-la com SHA-256 da credencial do Cloudflare Tunnel. `scripts/start.bat` preserva a configuracao local sem fazer essa derivacao.
- Comparacao de senha com `crypto.timingSafeEqual`.
- Bloqueio temporario depois de repetidas tentativas incorretas.
- Redirect URI permitida somente com HTTPS ou HTTP em localhost.
- Store OAuth gravado com permissao solicitada `0600`.

### Credenciais e dados locais

Os seguintes caminhos sao ignorados pelo Git:

- `data/config.json`;
- `data/oauth-store.json`;
- `data/coordinator.sqlite*`;
- `data/runtime.json`;
- `logs/`;
- `screenshots/`.

Nao coloque senha OAuth, tokens ou conteudo do banco no README, em commits ou em tickets publicos.

### Workers

- Tres processos separados por equipe.
- Um worker executa somente uma tarefa por vez.
- Caminhos de arquivos e diretorios devem permanecer dentro da raiz escolhida para a equipe.
- Comandos mutantes enviados aos workers exigem `mutatesFiles: true` e `writePaths` declarados. Isso nao se aplica as sessoes PTY independentes.
- Cancelamento encerra a arvore do processo de comando.
- Timeout encerra a arvore do processo de comando.
- Comandos longos rodam assincronamente por no maximo 24 horas e continuam cancelaveis pelo `taskId`.
- Falha de tarefa nao encerra o worker; a fila pode continuar.
- Falha inesperada do processo worker libera bloqueios e tenta reiniciar o worker.

### Concorrencia

- Bloqueios persistidos no SQLite por caminho normalizado.
- Aquisição atomica em transacao `BEGIN IMMEDIATE`.
- Identificacao de equipe, worker e tarefa proprietarios.
- Expiracao e renovacao periodica.
- Liberacao em sucesso, erro, cancelamento, timeout e encerramento.
- Hash SHA-256, tamanho e mtime registrados antes da atribuicao.
- Releitura imediatamente antes da escrita.
- Alteracao externa causa falha segura em vez de sobrescrita.

### Inicializacao Windows

`STOP MCP.bat` verifica a identidade do Node dono da porta por linha de comando e runtime ou `INSTALL_ID` local. Ele tambem tenta parar o tunel Cloudflare do YAML, mesmo se a verificacao do MCP falhar. `scripts/stop.bat` para somente o MCP, confirmando runtime/linha de comando ou identidade local. Consulte o README antes de escolher o iniciador.

### Terminal persistente

- As sete tools `terminal_*` passam pela mesma autenticacao de `/mcp`; nao abrem porta publica adicional.
- O manager e compartilhado entre clientes OAuth da mesma instancia. Nao existe isolamento de sessoes por cliente ou usuario.
- PTYs executam com as permissoes do processo MCP: o host separado isola falhas nativas, nao e uma sandbox.
- Caminhos absolutos externos sao permitidos, como nas tools diretas. Terminais nao usam locks, scheduler ou validacao automatica dos workers.
- Quantidade de sessoes, buffers, leitura, entrada e retencao sao limitadas. O timeout de inatividade e opcional e vem desativado.
- Logs do terminal nao recebem entrada, saida, argumentos ou ambiente. O historico limitado fica em RAM e pode ser lido por clientes autenticados ate expirar.
- `MCP_*` nao e herdado nem aceito em overrides da CLI. Outras variaveis de ambiente podem conter segredos: isso nao elimina a necessidade de proteger a conta local.
- Saida ecoada pela CLI pode revelar segredos; o proprio PowerShell, Python ou outra ferramenta pode salvar historico/arquivos em disco.
- Shutdown e perda de IPC acionam encerramento. Servicos, tarefas agendadas e processos que escapem deliberadamente da arvore nao tem garantia de encerramento.
- O buffer nao e persistido no SQLite; descarte de memoria nao e apagamento criptografico nem limpeza de pagefile/backups.

Contratos e limitacoes operacionais: [guia do terminal](docs/TERMINAL.md).

## Riscos residuais

- `run_shell` nao e uma sandbox. Um comando pode acessar caminhos externos mesmo que o coordenador valide os caminhos declarados.
- O tunel HTTPS e a configuracao DNS ficam fora deste projeto e devem ser protegidos no provedor.
- A senha OAuth aparece na interface local por necessidade operacional; qualquer pessoa com acesso a sessao do Windows pode ve-la.
- Instalacoes que compartilham um dominio tambem compartilham `OAUTH_SHARED_TOKEN_SECRET`. A posse dessa chave permite validar ou emitir tokens, portanto ela deve ser transferida por um meio privado e protegida como uma senha.
- SQLite nativo requer Node.js 24 ou superior.
- A validade padrao dos tokens e longa. A normalizacao atual impoe pelo menos 365 dias ao access token e dois anos ao refresh token; reduzir apenas o JSON nao reduz esses prazos. Uma politica mais curta exige alteracao explicita de codigo e testes.

## Auditoria de dependencias em 11/09/2026

`npm audit --omit=dev` reportou cinco pacotes com alertas: `fast-uri` (alto), `hono`, `qs`, `express` e `body-parser` (moderados). Os resultados sao da arvore npm, nao uma demonstracao de exploracao desta aplicacao. Nenhum alerta dessa execucao foi atribuido a `node-pty`.

Essas pendencias nao foram corrigidas na entrega de documentacao/terminal. A atualizacao sugerida para Express inclui mudanca de versao principal; nao execute `npm audit fix --force` sem revisar compatibilidade e repetir os testes. Testes funcionais aprovados nao significam auditoria de seguranca limpa.

## Revisao antes de publicar

1. Confirme que `git status` nao inclui arquivos em `data/`, `logs/` ou screenshots.
2. Execute `npm audit`.
3. Execute `npm audit --omit=dev` e valide a inicializacao local com `npm start`.
4. Confirme que o hostname publico e exclusivo desta aplicacao.
5. Confirme que o tunel aponta apenas para `http://127.0.0.1:4194`.
6. Para revogar todos os tokens, pare as instalacoes, substitua `OAUTH_SHARED_TOKEN_SECRET` e reinicialize `data/oauth-store.json` em todas as copias antes de reiniciar e autorizar novamente. A troca da chave sozinha nao invalida entradas ainda validas aceitas pelo fallback do store; remover apenas o store nao invalida assinaturas da chave antiga. Essa operacao e administrativa, exige reconexao e nao deve apagar o banco dos workers ou outros dados. Proteja eventuais backups do store e nao restaure credenciais revogadas inadvertidamente.
