import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/access.js", import.meta.url), "utf8");

function makeGate({ remembered = false, restore } = {}) {
  const listeners = new Map();
  const elements = Object.fromEntries([
    "email", "code", "request-form", "verify-form", "request-code", "verify-code", "access-status", "open-app", "retry-access", "access-title", "access-intro",
  ].map((id) => [id, {
    id, value: "", textContent: id === "request-code" ? "確認コードを送信" : id === "verify-code" ? "確認する" : "",
    dataset: {}, attributes: {}, disabled: false, hidden: ["open-app", "retry-access"].includes(id), focused: false,
    addEventListener(type, callback) { listeners.set(`${id}:${type}`, callback); },
    setAttribute(name, value) { this.attributes[name] = value; },
    reportValidity() { return true; },
    setCustomValidity(value) { this.customError = value; },
    focus() { this.focused = true; },
  }]));
  const calls = [];
  const intervals = new Map();
  let intervalId = 0;
  let now = 10_000;
  const runner = {
    withSuccessHandler(callback) { this.success = callback; return this; },
    withFailureHandler(callback) { this.failure = callback; return this; },
  };
  const google = { script: { run: runner } };
  for (const method of ["requestAccessCode", "verifyAccessCode"]) {
    runner[method] = (payload) => calls.push({ method, payload, success: runner.success, failure: runner.failure });
  }
  const window = {
    google,
    AppAccessSession: { hasCredential: () => remembered, restore: restore || (() => Promise.resolve({ ok: false })), save: () => true },
    setInterval(callback) { const id = ++intervalId; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
  };
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements[id] }, window,
    Date: { now: () => now },
  });
  const submit = async (id) => listeners.get(`${id}:submit`)({ preventDefault() {} });
  return { elements, calls, intervals, submit, window, click: (id) => listeners.get(`${id}:click`)(), advance(ms) { now += ms; for (const cb of [...intervals.values()]) cb(); } };
}

test("request response is generic and the resend button unlocks after 60 seconds", async () => {
  const gate = makeGate();
  gate.elements.email.value = "someone@example.com";
  const pending = gate.submit("request-form");
  assert.equal(gate.elements.email.disabled, true);
  assert.equal(gate.elements["verify-code"].disabled, true);
  gate.calls[0].success({ ok: true });
  await pending;
  assert.equal(gate.elements["access-status"].textContent, "入力したアドレスが対象の場合、確認コードを送信しました。");
  assert.equal(gate.elements["request-code"].disabled, true);
  assert.match(gate.elements["request-code"].textContent, /60 秒/);
  gate.advance(60_001);
  assert.equal(gate.elements["request-code"].disabled, false);
  assert.equal(gate.elements["request-code"].textContent, "確認コードを送信");
});

test("request RPC failure restores controls and permits another attempt", async () => {
  const gate = makeGate();
  gate.elements.email.value = "someone@example.com";
  const pending = gate.submit("request-form");
  gate.calls[0].failure(new Error("private server detail"));
  await pending;
  assert.equal(gate.elements.email.disabled, false);
  assert.equal(gate.elements["request-code"].disabled, false);
  assert.equal(gate.elements["access-status"].textContent.includes("private"), false);
  const retried = gate.submit("request-form");
  assert.equal(gate.calls.length, 2);
  gate.calls[1].success({ ok: true });
  await retried;
});

test("request and verification RPCs cannot overlap and payloads capture submitted values", async () => {
  const gate = makeGate();
  gate.elements.email.value = "first@example.com";
  const request = gate.submit("request-form");
  gate.elements.email.value = "changed@example.com";
  gate.elements.code.value = "01234567";
  await gate.submit("verify-form");
  assert.equal(gate.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(gate.calls[0].payload)), { email: "first@example.com" });
  gate.calls[0].success({ ok: true });
  await request;

  gate.elements.email.value = "verified@example.com";
  const verify = gate.submit("verify-form");
  gate.elements.email.value = "edited@example.com";
  gate.elements.code.value = "76543210";
  await gate.submit("request-form");
  assert.equal(gate.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(gate.calls[1].payload)), { email: "verified@example.com", code: "01234567", openApp: true });
  gate.calls[1].success({ ok: false });
  await verify;
});

test("remembered browser hides email forms and opens the authorized application automatically", async () => {
  let resolveRestore;
  const restoring = new Promise((resolve) => { resolveRestore = resolve; });
  const gate = makeGate({ remembered: true, restore: () => restoring });
  assert.equal(gate.elements["request-form"].hidden, true);
  assert.equal(gate.elements["verify-form"].hidden, true);
  assert.equal(gate.elements["access-title"].textContent, "ロード中…");
  const opened = [];
  gate.window.ProductionAppBootstrap = { open: async (html) => { opened.push(html); } };
  resolveRestore({ ok: true, appHtml: "authorized-application" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["authorized-application"]);
  assert.equal(gate.calls.length, 0);
});

test("a revoked remembered browser returns to first verification while connection failures offer retry", async () => {
  const revoked = makeGate({ remembered: true, restore: async () => ({ ok: false }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revoked.elements["request-form"].hidden, false);
  assert.equal(revoked.elements["verify-form"].hidden, false);
  let attempts = 0;
  const gate = makeGate({ remembered: true, restore: async () => {
    if (++attempts === 1) throw new Error("offline");
    return { ok: true, appHtml: "authorized-application" };
  } });
  const opened = [];
  gate.window.ProductionAppBootstrap = { open: async (html) => { opened.push(html); } };
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.elements["retry-access"].hidden, false);
  assert.equal(gate.elements["request-form"].hidden, true);
  gate.click("retry-access");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["authorized-application"]);
  assert.equal(gate.calls.length, 0);
});

test("verification blocks duplicates, keeps link hidden on failure, then reveals it on success", async () => {
  const gate = makeGate();
  gate.elements.email.value = "someone@example.com";
  gate.elements.code.value = "01234567";
  const failed = gate.submit("verify-form");
  const duplicate = gate.submit("verify-form");
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.elements["request-code"].disabled, true);
  gate.calls[0].success({ ok: false });
  await Promise.all([failed, duplicate]);
  assert.equal(gate.elements["open-app"].hidden, true);
  assert.equal(gate.elements["verify-code"].disabled, false);
  assert.equal(gate.elements["access-status"].attributes.role, "alert");

  const succeeded = gate.submit("verify-form");
  gate.calls[1].success({ ok: true });
  await succeeded;
  assert.equal(gate.elements["open-app"].hidden, false);
  assert.equal(gate.elements["open-app"].focused, true);
  assert.equal(gate.elements["open-app"].attributes.role, undefined);
  assert.equal(gate.elements["email"].disabled, true);
  assert.equal(gate.elements["verify-form"].hidden, true);
});
