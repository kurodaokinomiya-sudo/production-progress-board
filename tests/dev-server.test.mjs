import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { after, before, test } from "node:test";

let child;
let origin;

async function startServer(qaMode) {
  const server = spawn(process.execPath, ["tools/dev-server.mjs"], {
    env: { ...process.env, PROGRESS_BOARD_PORT: "0", PROGRESS_BOARD_QA_MODE: qaMode ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const serverOrigin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev server startup timed out: ${output}`)), 10000);
    server.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/Production board: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.once("error", error => { clearTimeout(timer); reject(error); });
    server.once("exit", code => { clearTimeout(timer); reject(new Error(`dev server exited: ${code}`)); });
  });
  return { server, origin: serverOrigin };
}

before(async () => {
  ({ child, origin } = await startServer(true));
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
});

async function request(path, host, requestOrigin) {
  const headers = { Host: host };
  if (requestOrigin !== undefined) headers.Origin = requestOrigin;
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: "127.0.0.1", port: url.port, path: url.pathname, headers }, response => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("dev server accepts local hosts and rejects untrusted or inconsistent hosts on every route", async () => {
  for (const host of ["127.0.0.1:4173", "localhost:4173"]) {
    const response = await request("/", host);
    assert.equal(response.status, 302);
  }
  assert.equal((await request("/", "evil.example:4173")).status, 403);
  assert.equal((await request("/src/index.html", "127.0.0.1:4173", "http://localhost:4173")).status, 403);
  assert.equal((await request("/api/local/ai-status", "evil.example:4173")).status, 403);
});

test("dev server serves scoped assets and rejects workspace files and traversal", async () => {
  assert.equal((await request("/src/index.html", "127.0.0.1:4173")).status, 200);
  assert.equal((await request("/tokens.css", "127.0.0.1:4173")).status, 200);
  assert.equal((await request("/dist/Index.html", "127.0.0.1:4173")).status, 200);
  for (const path of ["/package.json", "/apps-script/Code.gs", "/dist/Code.gs", "/tests/fixtures/order-pdf.mjs", "/node_modules/pdfjs-dist/package.json", "/src/%2e%2e/package.json"]) {
    assert.equal((await request(path, "127.0.0.1:4173")).status, 404, path);
  }
});

test("ordinary dev mode serves source files and excludes QA bundles", async () => {
  const normal = await startServer(false);
  try {
    const requestNormal = (path, host = `127.0.0.1:${new URL(normal.origin).port}`) => {
      const url = new URL(path, normal.origin);
      return new Promise((resolve, reject) => {
        const outgoing = httpRequest({ hostname: "127.0.0.1", port: url.port, path: url.pathname, headers: { Host: host } }, response => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        });
        outgoing.once("error", reject);
        outgoing.end();
      });
    };
    assert.equal(await requestNormal("/src/index.html"), 200);
    assert.equal(await requestNormal("/dist/Index.html"), 404);
  } finally {
    normal.server.kill();
    await once(normal.server, "exit");
  }
});
