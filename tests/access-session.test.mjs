import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/access-session.js", import.meta.url), "utf8");
const STORAGE_KEY = "production-board-remembered-access-v1";
const token = "a".repeat(64);
const token2 = "b".repeat(64);

function makeSession({ initialToken = "", storageDenied = false } = {}) {
  const values = new Map(initialToken ? [[STORAGE_KEY, initialToken]] : []);
  const calls = [];
  const pending = [];
  const runner = {
    withSuccessHandler(callback) { this.success = callback; return this; },
    withFailureHandler(callback) { this.failure = callback; return this; },
  };
  for (const method of ["rememberAccessDevice", "restoreAccessSession"]) {
    runner[method] = (payload) => {
      calls.push({ method, payload });
      pending.push({ success: runner.success, failure: runner.failure });
    };
  }
  const storage = {
    getItem(key) {
      if (storageDenied) throw new Error("storage denied");
      return values.get(key) || null;
    },
    setItem(key, value) {
      if (storageDenied) throw new Error("storage denied");
      values.set(key, value);
    },
    removeItem(key) {
      if (storageDenied) throw new Error("storage denied");
      values.delete(key);
    },
  };
  const window = { google: { script: { run: runner } }, localStorage: storage, location: { href: "https://example.test/app" } };
  const context = vm.createContext({ window, location: window.location, globalThis: null, Map, Promise, Error, Boolean, String, Object });
  context.globalThis = context;
  vm.runInContext(source, context);
  return {
    api: context.AppAccessSession,
    window,
    calls,
    values,
    pending,
    succeed(index, result) { pending[index].success(result); },
    fail(index, error = new Error("server detail with secret")) { pending[index].failure(error); },
  };
}

test("save and hasCredential persist only correctly formatted tokens; clear removes them", () => {
  const session = makeSession();
  assert.equal(session.api.hasCredential(), false);
  assert.equal(session.api.save(token), true);
  assert.equal(session.api.hasCredential(), true);
  assert.equal(session.values.get(STORAGE_KEY), token);
  assert.equal(session.api.save("not-a-token"), false);
  assert.equal(session.values.get(STORAGE_KEY), token);
  session.api.clear();
  assert.equal(session.api.hasCredential(), false);
});

test("malformed or inaccessible storage falls back without an RPC", async () => {
  const malformed = makeSession({ initialToken: "xyz" });
  assert.equal(malformed.api.hasCredential(), false);
  assert.deepEqual(JSON.parse(JSON.stringify(await malformed.api.restore())), { ok: false });
  assert.equal(malformed.calls.length, 0);
  assert.equal(malformed.api.save("z".repeat(64)), false);

  const denied = makeSession({ storageDenied: true });
  assert.equal(denied.api.hasCredential(), false);
  assert.equal(denied.api.save(token), false);
  assert.deepEqual(JSON.parse(JSON.stringify(await denied.api.restore())), { ok: false });
  assert.equal(denied.calls.length, 0);
});

test("remember coalesces concurrent calls, stores the returned token, then caches success", async () => {
  const session = makeSession();
  const first = session.api.remember();
  const second = session.api.remember();
  assert.equal(first, second);
  assert.equal(session.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(session.calls[0])), {
    method: "rememberAccessDevice", payload: { deviceToken: "" },
  });
  session.succeed(0, { ok: true, remembered: true, deviceToken: token });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(session.values.get(STORAGE_KEY), token);
  assert.deepEqual(JSON.parse(JSON.stringify(await session.api.remember())), {
    ok: true, remembered: true, deviceToken: token,
  });
  assert.equal(session.calls.length, 1);
});

test("remember reports unavailable storage and permits retry", async () => {
  const session = makeSession({ storageDenied: true });
  const pending = session.api.remember();
  session.succeed(0, { ok: true, remembered: true, deviceToken: token });
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    ok: true, remembered: false, storageUnavailable: true, deviceToken: token,
  });
  assert.equal(session.calls.length, 1);
  const retry = session.api.remember();
  assert.equal(session.calls.length, 2);
  session.succeed(1, { ok: true, remembered: false });
  assert.deepEqual(JSON.parse(JSON.stringify(await retry)), { ok: true, remembered: false });
});

test("restore coalesces by openApp choice and sends the token only in the RPC payload", async () => {
  const session = makeSession({ initialToken: token });
  const first = session.api.restore({ openApp: true });
  const duplicate = session.api.restore({ openApp: true });
  const otherChoice = session.api.restore();
  assert.equal(first, duplicate);
  assert.notEqual(first, otherChoice);
  assert.equal(session.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(session.calls[0])), {
    method: "restoreAccessSession", payload: { deviceToken: token, openApp: true },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(session.calls[1])), {
    method: "restoreAccessSession", payload: { deviceToken: token, openApp: false },
  });
  session.succeed(0, { ok: true });
  session.succeed(1, { ok: true });
  await Promise.all([first, otherChoice]);
  assert.equal(session.window.location.href, "https://example.test/app");
});

test("restore clears an explicitly rejected credential but retains it after transient failure", async () => {
  const rejected = makeSession({ initialToken: token });
  const rejection = rejected.api.restore();
  rejected.succeed(0, { ok: false });
  assert.deepEqual(JSON.parse(JSON.stringify(await rejection)), { ok: false });
  assert.equal(rejected.api.hasCredential(), false);

  const transient = makeSession({ initialToken: token });
  const failure = transient.api.restore();
  transient.fail(0);
  await assert.rejects(failure, (error) => error.message === "service-unavailable" && !error.message.includes(token));
  assert.equal(transient.api.hasCredential(), true);
});
