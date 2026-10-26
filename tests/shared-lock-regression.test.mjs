import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = (await Promise.all(["Config.gs", "Parser.gs", "Repository.gs", "AccessControl.gs"].map(
  name => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8"),
))).join("\n");

function harness() {
  const state = { held: false, acquisitions: 0, releases: 0, fail: false };
  const lock = {
    waitLock(timeout) {
      assert.equal(timeout, 30000);
      if (state.fail || state.held) throw new Error("lock timeout");
      state.held = true;
      state.acquisitions += 1;
    },
    releaseLock() { assert.equal(state.held, true); state.held = false; state.releases += 1; },
  };
  const create = () => {
    const context = vm.createContext({ Date, Math, Number, Object, RegExp, String, JSON,
      LockService: { getDocumentLock: () => null, getScriptLock: () => lock },
    });
    vm.runInContext(source, context);
    return context;
  };
  return { state, context: create(), other: create() };
}

test("web, management and access paths contend for the same script mutex with a null document lock", () => {
  const { state, context, other } = harness();
  for (const entry of ["withDocumentLock_", "accessWithLock_"]) {
    assert.equal(context[entry](() => {
      assert.equal(state.held, true);
      for (const competing of ["withDocumentLock_", "accessWithLock_"]) {
        let wrote = false;
        assert.throws(() => other[competing](() => { wrote = true; }), /lock timeout/);
        assert.equal(wrote, false);
      }
      return "saved";
    }), "saved");
    assert.equal(state.held, false);
  }
  assert.equal(state.acquisitions, 2);
  assert.equal(state.releases, 2);
});

test("callback failure releases the mutex; acquisition failure never runs a writer or releases another lock", () => {
  const { state, context } = harness();
  assert.throws(() => context.withDocumentLock_(() => { throw new Error("write failed"); }), /write failed/);
  assert.equal(state.held, false);
  assert.equal(state.releases, 1);
  state.fail = true;
  let wrote = false;
  assert.throws(() => context.withDocumentLock_(() => { wrote = true; }), /lock timeout/);
  assert.equal(wrote, false);
  assert.equal(state.releases, 1);
});

test("an update through another entry point leaves a stale version rejected under the shared lock", () => {
  const { state, context, other } = harness();
  const stored = { id: "shared-job", version: 4 };
  context.ensureSystem_ = () => {};
  context.requireEditorAccess_ = () => ({ canEdit: true });
  context.saveJobUnlocked_ = input => {
    assert.equal(state.held, true);
    if (input.version !== stored.version) throw new Error("version conflict");
    stored.version += 1;
  };
  other.withDocumentLock_(() => { stored.version += 1; });
  assert.throws(() => context.saveJob({ id: stored.id, version: 4 }), /version conflict/);
  assert.equal(stored.version, 5);
});

test("verification mail delivery happens after releasing the workbook mutex", () => {
  const { state, context } = harness();
  context.Session = { getActiveUser: () => ({ getEmail: () => "" }), getEffectiveUser: () => ({ getEmail: () => "owner@example.com" }) };
  context.accessConfig_ = () => ({ users: [{ email: "editor@example.com" }] });
  context.accessSessionHash_ = () => "synthetic-session";
  context.accessCleanup_ = () => {};
  context.accessReadJson_ = () => null;
  context.accessWriteJson_ = () => assert.equal(state.held, true);
  context.accessNewCode_ = () => "12345678";
  context.accessHash_ = () => "synthetic-hash";
  context.Utilities = { getUuid: () => "synthetic-nonce" };
  let deliveries = 0;
  context.MailApp = { sendEmail() { assert.equal(state.held, false); deliveries += 1; } };
  context.requestAccessCode({ email: "editor@example.com" });
  assert.equal(deliveries, 1);
});
