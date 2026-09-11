import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

test("documentacao possui links locais validos e os sete contratos de terminal", async () => {
  for (const file of ["README.md", "SECURITY.md", "CHANGELOG.md", "docs/TERMINAL.md"]) {
    const content = await fs.readFile(path.join(root, file), "utf8");
    // Verifica referencias de arquivos, sem depender de rede nem executar exemplos de comandos destrutivos.
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/i.test(match[1])) continue;
      const target = match[1].split("#")[0];
      await assert.doesNotReject(fs.access(path.resolve(root, path.dirname(file), target)), `${file}: ${target}`);
    }
  }
  const guide = await fs.readFile(path.join(root, "docs/TERMINAL.md"), "utf8");
  for (const name of ["start", "send", "read", "status", "list", "resize", "close"]) {
    assert.ok(guide.includes(`### terminal_${name}`), `Contrato ausente: terminal_${name}`);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.author, "Paulo Augusto");
  assert.equal(manifest.license, "MIT");
  assert.ok(guide.includes(`Versao ${manifest.version}`));
});

test("exemplo publicado no guia executa e conserva variavel em PTY real", { timeout: 30_000 }, async () => {
  const guide = await fs.readFile(path.join(root, "docs/TERMINAL.md"), "utf8");
  const example = guide.match(/<!-- tested-terminal-example -->\s*```javascript\s*([\s\S]*?)```/);
  assert.ok(example, "Exemplo executavel nao encontrado.");
  // Executa o proprio bloco documentado, sem manter uma copia que possa divergir do README/guia.
  const { stdout, stderr } = await run(process.execPath, ["--input-type=module", "-e", example[1]], {
    cwd: root, windowsHide: true, timeout: 25_000, maxBuffer: 65_536
  });
  assert.equal(stdout.trim(), "500");
  assert.equal(stderr.trim(), "");
});
