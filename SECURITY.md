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

- MCP aceita somente Bearer token emitido pelo OAuth e assinado com a chave compartilhada da instalacao.
- Authorization code com PKCE S256.
- `offline_access` e refresh tokens assinados para manter a conexao ao alternar entre instalacoes autorizadas.
- Senha OAuth gerada aleatoriamente por copia.
- Chave de assinatura com pelo menos 32 caracteres, mantida fora do Git e derivada com SHA-256 da credencial do Cloudflare Tunnel quando a aplicacao inicia pelo script Windows.
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
- Tarefas de terminal mutantes exigem `mutatesFiles: true` e `writePaths` declarados.
- Cancelamento encerra a arvore do processo de comando.
- Timeout encerra a arvore do processo de comando.
- Comandos longos rodam de forma assincrona por no maximo 24 horas e continuam cancelaveis pelo `taskId`.
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

`STOP MCP.bat` exige correspondencia entre porta, PID, arquivo de runtime, raiz do projeto e linha de comando antes de encerrar um processo.

## Riscos residuais

- `run_shell` nao e uma sandbox. Um comando pode acessar caminhos externos mesmo que o coordenador valide os caminhos declarados.
- O tunel HTTPS e a configuracao DNS ficam fora deste projeto e devem ser protegidos no provedor.
- A senha OAuth aparece na interface local por necessidade operacional; qualquer pessoa com acesso a sessao do Windows pode ve-la.
- Instalacoes que compartilham um dominio tambem compartilham `OAUTH_SHARED_TOKEN_SECRET`. A posse dessa chave permite validar ou emitir tokens, portanto ela deve ser transferida por um meio privado e protegida como uma senha.
- SQLite nativo requer Node.js 24 ou superior.
- A validade padrao do access token e longa para evitar reconexoes frequentes. Reduza `OAUTH_ACCESS_TOKEN_TTL_SECONDS` localmente se preferir rotacao mais frequente.

## Revisao antes de publicar

1. Confirme que `git status` nao inclui arquivos em `data/`, `logs/` ou screenshots.
2. Execute `npm audit`.
3. Execute `npm audit --omit=dev` e valide a inicializacao local com `npm start`.
4. Confirme que o hostname publico e exclusivo desta aplicacao.
5. Confirme que o tunel aponta apenas para `http://127.0.0.1:4194`.
6. Para revogar todos os tokens compartilhados, gere um novo `OAUTH_SHARED_TOKEN_SECRET` em todas as instalacoes e autorize novamente. Remover apenas `data/oauth-store.json` nao revoga tokens assinados ainda validos.
