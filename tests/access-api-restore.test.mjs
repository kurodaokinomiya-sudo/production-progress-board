import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("class AppsScriptApi"), app.indexOf("class MockApi"));

function harness(replies, restore) {
  let locked = 0, requests = 0, restores = 0;
  const runner = {
    withSuccessHandler(callback) { this.success = callback; return this; },
    withFailureHandler(callback) { this.failure = callback; return this; },
    getSnapshot() {
      requests += 1;
      const reply = replies.shift();
      if (reply instanceof Error) void this.failure(reply);
      else this.success(reply);
    },
  };
  const context = vm.createContext({
    window: { google: { script: { run: runner } }, AppAccessSession: {
      hasCredential: () => true,
      restore: async () => { restores += 1; return restore(); },
    } },
    handleAccessRequired: () => { locked += 1; },
  });
  vm.runInContext(source + "\nglobalThis.api = new AppsScriptApi();", context);
  return { api: context.api, counts: () => ({ requests, restores, locked }) };
}

test("an expired Google session is restored and the original request retries once without locking the app", async () => {
  const h = harness([new Error("ACCESS_DENIED: expired"), { jobs: ["kept"] }], async () => ({ ok: true }));
  assert.deepEqual(await h.api.getSnapshot(), { jobs: ["kept"] });
  assert.deepEqual(h.counts(), { requests: 2, restores: 1, locked: 0 });
});

test("a revoked credential or a repeated denial locks the app without an authentication retry loop", async () => {
  const revoked = harness([new Error("ACCESS_DENIED: removed")], async () => ({ ok: false }));
  await assert.rejects(revoked.api.getSnapshot(), /removed/);
  assert.deepEqual(revoked.counts(), { requests: 1, restores: 1, locked: 1 });
  const repeated = harness([new Error("ACCESS_DENIED: expired"), new Error("ACCESS_DENIED: removed")], async () => ({ ok: true }));
  await assert.rejects(repeated.api.getSnapshot(), /removed/);
  assert.deepEqual(repeated.counts(), { requests: 2, restores: 1, locked: 1 });
});

test("temporary restore failures retain the screen, and insufficient roles do not attempt session restoration", async () => {
  const offline = harness([new Error("ACCESS_DENIED: expired")], async () => { throw new Error("offline"); });
  await assert.rejects(offline.api.getSnapshot(), /通信状態/);
  assert.deepEqual(offline.counts(), { requests: 1, restores: 1, locked: 0 });
  const role = harness([new Error("EDITOR_REQUIRED: 編集権限が必要です")], async () => ({ ok: true }));
  await assert.rejects(role.api.getSnapshot(), /編集権限/);
  assert.deepEqual(role.counts(), { requests: 1, restores: 0, locked: 0 });
});

test("stock validation retains a machine-readable rejection code after formatting the Apps Script message", async () => {
  const rejected = harness([new Error("Error: FINISHED_STOCK_INVALID: 案件が別の端末で更新されています。")]);
  await assert.rejects(rejected.api.getSnapshot(), error => {
    assert.equal(error.code, "FINISHED_STOCK_INVALID");
    assert.doesNotMatch(error.message, /FINISHED_STOCK_INVALID/);
    return true;
  });
  const unknown = harness([new Error("通信応答を受信できませんでした。")]);
  await assert.rejects(unknown.api.getSnapshot(), error => error.code === undefined);
});
