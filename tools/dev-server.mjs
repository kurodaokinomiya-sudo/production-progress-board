import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLocalOrderPdf } from "./local-pdf-parser.mjs";
import { parseLocalOrderText } from "./local-text-parser.mjs";
import { localAiStatus, parseLocalOrderAi, diagnoseLocalAi } from "./local-ai-import.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PROGRESS_BOARD_PORT || 4173);
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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/local/")) {
      if (!["127.0.0.1", "localhost"].includes(url.hostname) || (request.headers.origin && request.headers.origin !== url.origin)) {
        sendJson(response, 403, { error: "ローカル画面から実行してください。" });
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/local/ai-status") {
      sendJson(response, 200, localAiStatus());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/local/project-info") {
      try {
        const config = JSON.parse(await readFile(path.join(root, ".clasp.json"), "utf8"));
        const id = String(config.scriptId || "");
        sendJson(response, 200, { scriptEditorUrl: /^[A-Za-z0-9_-]+$/.test(id) ? `https://script.google.com/home/projects/${id}/edit` : "" });
      } catch { sendJson(response, 200, { scriptEditorUrl: "" }); }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/local/parse-order-text") {
      if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
        sendJson(response, 415, { error: "JSON形式で送信してください。" });
        return;
      }
      try {
        const input = await readJsonBody(request, 512 * 1024, "本文は30000文字以下にしてください。");
        sendJson(response, 200, await parseLocalOrderText(input));
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
    const target = path.resolve(root, `.${requested}`);
    if (!target.startsWith(root + path.sep)) throw new Error("outside workspace");
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(target);
    response.writeHead(200, { "Content-Type": mime[path.extname(target).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Production board: http://127.0.0.1:${port}`);
});
