import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runShellCommand } from "./shell.js";
import { resolveInsideProject, relativeToProject } from "./path-utils.js";

const WINDOWS_BROWSER_PATHS = {
  chrome: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ],
  edge: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ],
  brave: [
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  ],
  firefox: [
    "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"
  ]
};

const POSIX_BROWSER_COMMANDS = {
  chrome: ["google-chrome", "chromium", "chromium-browser"],
  edge: ["microsoft-edge", "msedge"],
  brave: ["brave-browser", "brave"],
  firefox: ["firefox"]
};

async function findExistingPath(paths) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continua procurando outro navegador instalado.
    }
  }

  return null;
}

async function findBrowserExecutable(browser) {
  const candidates = browser === "auto" ? ["chrome", "edge", "brave", "firefox"] : [browser];

  for (const candidate of candidates) {
    if (os.platform() === "win32") {
      const executable = await findExistingPath(WINDOWS_BROWSER_PATHS[candidate] || []);
      if (executable) {
        return { browser: candidate, executable };
      }
      continue;
    }

    for (const command of POSIX_BROWSER_COMMANDS[candidate] || []) {
      const result = await runShellCommand(
        { command: `command -v ${command}`, cwd: ".", timeoutMs: 5000 },
        { projectRoot: process.cwd() }
      );

      if (result.exitCode === 0 && result.stdout.trim()) {
        return { browser: candidate, executable: result.stdout.trim() };
      }
    }
  }

  throw new Error(`Nenhum navegador compatível encontrado para: ${browser}`);
}

function quoteExecutable(executable) {
  // No PowerShell, executaveis entre aspas precisam do operador de chamada.
  return os.platform() === "win32" ? `& "${executable}"` : `"${executable}"`;
}

export function buildScreenshotCommand({ executable, browser, url, outputPath, width, height, waitMs, profileDir }) {
  const quotedExecutable = quoteExecutable(executable);
  const quotedOutput = `"${outputPath}"`;
  const quotedUrl = `"${url}"`;

  if (browser === "firefox") {
    return `${quotedExecutable} --headless --width ${width} --height ${height} --screenshot ${quotedOutput} ${quotedUrl}`;
  }

  return [
    quotedExecutable,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir="${profileDir}"`,
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${waitMs}`,
    `--screenshot=${quotedOutput}`,
    quotedUrl
  ].join(" ");
}

export async function captureBrowserScreenshot(input, { projectRoot }) {
  const outputDir = resolveInsideProject(projectRoot, input.outputDir || "screenshots");
  await fs.mkdir(outputDir, { recursive: true });

  const { browser, executable } = await findBrowserExecutable(input.browser || "auto");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `screenshot-${timestamp}.png`);
  const profileDir = path.join(outputDir, `.profile-${timestamp}`);
  const command = buildScreenshotCommand({
    executable,
    browser,
    url: input.url,
    outputPath,
    width: input.width ?? 1280,
    height: input.height ?? 720,
    waitMs: input.waitMs ?? 1000,
    profileDir
  });

  const result = await runShellCommand(
    {
      command,
      cwd: ".",
      timeoutMs: Math.max((input.waitMs ?? 1000) + 20_000, 30_000)
    },
    { projectRoot }
  );

  const stats = await fs.stat(outputPath).catch(() => null);

  await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});

  if (!stats || stats.size === 0) {
    throw new Error(`Screenshot não foi criado. stderr: ${result.stderr || "sem detalhes"}`);
  }

  return {
    browser,
    executable,
    outputPath: relativeToProject(projectRoot, outputPath),
    fileUrl: pathToFileURL(outputPath).href,
    bytes: stats.size,
    commandExitCode: result.exitCode,
    stderr: result.stderr
  };
}
