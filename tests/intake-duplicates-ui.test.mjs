import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parseLocalOrderText } from "../tools/local-text-parser.mjs";

const [source, duplicatesSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/intake-duplicates.js", import.meta.url), "utf8"),
]);

function order(overrides = {}) {
  return {
    customer: "重複確認商事", serialNo: "DUP-101", product: "ケリソンパンチ 18cm 上向 3mm",
    quantity: 2, dueDate: "2026-11-10", category: "ケリソンパンチ", note: "",
    ...overrides,
  };
}

function harness() {
  const storage = new Map([["production-board-demo-v2", JSON.stringify({
    jobs: [], intake: [], settings: {}, logs: [], localIntakeParserVersion: 2,
  })]]);
  let clock = Date.parse("2026-10-09T00:00:00Z");
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  let beforeLock = null;
  let lockTail = Promise.resolve();
  let lockCount = 0;
  const context = vm.createContext({
    Date: TestDate, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL,
    crypto: webcrypto, structuredClone, window: {}, document: { querySelector() { return null; }, querySelectorAll() { return []; } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    navigator: { locks: { request(name, callback) {
      assert.match(name, /intake-approval$/);
      lockCount += 1;
      const operation = lockTail.then(() => {
        if (beforeLock) { const change = beforeLock; beforeLock = null; change(); }
        return callback();
      });
      lockTail = operation.catch(() => {});
      return operation;
    } } },
    setTimeout, clearTimeout,
    fetch: async (path, options) => {
      if (path === "/api/local/parse-order-pdf") {
        return { ok: true, json: async () => ({ engineVersion: 2, text: "同名の注文書", results: [{ parsed: order(), itemNumber: 1 }] }) };
      }
      assert.equal(path, "/api/local/parse-order-text");
      const parsed = await parseLocalOrderText(JSON.parse(options.body));
      return { ok: true, json: async () => parsed };
    },
  });
  vm.runInContext(`${duplicatesSource}\n${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { api, MockApi };`, context);
  context.delay = async () => {};
  const api = context.ui.api;
  let nextId = 0;
  const addCandidate = (parsed = order(), overrides = {}) => {
    const id = `I-${++nextId}`;
    const candidate = { id, sourceType: "text", sourceRef: `paste:${id}`, parsed, status: "pending", parserVersion: 2, ...overrides };
    const data = api.read();
    data.intake.push(candidate);
    api.write(data);
    return candidate;
  };
  const addJob = (input = order(), overrides = {}) => {
    const job = { ...input, id: `J-${++nextId}`, version: 1, sourceType: "manual", sourceRef: "", shippingStatus: "not_ready", archived: false, ...overrides };
    const data = api.read();
    data.jobs.push(job);
    api.write(data);
    return job;
  };
  const request = (candidate, input = candidate.parsed, duplicateDecision) => ({
    intakeId: candidate.id, order: { ...input }, ...(duplicateDecision ? { duplicateDecision } : {}),
  });
  return { api, context, addCandidate, addJob, request,
    advanceClock: () => { clock += 1000; },
    beforeLock: (callback) => { beforeLock = callback; },
    get lockCount() { return lockCount; },
  };
}

test("同じ名前のPDFを同じ時刻に再取込しても確認待ちを消さず別IDで保持する", async () => {
  const h = harness();
  const input = { name: "注文書.pdf", mimeType: "application/pdf", base64: "test-only" };
  const first = (await h.api.createIntakeFromImage(input)).items[0];
  const repeated = (await h.api.createIntakeFromImage(input)).items[0];
  assert.equal(first.receivedAt, repeated.receivedAt);
  assert.notEqual(first.id, repeated.id);
  assert.notEqual(first.sourceRef, repeated.sourceRef);
  const data = h.api.read();
  assert.equal(data.intake.length, 2);
  assert.ok(data.intake.every((item) => item.status === "pending" && item.importFileName === input.name));
  assert.deepEqual(new Set(data.intake.map((item) => item.id)), new Set([first.id, repeated.id]));
  assert.equal(data.jobs.length, 0);
});

test("MockApiでも同じ本文の再貼付を個別・一括承認の両方で止める", async () => {
  const h = harness();
  const input = { name: "重複確認", text: "得意先: 重複確認商事\n連番: DUP-101\n品名: ケリソンパンチ 18cm 上向 3mm\n数量: 2\n納期: 2026-11-10" };
  const first = (await h.api.createIntakeFromText(input)).items[0];
  const saved = await h.api.approveIntake(h.request(first));
  h.advanceClock();
  const repeated = (await h.api.createIntakeFromText(input)).items[0];
  assert.notEqual(repeated.id, first.id);
  assert.notEqual(repeated.sourceRef, first.sourceRef);
  const single = await h.api.approveIntake(h.request(repeated));
  assert.equal(single.code, "INTAKE_DUPLICATE");
  assert.equal(single.matches[0].id, saved.id);
  assert.match(single.matches[0].reasons.join(" / "), /得意先・連番/);
  const bulk = await h.api.approveIntakes({ items: [h.request(repeated)] });
  assert.equal(bulk.errors[0].code, "INTAKE_DUPLICATE");
  assert.equal(bulk.items.length, 0);
  assert.equal(h.api.read().jobs.length, 1);
  assert.equal(h.api.read().intake.find((item) => item.id === repeated.id).status, "pending");
});

test("MockApiの警告は別経路の終了案件と確認待ち候補を対象・理由付きで返す", async () => {
  const h = harness();
  const completed = h.addJob(order(), { sourceType: "email", sourceRef: "gmail:old", shippingStatus: "shipped" });
  const pending = h.addCandidate(order(), { sourceType: "image", sourceRef: "upload:other" });
  const candidate = h.addCandidate();
  const result = await h.api.approveIntake(h.request(candidate));
  assert.equal(result.code, "INTAKE_DUPLICATE");
  assert.equal(result.matches.find((match) => match.id === completed.id).status, "completed");
  assert.equal(result.matches.find((match) => match.id === pending.id).kind, "intake");
  assert.ok(result.matches.every((match) => match.reasons.length > 0 && match.customer === order().customer));
  assert.equal(h.api.read().jobs.length, 1);
});

test("一括で編集した同じ連番の兄弟候補は両方を止め、確認後だけ別々に追加する", async () => {
  const h = harness();
  const first = h.addCandidate(order({ serialNo: "ORIGINAL-1" }));
  const second = h.addCandidate(order({ serialNo: "ORIGINAL-2" }));
  const requests = [h.request(first, order()), h.request(second, order())];
  const preview = await h.api.approveIntakes({ items: requests });
  assert.equal(preview.errors.length, 2);
  assert.ok(preview.errors.every((error) => error.code === "INTAKE_DUPLICATE" && error.matches[0].kind === "batch"));
  assert.equal(h.api.read().jobs.length, 0);
  assert.ok(h.api.read().intake.every((item) => item.status === "pending"));
  const result = await h.api.approveIntakes({ items: requests.map((request) => ({
    ...request, duplicateDecision: { action: "add_separate", signature: preview.errors.find((error) => error.intakeId === request.intakeId).duplicateSignature },
  })) });
  assert.equal(result.errors.length, 0);
  assert.equal(result.items.length, 2);
  assert.equal(h.api.read().logs.filter((log) => log.action === "intake.add_separate").length, 2);
});

test("別端末の先行登録はロック内の再照合で検知し、古い確認署名で追加しない", async () => {
  const h = harness();
  h.addJob();
  const candidate = h.addCandidate();
  const preview = await h.api.approveIntake(h.request(candidate));
  h.beforeLock(() => h.addJob(order({ product: "別端末で先行登録された注文" })));
  const result = await h.api.approveIntake(h.request(candidate, candidate.parsed, { action: "add_separate", signature: preview.duplicateSignature }));
  assert.equal(result.code, "INTAKE_DUPLICATE");
  assert.equal(result.matches.length, 2);
  assert.notEqual(result.duplicateSignature, preview.duplicateSignature);
  assert.equal(h.api.read().jobs.length, 2);
  assert.equal(h.lockCount, 2);
});

test("明示した追加注文を一度だけ記録し、通信再試行・二度押しは同じ案件へ戻る", async () => {
  const h = harness();
  h.addJob();
  const candidate = h.addCandidate();
  const preview = await h.api.approveIntake(h.request(candidate));
  const input = h.request(candidate, candidate.parsed, { action: "add_separate", signature: preview.duplicateSignature });
  const [saved, doublePressed] = await Promise.all([h.api.approveIntake(input), h.api.approveIntake(input)]);
  const retried = await h.api.approveIntake({ intakeId: candidate.id, order: {} });
  assert.equal(saved.id, doublePressed.id);
  assert.equal(saved.id, retried.id);
  assert.equal(h.api.read().jobs.length, 2);
  const logs = h.api.read().logs.filter((log) => log.action === "intake.add_separate");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].entityId, candidate.id);
  assert.equal(logs[0].detail.jobId, saved.id);
  assert.equal(logs[0].detail.matches[0].kind, "job");
});

test("得意先が違う同じ連番と連番なしは同じ品名・数量・納期でも通常登録できる", async () => {
  const h = harness();
  h.addJob();
  const differentCustomer = h.addCandidate(order({ customer: "別の得意先" }));
  const noSerial = h.addCandidate(order({ serialNo: "" }));
  const result = await h.api.approveIntakes({ items: [h.request(differentCustomer), h.request(noSerial)] });
  assert.equal(result.errors.length, 0);
  assert.equal(result.items.length, 2);
  assert.equal(h.api.read().jobs.length, 3);
  assert.equal(h.api.read().logs.filter((log) => log.action === "intake.add_separate").length, 0);
});

test("連番なしでも外部注文・明細を保持して照合し、別明細は通常登録できる", async () => {
  const h = harness();
  const first = h.addCandidate(order({ serialNo: "", externalOrderNo: "PO-100", externalLineNo: "1" }));
  const saved = await h.api.approveIntake(h.request(first, order({ serialNo: "" })));
  assert.equal(saved.externalOrderNo, "PO-100");
  assert.equal(saved.externalLineNo, "1");
  const repeated = h.addCandidate(order({ serialNo: "", externalOrderNo: "PO-100", externalLineNo: "1" }));
  const warning = await h.api.approveIntake(h.request(repeated));
  assert.equal(warning.code, "INTAKE_DUPLICATE");
  assert.match(warning.matches[0].reasons.join(" / "), /外部注文番号・明細番号/);
  const nextLine = h.addCandidate(order({ serialNo: "", externalOrderNo: "PO-100", externalLineNo: "2" }));
  const nextSaved = await h.api.approveIntake(h.request(nextLine));
  assert.ok(nextSaved.id);
  assert.equal(h.api.read().jobs.length, 2);
});

test("別注文として確認した後に数量を変えると再確認が必要になる", async () => {
  const h = harness();
  h.addJob();
  const candidate = h.addCandidate();
  const preview = await h.api.approveIntake(h.request(candidate));
  const result = await h.api.approveIntake(h.request(candidate, order({ quantity: 8 }), { action: "add_separate", signature: preview.duplicateSignature }));
  assert.equal(result.code, "INTAKE_DUPLICATE");
  assert.notEqual(result.duplicateSignature, preview.duplicateSignature);
  assert.equal(h.api.read().jobs.length, 1);
});

test("案件だけ保存済みの部分失敗を再試行しても別注文追加にせず残りの候補を承認する", async () => {
  const h = harness();
  const partiallySaved = h.addCandidate();
  const existing = h.addJob(order(), { sourceType: "intake", sourceRef: partiallySaved.id });
  const remaining = h.addCandidate(order({ serialNo: "DUP-102" }));
  const result = await h.api.approveIntakes({ items: [h.request(partiallySaved, {}), h.request(remaining)] });
  assert.equal(result.errors.length, 0);
  assert.equal(result.items[0].job.id, existing.id);
  assert.equal(h.api.read().jobs.length, 2);
  assert.ok(h.api.read().intake.every((item) => item.status === "approved"));
  assert.equal(h.api.read().logs.filter((log) => log.action === "intake.add_separate").length, 0);
});
