# Historico de alteracoes

## 2.5.1 — 2026-09-11

- Shell direto com buffers de cauda limitados a 512 KiB por stream, contadores, flags de truncamento e cancelamento distinto de timeout.
- Encerramento da arvore em timeout/shutdown e erro explicito quando a terminacao nao pode ser confirmada.
- Shutdown administrativo local protegido, cleanup normal e fallback Windows com verificacao de identidade; sem alterar OAuth ou Cloudflare.
- Erros estruturados das tools de terminal e evento de lifecycle para encerramento forcado.
- Nove testes adicionais de lifecycle e referencia tecnica publicada para Desktop Commander. Regressao final: 45 testes aprovados, sem falhas ou ignorados, em aproximadamente 15 segundos no Windows/Node 24.11.0. As 41 tools permanecem disponiveis; sem dependencia nova.
- Limites: testes reais em Windows/Node 24; sem novo benchmark de velocidade, sem garantia para processos deliberadamente destacados. Pendencias npm anteriores permanecem descritas em SECURITY.md.

## 2.5.0 — 2026-09-11

### Adicionado

- Terminal interativo persistente com sete tools: `terminal_start`, `terminal_send`, `terminal_read`, `terminal_status`, `terminal_list`, `terminal_resize` e `terminal_close`.
- Backend PTY real com `node-pty` 1.1.0 opcional, executado em host isolado por sessao; perfis PowerShell, Python e Node e suporte a executaveis explicitos.
- Variaveis preservadas no processo, input sem Enter, controles, resize, leitura incremental UTF-8 e buffer limitado.
- Limites configuraveis, inatividade opcional, retencao e encerramento da arvore. Limpeza por perda de IPC apos parada abrupta do MCP.
- Testes automatizados de terminal, documentacao e regressao; [referencia completa](docs/TERMINAL.md) e atualizacao da [seguranca](SECURITY.md).
- Suite final: 36 testes aprovados, sem falhas ou testes ignorados, incluindo execucao do exemplo documentado. Conexao MCP local/publica autenticada validada com sessao persistente real.

### Preservado

- Contratos das 34 tools anteriores; agora sao 41 tools no total.
- `run_shell`, `run_shell_background`, tres workers por equipe, scheduler, locks, SQLite, Code Intelligence, OAuth e configuracao Cloudflare.
- Prazos anteriores: tarefas de workers ate 24 horas, shell direto ate 10 minutos e testes/esperas ate 5 minutos.
- Autor Paulo Augusto e licenca MIT (2026).

### Limites conhecidos

- Sessoes nao sobrevivem ao reinicio do MCP nem pertencem aos workers. Todos os clientes autenticados na instancia compartilham o registro de terminais.
- O novo terminal nao e sandbox nem fila de comandos; aguarde o prompt antes do proximo envio.
- Validacao real em Windows/Node 24.11.0. SSH/psql/mysql externos, Linux/macOS e menus de tela inteira nao foram certificados nesta entrega.
- Nao houve novo benchmark comparativo de velocidade. O README diferencia as medicoes historicas dos testes funcionais desta versao.
- A auditoria npm ainda aponta cinco pacotes com alertas, um alto; detalhes e escopo em [SECURITY.md](SECURITY.md).

### Atualizacao

Preserve `data/` e a configuracao do tunel, feche tarefas/sessoes ativas, pare somente o MCP quando o Cloudflare for gerenciado externamente, atualize o Git e execute `npm ci --include=optional`. Siga o [procedimento de atualizacao](docs/TERMINAL.md#atualizacao-e-operacao).
