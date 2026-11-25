import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLocalOrderPdf } from "./local-pdf-parser.mjs";
import { parseLocalOrderText } from "./local-text-parser.mjs";
import { parseRememberedOrderAutomatically } from "./local-auto-import.mjs";
import { localProductMetadata } from "./local-product-master.mjs";
import { localAiStatus, parseLocalOrderAi, diagnoseLocalAi } from "./local-ai-import.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realRoot = await realpath(root);
const port = Number(process.env.PROGRESS_BOARD_PORT || 4173);
const qaMode = process.env.PROGRESS_BOARD_QA_MODE === "1";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

async function readJsonBody(request, maximumBytes = 12 * 1024 * 1024, tooLargeMessage = "PDFは8 MB以下にしてください。") {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error(tooLargeMessage);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function localRequestOrigin(request) {
  const host = request.headers.host;
  if (typeof host !== "string" || !host) return null;
  let requestUrl;
  try { requestUrl = new URL(`http://${host}`); } catch { return null; }
  if (!(["127.0.0.1", "localhost"].includes(requestUrl.hostname) && !requestUrl.username && !requestUrl.password && requestUrl.pathname === "/" && !requestUrl.search && !requestUrl.hash)) return null;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.origin !== requestUrl.origin || !["127.0.0.1", "localhost"].includes(parsedOrigin.hostname)) return null;
    } catch { return null; }
  }
  return requestUrl.origin;
}

function assetScope(requested) {
  if (requested === "/tokens.css") return { path: "tokens.css", root: realRoot };
  const source = requested.match(/^\/src\/([A-Za-z0-9._-]+\.(?:html|css|js))$/);
  if (source) return { path: `src/${source[1]}`, root: path.join(realRoot, "src") };
  if (qaMode) {
    const bundle = requested.match(/^\/dist\/(Index|Access)\.html$/);
    if (bundle) return { path: `dist/${bundle[1]}.html`, root: path.join(realRoot, "dist") };
  }
  return null;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

const server = createServer(async (request, response) => {
  try {
    const origin = localRequestOrigin(request);
    if (!origin) { sendJson(response, 403, { error: "ローカル画面から実行してください。" }); return; }
    const url = new URL(request.url, origin);
    if (url.origin !== origin) { sendJson(response, 403, { error: "ローカル画面から実行してください。" }); return; }
    if (url.pathname.startsWith("/api/local/")) {
      if (qaMode && ["/api/local/parse-order-ai", "/api/local/diagnose-ai"].includes(url.pathname)) {
        sendJson(response, 403, { error: "QAでは外部AIを呼び出せません。合成応答を使用してください。" });
        return;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/local/product-metadata") {
      const input = await readJsonBody(request);
      sendJson(response, 200, await localProductMetadata(input));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/local/ai-status") {
      sendJson(response, 200, qaMode ? { configured: false, ready: false } : localAiStatus());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/local/project-info") {
      if (qaMode) { sendJson(response, 200, { scriptEditorUrl: "" }); return; }
      try {
        const config = JSON.parse(await readFile(path.join(root, ".clasp.json"), "utf8"));
        const id = String(config.scriptId || "");
        sendJson(response, 200, { scriptEditorUrl: /^[A-Za-z0-9_-]+$/.test(id) ? `https://script.google.com/home/projects/${id}/edit` : "" });
      } catch { sendJson(response, 200, { scriptEditorUrl: "" }); }
      return;
    }
    if (request.method === "POST" && ["/api/local/parse-order-text", "/api/local/parse-order-auto"].includes(url.pathname)) {
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        sendJson(response, 415, { error: "JSON形式で送信してください。" });
        return;
      }
      try {
        const fileAuto = url.pathname === "/api/local/parse-order-auto";
        const input = await readJsonBody(request, (fileAuto ? 16 : 4) * 1024 * 1024, "本文・ファイルまたは補完情報が大きすぎます。");
        if (qaMode && input.engine === "ai") throw new Error("QAでは外部AIを呼び出せません。合成応答を使用してください。");
        const aiParser = qaMode ? async () => { throw new Error("QAでは外部AIを呼び出せません。合成応答を使用してください。"); } : undefined;
        const parsed = url.pathname === "/api/local/parse-order-auto"
          ? await parseRememberedOrderAutomatically(input, aiParser ? { aiParser } : {})
          : await parseLocalOrderText(input, aiParser ? { aiParser } : {});
        sendJson(response, 200, parsed);
      } catch (error) {
        sendJson(response, 400, { error: error.message || "本文を解析できませんでした。" });
      }
      return;
    }
    if (request.method === "POST" && ["/api/local/parse-order-ai", "/api/local/diagnose-ai"].includes(url.pathname)) {
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        sendJson(response, 415, { error: "JSON形式で送信してください。" });
        return;
      }
      try {
        const input = await readJsonBody(request);
        sendJson(response, 200, await (url.pathname === "/api/local/diagnose-ai" ? diagnoseLocalAi(input) : parseLocalOrderAi(input)));
      }
      catch (error) { sendJson(response, 400, { error: error.message || "AI取込に失敗しました。" }); }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/local/parse-order-pdf") {
      try {
        const input = await readJsonBody(request);
        if (!input || input.mimeType !== "application/pdf" || !input.base64) throw new Error("PDFデータがありません。");
        const bytes = Buffer.from(input.base64, "base64");
        if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("PDFは8 MB以下にしてください。");
        const parsed = await parseLocalOrderPdf(bytes, { subject: input.name || "" });
        sendJson(response, 200, parsed);
      } catch (error) {
        sendJson(response, 400, { error: error.message || "PDFを解析できませんでした。" });
      }
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(302, { Location: "/src/index.html" });
      response.end();
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const requested = decodeURIComponent(url.pathname);
    if (requested.includes("\\") || requested.split("/").some(part => part === "." || part === "..")) throw new Error("invalid asset path");
    const scope = assetScope(requested);
    if (!scope) throw new Error("not an allowed asset");
    const target = path.resolve(realRoot, scope.path);
    if (!isWithin(scope.root, target)) throw new Error("outside asset scope");
    const resolvedTarget = await realpath(target);
    if (!isWithin(scope.root, resolvedTarget)) throw new Error("outside asset scope");
    const info = await stat(resolvedTarget);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(resolvedTarget);
    response.writeHead(200, { "Content-Type": mime[path.extname(resolvedTarget).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Production board: http://127.0.0.1:${server.address().port}`);
});
