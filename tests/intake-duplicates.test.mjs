import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = (await Promise.all([
  "src/intake-duplicates.js", "apps-script/Config.gs", "apps-script/Parser.gs", "apps-script/Repository.gs", "apps-script/Import.gs",
].map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")))).join("\n");
const copy = (value) => JSON.parse(JSON.stringify(value));
const order = (overrides = {}) => ({
  customer: "重複確認商事", product: "ケリソンパンチ 18cm 上向 3mm", dueDate: "2026-11-10", quantity: 2,
  serialNo: "DUP-101", category: "ケリソンパンチ", ...overrides,
});

function harness() {
  let uuid = 0, locked = false, beforeLock;
  const tables = new Map();
  const calls = { locks: 0, writes: 0, logs: [] };
  const context = vm.createContext({ Date, Math, Number, Object, String, JSON, RegExp, Error,
    requireEditorAccess_: () => ({ role: "owner", canEdit: true }),
    Utilities: { getUuid: () => `UUID-${++uuid}` },
    SpreadsheetApp: { flush: () => {} },
    LockService: { getScriptLock: () => ({
      waitLock: () => { if (beforeLock) { const callback = beforeLock; beforeLock = null; callback(); } locked = true; calls.locks += 1; },
      releaseLock: () => { locked = false; },
    }) },
  });
  vm.runInContext(source, context);
  function sheet(name, headers) {
    const grid = [Array.from(headers)];
    tables.set(name, grid);
    return {
      getLastRow: () => grid.length,
      getRange: (row, column, height = 1, width = 1) => ({
        getValues: () => Array.from({ length: height }, (_, offset) => Array.from({ length: width }, (_, cell) => grid[row - 1 + offset]?.[column - 1 + cell] ?? "")),
        setValues: (values) => {
          assert.equal(locked, true, "data writes must stay inside the document lock");
          calls.writes += 1;
          for (const [offset, value] of values.entries()) {
            if (!grid[row - 1 + offset]) grid[row - 1 + offset] = [];
            value.forEach((cell, cellIndex) => { grid[row - 1 + offset][column - 1 + cellIndex] = cell; });
          }
        },
        setValue: (value) => {
          assert.equal(locked, true, "status writes must stay inside the document lock");
          calls.writes += 1;
          grid[row - 1][column - 1] = value;
        },
      }),
    };
  }
  const sheets = new Map([
    [context.APP.SHEETS.JOBS, sheet(context.APP.SHEETS.JOBS, context.APP.JOB_HEADERS)],
    [context.APP.SHEETS.INTAKE, sheet(context.APP.SHEETS.INTAKE, context.APP.INTAKE_HEADERS)],
    [context.APP.SHEETS.LOG, sheet(context.APP.SHEETS.LOG, context.APP.LOG_HEADERS)],
  ]);
  Object.assign(context, {
    ensureSystem_: () => {}, getSpreadsheet_: () => ({ getSheetByName: (name) => sheets.get(name) }),
    appendLog_: (action, entityType, entityId, detail) => {
      calls.logs.push({ action, entityType, entityId, detail: copy(detail) });
      tables.get(context.APP.SHEETS.LOG).push([new Date().toISOString(), action, entityType, entityId, "owner", JSON.stringify(detail)]);
    },
  });
  function addCandidate(parsed = order(), extras = {}) {
    return context.withDocumentLock_(() => context.appendIntake_({ parsed, status: "pending", sourceType: "text", sourceRef: `source-${++uuid}`, ...extras }));
  }
  function addJob(input = order(), extras = {}) {
    return context.withDocumentLock_(() => context.saveJobUnlocked_({ ...input, ...extras }));
  }
  const request = (candidate, edited = candidate.parsed, decision) => ({ intakeId: candidate.id, order: edited, ...(decision ? { duplicateDecision: decision } : {}) });
  return { context, calls, tables, addCandidate, addJob, request, beforeLock: (callback) => { beforeLock = callback; } };
}

test("同じ本文を再貼付すると別sourceRefでも個別・一括承認で登録を止める", () => {
  const h = harness();
  const input = { name: "重複確認", text: "得意先: 重複確認商事\n連番: DUP-101\n品名: ケリソンパンチ 18cm 上向 3mm\n数量: 2\n納期: 2026-11-10" };
  const first = h.context.createIntakeFromText(input).items[0];
  const saved = h.context.approveIntake(h.request(first));
  const repeated = h.context.createIntakeFromText(input).items[0];
  assert.notEqual(repeated.sourceRef, first.sourceRef);
  const single = h.context.approveIntake(h.request(repeated));
  assert.equal(single.code, "INTAKE_DUPLICATE");
  assert.equal(single.matches[0].id, saved.id);
  assert.match(single.matches[0].reasons.join(" / "), /得意先・連番/);
  const bulk = h.context.approveIntakes({ items: [h.request(repeated)] });
  assert.equal(bulk.errors[0].code, "INTAKE_DUPLICATE");
  assert.equal(bulk.items.length, 0);
  assert.equal(h.context.readJobs_().length, 1);
  assert.equal(h.context.readIntake_().at(-1).status, "pending");
});

test("別経路・終了案件・確認待ちを比較し、一致対象と理由を返す", () => {
  const h = harness();
  const existing = h.addJob(order(), { sourceType: "email", sourceRef: "gmail:old" });
  Object.assign(existing, { shippingStatus: "shipped", completedAt: "2024-05-06T01:02:03.000Z",
    stages: Object.fromEntries(Array.from(h.context.APP.STAGES, (stage) => [stage, { status: "done", assignee: "" }])) });
  h.tables.get(h.context.APP.SHEETS.JOBS)[1] = Array.from(h.context.jobToRow_(existing));
  const waiting = h.addCandidate(order(), { sourceType: "image", sourceRef: "upload:waiting" });
  const candidate = h.addCandidate();
  const result = h.context.approveIntake(h.request(candidate));
  assert.equal(result.code, "INTAKE_DUPLICATE");
  assert.equal(result.matches.find((match) => match.id === existing.id).status, "completed");
  assert.equal(result.matches.find((match) => match.id === waiting.id).kind, "intake");
  assert.equal(h.context.readJobs_().length, 1);
});

test("新規の出荷済み登録はlegacyの出所やクライアントの移行指定でも全数戻りを回避できない", () => {
  const h = harness();
  const input = { ...order(), sourceType: "legacy", sourceRef: "legacy:forged:1", shippingStatus: "shipped",
    stages: Object.fromEntries(Array.from(h.context.APP.STAGES, (stage) => [stage, { status: "done", assignee: "" }])),
    historicalImport: true, normalizationOptions: { historicalImport: true } };
  assert.throws(() => h.context.saveJob(input), /研磨の全数発送と全数の戻り/);
  assert.equal(h.calls.writes, 0);
  assert.equal(h.calls.logs.length, 0);
});

test("同じ一括承認内の編集済み別候補を照合し全件を警告で止める", () => {
  const h = harness();
  const first = h.addCandidate(order({ serialNo: "ORIGINAL-1" }));
  const second = h.addCandidate(order({ serialNo: "ORIGINAL-2" }));
  const result = h.context.approveIntakes({ items: [h.request(first, order()), h.request(second, order())] });
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0].matches[0].kind, "batch");
  assert.equal(result.errors[0].matches[0].serialNo, "DUP-101");
  assert.equal(h.context.readJobs_().length, 0);
  assert.ok(h.context.readIntake_().every((item) => item.status === "pending"));
});

test("別端末が先に登録した案件をロック取得後に検知し既知の署名では追加しない", () => {
  const h = harness();
  h.addJob();
  const candidate = h.addCandidate();
  const preview = h.context.approveIntake(h.request(candidate));
  h.beforeLock(() => h.addJob(order({ product: "追加された別案件" }), { sourceRef: "other-terminal" }));
  const result = h.context.approveIntake(h.request(candidate, candidate.parsed, { action: "add_separate", signature: preview.duplicateSignature }));
  assert.equal(result.code, "INTAKE_DUPLICATE");
  assert.equal(result.matches.length, 2);
  assert.notEqual(result.duplicateSignature, preview.duplicateSignature);
  assert.equal(h.context.readJobs_().length, 2);
});

test("明示した別注文だけ追加し事実を履歴へ残し同じ候補の再試行では再追加しない", () => {
  const h = harness();
  h.addJob();
  const candidate = h.addCandidate();
  const preview = h.context.approveIntake(h.request(candidate));
  const request = h.request(candidate, candidate.parsed, { action: "add_separate", signature: preview.duplicateSignature });
  const saved = h.context.approveIntake(request);
  assert.ok(saved.id);
  assert.equal(h.context.readJobs_().length, 2);
  const retry = h.context.approveIntake({ intakeId: candidate.id, order: {} });
  assert.equal(retry.id, saved.id);
  assert.equal(h.context.readJobs_().length, 2);
  const logs = h.calls.logs.filter((log) => log.action === "intake.add_separate");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].entityId, candidate.id);
  assert.equal(logs[0].detail.jobId, saved.id);
  assert.equal(logs[0].detail.matches[0].kind, "job");
});

test("別注文と確認した候補の注文内容を後から変えると確認が必要になる", () => {
  const h = harness();
  h.addJob();
  const candidate = h.addCandidate();
  const preview = h.context.approveIntake(h.request(candidate));
  const result = h.context.approveIntake(h.request(candidate, order({ quantity: 5 }), { action: "add_separate", signature: preview.duplicateSignature }));
  assert.equal(result.code, "INTAKE_DUPLICATE");
  assert.equal(h.context.readJobs_().length, 1);
});

test("異なる得意先の同じ連番と連番のない候補は品名数量納期が同じでも通常登録する", () => {
  const h = harness();
  h.addJob();
  const differentCustomer = h.addCandidate(order({ customer: "別の得意先" }));
  const noSerial = h.addCandidate(order({ serialNo: "" }));
  const result = h.context.approveIntakes({ items: [h.request(differentCustomer), h.request(noSerial)] });
  assert.equal(result.errors.length, 0);
  assert.equal(result.items.length, 2);
  assert.equal(h.context.readJobs_().length, 3);
});

test("空欄連番でも外部注文・明細を保持して照合し同注文の異なる明細は追加できる", () => {
  const h = harness();
  const first = h.addCandidate(order({ serialNo: "", externalOrderNo: "PO-100", externalLineNo: "1" }));
  const saved = h.context.approveIntake(h.request(first, order({ serialNo: "" })));
  assert.equal(saved.externalOrderNo, "PO-100");
  assert.equal(saved.externalLineNo, "1");
  const sameLine = h.addCandidate(order({ serialNo: "", externalOrderNo: "PO-100", externalLineNo: "1" }));
  const result = h.context.approveIntake(h.request(sameLine));
  assert.equal(result.code, "INTAKE_DUPLICATE");
  assert.match(result.matches[0].reasons[0], /外部注文番号・明細番号/);
  const otherLine = h.addCandidate(order({ serialNo: "", externalOrderNo: "PO-100", externalLineNo: "2" }));
  const otherSaved = h.context.approveIntake(h.request(otherLine));
  assert.ok(otherSaved.id);
  assert.equal(h.context.readJobs_().length, 2);
});

test("別注文確認後に候補状態の保存が失敗しても再試行は既存案件を確定する", () => {
  const h = harness();
  h.addJob();
  const candidate = h.addCandidate();
  const preview = h.context.approveIntake(h.request(candidate));
  const original = h.context.updateIntakeStatus_;
  let fail = true;
  h.context.updateIntakeStatus_ = (...args) => { if (fail) { fail = false; throw new Error("候補状態保存失敗"); } return original(...args); };
  assert.throws(() => h.context.approveIntake(h.request(candidate, candidate.parsed, { action: "add_separate", signature: preview.duplicateSignature })), /候補状態保存失敗/);
  assert.equal(h.context.readJobs_().length, 2);
  assert.equal(h.context.readIntake_().at(-1).status, "pending");
  const retry = h.context.approveIntake({ intakeId: candidate.id, order: {} });
  assert.ok(retry.id);
  assert.equal(h.context.readJobs_().length, 2);
  assert.equal(h.context.readIntake_().at(-1).status, "approved");
  assert.equal(h.calls.logs.filter((log) => log.action === "intake.add_separate").length, 1);
});

test("一括の兄弟候補をそれぞれ別注文と確認すると同じロック内で追加できる", () => {
  const h = harness();
  const first = h.addCandidate(), second = h.addCandidate();
  const requests = [h.request(first), h.request(second)];
  const preview = h.context.approveIntakes({ items: requests });
  const decisions = preview.errors.map((error) => ({ action: "add_separate", signature: error.duplicateSignature }));
  const result = h.context.approveIntakes({ items: requests.map((request, index) => ({ ...request, duplicateDecision: decisions[index] })) });
  assert.equal(result.errors.length, 0);
  assert.equal(result.items.length, 2);
  assert.equal(h.context.readJobs_().length, 2);
  assert.equal(h.calls.logs.filter((log) => log.action === "intake.add_separate").length, 2);
});

test("案件作成後の別注文履歴保存失敗は再試行で補完し同じ案件を確定する", () => {
  const h = harness();
  h.addJob();
  const candidate = h.addCandidate();
  const preview = h.context.approveIntake(h.request(candidate));
  const appendLog = h.context.appendLog_;
  let fail = true;
  h.context.appendLog_ = (...args) => {
    if (args[0] === "intake.add_separate" && fail) { fail = false; throw new Error("別注文履歴保存失敗"); }
    return appendLog(...args);
  };
  assert.throws(() => h.context.approveIntake(h.request(candidate, candidate.parsed, { action: "add_separate", signature: preview.duplicateSignature })), /別注文履歴保存失敗/);
  assert.equal(h.context.readJobs_().length, 2);
  assert.equal(h.context.readIntake_().at(-1).status, "pending");
  assert.equal(h.calls.logs.filter((log) => log.action === "intake.add_separate").length, 0);
  const retry = h.context.approveIntake({ intakeId: candidate.id, order: {} });
  assert.ok(retry.id);
  assert.equal(h.context.readJobs_().length, 2);
  assert.equal(h.context.readIntake_().at(-1).status, "approved");
  assert.equal(h.calls.logs.filter((log) => log.action === "intake.add_separate").length, 1);
  h.context.approveIntake({ intakeId: candidate.id, order: {} });
  assert.equal(h.calls.logs.filter((log) => log.action === "intake.add_separate").length, 1);
});

test("別注文の案件保存が失敗したときは追加した事実の履歴を作らない", () => {
  const h = harness();
  h.addJob();
  const candidate = h.addCandidate();
  const preview = h.context.approveIntake(h.request(candidate));
  h.context.saveJobUnlocked_ = () => { throw new Error("案件保存失敗"); };
  assert.throws(() => h.context.approveIntake(h.request(candidate, candidate.parsed, { action: "add_separate", signature: preview.duplicateSignature })), /案件保存失敗/);
  assert.equal(h.context.readJobs_().length, 1);
  assert.equal(h.context.readIntake_().at(-1).status, "pending");
  assert.equal(h.calls.logs.filter((log) => log.action === "intake.add_separate").length, 0);
});
