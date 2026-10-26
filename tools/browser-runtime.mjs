import { chromium as playwrightChromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let ownedServer;
async function closeOwnedServer() {
  const pending = ownedServer; ownedServer = null;
  if (pending) await pending.then(server => server.close(), () => {});
}

export function validateQaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port || url.username || url.password) {
    throw new Error("QA_LOCAL_URL_REQUIRED: QA URLは専用ポートを持つhttp://127.0.0.1またはlocalhostに限定します。本番URLは使用できません。");
  }
  return url;
}

export async function startQaServer({ entry = "tools/dev-server.mjs", port = 0, timeout = 10000 } = {}) {
  const child = spawn(process.execPath, [path.resolve(root, entry)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PROGRESS_BOARD_PORT: String(port), PROGRESS_BOARD_QA_MODE: "1", PROGRESS_GEMINI_API_KEY: "", PROGRESS_AI_FREE_TIER_CONFIRMED: "false" },
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit").catch(() => {});
    child.kill();
    await exited;
  };
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = "", errorOutput = "";
      const timer = setTimeout(() => reject(new Error("QA_SERVER_TIMEOUT: ローカルQAサーバーが起動しませんでした。")), timeout);
      child.stderr.on("data", data => { errorOutput = (errorOutput + data).slice(-2000); });
      child.stdout.on("data", data => {
        output += data;
        const match = output.match(/Production board: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once("error", error => { clearTimeout(timer); reject(new Error(`QA_SERVER_START_FAILED: ${error.message}`)); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`QA_SERVER_START_FAILED: exit ${code}; ${errorOutput}`)); });
    });
    const response = await fetch(`${origin}/src/index.html`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`QA_SERVER_NOT_READY: HTTP ${response.status}`);
    return { origin, close };
  } catch (error) { await close(); throw error; }
}

export async function qaBaseUrl(defaultPath = "/src/index.html") {
  if (process.env.PROGRESS_BOARD_QA_URL) return validateQaUrl(process.env.PROGRESS_BOARD_QA_URL).href;
  ownedServer ||= startQaServer();
  return (await ownedServer).origin + defaultPath;
}

async function secureContext(context, origin) {
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["data:", "blob:"].includes(url.protocol) || url.origin === origin) return route.continue();
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url.href)) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.abort("blockedbyclient");
  });
  return context;
}

// Legacy QA retains its scenarios while sharing browser installation, server,
// isolation and the network boundary. No personal executable/runtime paths.
export const chromium = {
  async launch(options = {}) {
    const origin = validateQaUrl(await qaBaseUrl()).origin;
    let browser;
    try { browser = await playwrightChromium.launch({ headless: true, ...options }); }
    catch (error) {
      await closeOwnedServer();
      const code = /Executable doesn't exist/.test(error.message) ? "QA_BROWSER_MISSING: npm run qa:install でChromiumを導入してください。" : "QA_BROWSER_START_FAILED";
      throw new Error(`${code}\n${error.message}`);
    }
    const createContext = async options => secureContext(await browser.newContext({ serviceWorkers: "block", ...options }), origin);
    return new Proxy(browser, { get(target, key) {
      if (key === "newContext") return createContext;
      if (key === "newPage") return async options => (await createContext(options)).newPage();
      if (key === "close") return async () => {
        try { await browser.close(); }
        finally { await closeOwnedServer(); }
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  },
};

export async function selectQaView(page, name) {
  const button = page.locator(`[data-view="${name}"]`);
  if (!await button.isVisible()) await page.locator('[data-action="toggle-nav"]').click();
  await button.click();
  await page.locator(`[data-view-panel="${name}"]`).waitFor({ state: "visible" });
}

export async function waitForQaReady(page) {
  await page.waitForFunction(() => !document.body.classList.contains("is-starting") && /デモ|ローカル/.test(document.querySelector("#connection-label")?.textContent || ""));
}

export async function runBrowserQa(name, scenario, { paths = ["/src/index.html", "/dist/Index.html"] } = {}) {
  const output = path.resolve(root, "output/browser-qa", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(output, { recursive: true });
  const report = { suite: name, localDemoOnly: true, results: [], output };
  let browser;
  try {
    if (process.env.PROGRESS_BOARD_QA_URL) validateQaUrl(process.env.PROGRESS_BOARD_QA_URL);
    if (paths.some(file => file.startsWith("/dist/"))) {
      const build = spawnSync(process.execPath, ["tools/build-apps-script.mjs"], { cwd: root, encoding: "utf8", windowsHide: true });
      if (build.status !== 0) throw new Error(`QA_BUILD_FAILED: ${build.stderr || build.error || build.stdout}`);
    }
    const base = new URL(await qaBaseUrl());
    browser = await chromium.launch();
    for (const file of paths) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
      const label = file.startsWith("/dist/") ? "bundle" : "source";
      const errors = [];
      context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      try {
        await page.goto(new URL(file, base.origin).href, { waitUntil: "domcontentloaded" });
        await waitForQaReady(page);
        await scenario({ page, context, output, label, origin: base.origin });
        if (errors.length) throw new Error(`QA_PAGE_ERRORS: ${errors.join("; ")}`);
        report.results.push({ target: file, passed: true });
      } catch (error) {
        report.results.push({ target: file, passed: false, error: error.message });
        await page.screenshot({ path: path.join(output, `${label}-failure.png`), fullPage: true }).catch(() => {});
        process.exitCode = 1;
      } finally {
        await context.tracing.stop({ path: path.join(output, `${label}-trace.zip`) });
        await context.close();
      }
    }
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    else await closeOwnedServer();
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
  return report;
}
