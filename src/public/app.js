const elements = {
  serverStatus: document.querySelector("#serverStatus"),
  serverPort: document.querySelector("#serverPort"),
  authMode: document.querySelector("#authMode"),
  mcpUrl: document.querySelector("#mcpUrl"),
  publicUrl: document.querySelector("#publicUrl"),
  oauthPassword: document.querySelector("#oauthPassword"),
  tunnelMessage: document.querySelector("#tunnelMessage"),
  workers: document.querySelector("#workers"),
  refreshButton: document.querySelector("#refreshButton"),
  errorMessage: document.querySelector("#errorMessage")
};

async function getStatus() {
  const response = await fetch("/api/status", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Falha HTTP ${response.status}`);
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderWorkers(status) {
  const activeTeams = status.workers?.activeTeams || [];
  if (activeTeams.length === 0) {
    elements.workers.innerHTML = '<p class="empty">Nenhuma equipe ativa. Use <code>create_worker_team</code> no ChatGPT.</p>';
    return;
  }

  const cards = activeTeams.flatMap((entry) => entry.workers.map((worker) => {
    const task = worker.currentTask?.operation || "sem tarefa";
    return `
      <article class="worker-card">
        <div class="worker-heading">
          <strong>Worker ${worker.slot}</strong>
          <span class="worker-state state-${escapeHtml(worker.status)}">${escapeHtml(worker.status)}</span>
        </div>
        <dl>
          <div><dt>PID</dt><dd>${escapeHtml(worker.pid || "-")}</dd></div>
          <div><dt>Fila</dt><dd>${escapeHtml(worker.queuedTasks)}</dd></div>
          <div><dt>Tarefa</dt><dd>${escapeHtml(task)}</dd></div>
        </dl>
      </article>`;
  }));
  elements.workers.innerHTML = cards.join("");
}

function render(status) {
  elements.serverStatus.textContent = status.status;
  elements.serverStatus.classList.toggle("connected", status.status === "ligado");
  elements.serverPort.textContent = status.serverPort;
  elements.authMode.textContent = status.authMode;
  elements.mcpUrl.value = status.localMcpUrl;
  elements.publicUrl.value = status.publicMcpUrl || "nao configurado";
  elements.oauthPassword.value = status.oauthLoginPassword;
  elements.tunnelMessage.textContent = status.error || "Rota publica configurada.";
  renderWorkers(status);
}

async function refresh() {
  elements.refreshButton.disabled = true;
  try {
    render(await getStatus());
    elements.errorMessage.hidden = true;
    elements.errorMessage.textContent = "";
  } catch (error) {
    elements.errorMessage.hidden = false;
    elements.errorMessage.textContent = error.message;
  } finally {
    elements.refreshButton.disabled = false;
  }
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-copy]");
  if (!button) return;
  const input = document.querySelector(`#${button.dataset.copy}`);
  await navigator.clipboard.writeText(input.value);
  const original = button.textContent;
  button.textContent = "copiado";
  setTimeout(() => { button.textContent = original; }, 1200);
});

elements.refreshButton.addEventListener("click", refresh);
refresh();
setInterval(refresh, 3000);
