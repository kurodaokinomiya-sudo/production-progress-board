import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all([
  "../src/intake-duplicates.js", "../src/intake-learning.js", "../apps-script/Config.gs",
  "../apps-script/Parser.gs", "../apps-script/Repository.gs", "../apps-script/Import.gs",
  "../apps-script/IntakeLearning.gs",
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
const copy = (value) => JSON.parse(JSON.stringify(value));

const baseParsed = (overrides = {}) => ({
  customer: "甲医科", product: "左向 ケリソンパンチ 3mm", productCode: "K-03-L", category: "ケリソンパンチ",
  specLength: "18cm", specShape: "左向", bladeWidth: "3mm", quantity: 2, dueDate: "2026-11-10",
  serialNo: "SER-PRIVATE-777", note: "原本備考", ...overrides,
});

function validOrder(parsed, overrides = {}) {
  return { ...parsed, stages: {}, shippingStatus: "not_ready", ...overrides };
}

function harness() {
  const tables = new Map();
  const sheets = new Map();
  const writes = [];
  const logs = [];
  const calls = { locks: 0, savedJobs: 0, statusWrites: 0 };
  let role = "editor", locked = false, failLearningWrites = 0, failStatusWrites = 0, context;
  const sheet = (name) => {
    if (sheets.has(name)) return sheets.get(name);
    const grid = tables.get(name) || [];
    tables.set(name, grid);
    const value = {
      getLastRow: () => grid.length,
      getLastColumn: () => Math.max(0, ...grid.map((row) => row.length)),
      getRange(row, column, height = 1, width = 1) {
        return {
          getValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => grid[row - 1 + r]?.[column - 1 + c] ?? "")),
          getDisplayValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => String(grid[row - 1 + r]?.[column - 1 + c] ?? ""))),
          setValues(values) {
            if (name === context.APP.SHEETS.LEARNING && row > 1 && failLearningWrites > 0) {
              failLearningWrites -= 1;
              throw new Error("lesson sheet unavailable");
            }
            if (name === context.APP.SHEETS.JOBS && row > 1) calls.savedJobs += values.length;
            values.forEach((valueRow, r) => {
              grid[row - 1 + r] ||= [];
              valueRow.forEach((value, c) => { grid[row - 1 + r][column - 1 + c] = value; });
              writes.push({ sheet: name, row: row + r, values: [...valueRow], locked });
            });
          },
          setValue(value) {
            if (name === context.APP.SHEETS.INTAKE) {
              calls.statusWrites += 1;
              if (failStatusWrites > 0) { failStatusWrites -= 1; throw new Error("intake status unavailable"); }
            }
            grid[row - 1] ||= [];
            grid[row - 1][column - 1] = value;
            writes.push({ sheet: name, row, value, locked });
          },
          setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
        };
      },
      setFrozenRows() {}, autoResizeColumns() {}, setFontWeight() {}, setBackground() {}, setFontColor() {},
    };
    sheets.set(name, value);
    return value;
  };
  const lock = {
    waitLock() { locked = true; calls.locks += 1; },
    releaseLock() { locked = false; },
  };
  context = vm.createContext({
    Date, Math, Number, Object, String, Array, JSON, RegExp, Error,
    requireEditorAccess_: () => {
      if (role !== "editor") throw new Error("EDITOR_REQUIRED: 編集権限が必要です。");
      return { role, canEdit: true };
    },
    Utilities: { getUuid: () => `generated-${calls.savedJobs + 1}` },
    SpreadsheetApp: { flush() {} },
    LockService: { getScriptLock: () => lock },
  });
  vm.runInContext(sources.join("\n"), context);
  for (const [name, headers] of [
    [context.APP.SHEETS.JOBS, context.APP.JOB_HEADERS],
    [context.APP.SHEETS.INTAKE, context.APP.INTAKE_HEADERS],
    [context.APP.SHEETS.SETTINGS, context.APP.SETTING_HEADERS],
    [context.APP.SHEETS.LOG, context.APP.LOG_HEADERS],
    [context.APP.SHEETS.LEARNING, context.APP.LEARNING_HEADERS],
  ]) tables.set(name, [[...headers]]);
  Object.assign(context, {
    getSpreadsheet_: () => ({ getSheetByName: (name) => tables.has(name) ? sheet(name) : null, insertSheet: sheet }),
    ensureSystem_: () => {},
    appendLog_: (action, entityType, entityId, detail) => logs.push({ action, entityType, entityId, detail: copy(detail), locked }),
  });
  const addCandidate = (id, parsed = baseParsed()) => context.withDocumentLock_(() => context.appendIntake_({
    id, sourceType: "text", sourceRef: `paste:${id}`, subject: `注文 ${id}`, originalText: "注文本文",
    parsed, status: "pending",
  }));
  const addJob = (sourceRef, order) => context.withDocumentLock_(() => context.saveJobUnlocked_({
    ...order, sourceType: "intake", sourceRef,
  }));
  const approveRequest = (candidate, order, options = {}) => ({ intakeId: candidate.id, order, ...options });
  return {
    context, tables, writes, logs, calls, addCandidate, addJob, approveRequest,
    failNextLearningWrite() { failLearningWrites += 1; },
    failNextStatusWrite() { failStatusWrites += 1; },
    setRole(value) { role = value; },
    learningRows() { return tables.get(context.APP.SHEETS.LEARNING); },
    learningRules() { return context.getIntakeLearningRules().rules; },
  };
}

function approve(h, candidate, order, options = {}) {
  return h.context.approveIntakes({ items: [h.approveRequest(candidate, order, options)] });
}

test("approval learns only opt-in stable corrections and stores no quantity, date, or serial", () => {
  const h = harness();
  const parsed = baseParsed();
  const candidate = h.addCandidate("learn-category", parsed);
  const result = approve(h, candidate, validOrder(parsed, { category: "鋭匙鉗子" }), { learnProduct: true, learnNote: false });
  assert.equal(result.errors.length, 0);
  assert.equal(h.learningRules().length, 1);
  const rule = h.learningRules()[0];
  assert.deepEqual([...rule.fields], ["category"]);
  assert.equal(rule.note, undefined);
  const serialized = JSON.stringify(rule);
  assert.equal(serialized.includes("SER-PRIVATE-777"), false);
  assert.equal(serialized.includes("2026-11-10"), false);
  assert.equal(serialized.includes('"quantity"'), false);
  assert.equal(serialized.includes('"dueDate"'), false);
  assert.equal(serialized.includes('"serialNo"'), false);
});

test("opt-out never writes a rule, and note additions require the separate note opt-in", () => {
  const h = harness();
  const parsed = baseParsed();
  const first = h.addCandidate("opt-out", parsed);
  const noLearn = approve(h, first, validOrder(parsed, { category: "鋭匙鉗子", note: "原本備考 / 検品ラベルを優先" }), { learnProduct: false, learnNote: true });
  assert.equal(noLearn.errors.length, 0);
  assert.equal(h.learningRules().length, 0);
  assert.equal(h.writes.filter((write) => write.sheet === h.context.APP.SHEETS.LEARNING && write.row > 1).length, 0);

  const noteHarness = harness();
  const noteParsed = baseParsed({ serialNo: "SER-NOTE" });
  const second = noteHarness.addCandidate("note-opt-in", noteParsed);
  const withNote = approve(noteHarness, second, validOrder(noteParsed, { category: "鋭匙鉗子", note: "原本備考 / 検品ラベルを優先" }), { learnProduct: true, learnNote: true });
  assert.equal(withNote.errors.length, 0);
  assert.equal(noteHarness.learningRules().length, 1);
  assert.equal(noteHarness.learningRules()[0].note, "検品ラベルを優先");
});

test("a later correction merges with the stable lesson and applies to a new intake", () => {
  const h = harness();
  const parsed = baseParsed();
  const first = h.addCandidate("correction-1", parsed);
  approve(h, first, validOrder(parsed, { category: "鋭匙鉗子" }), { learnProduct: true });
  const correctedParsed = baseParsed({ serialNo: "SER-SECOND" });
  const second = h.addCandidate("correction-2", correctedParsed);
  approve(h, second, validOrder(correctedParsed, { category: "鋭匙鉗子", specShape: "右向" }), { learnProduct: true });
  const [rule] = h.learningRules();
  assert.equal(h.learningRules().length, 1);
  assert.deepEqual([...rule.fields].sort(), ["category", "specShape"]);

  const imported = h.context.saveParsedIntake_([{ parsed: baseParsed({ privateParsedValue: "preserved" }) }], "新しい注文", { name: "new-import", sourceType: "text" });
  assert.equal(imported.items[0].parsed.category, "鋭匙鉗子");
  assert.equal(imported.items[0].parsed.specShape, "右向");
  assert.equal(imported.items[0].parsed.privateParsedValue, "preserved");
});

test("approving every applied field back to its original value soft-disables the rule and pending retry keeps it inactive", () => {
  const h = harness();
  const original = baseParsed();
  const first = h.addCandidate("reset-first", original);
  approve(h, first, validOrder(original, { category: "鋭匙鉗子", specShape: "右向" }), { learnProduct: true });
  const [activeRule] = h.learningRules();
  assert.ok(activeRule);

  const nextOriginal = baseParsed({ serialNo: "SER-RESET-SECOND" });
  const imported = h.context.saveParsedIntake_([{ parsed: nextOriginal }], "次の注文", { name: "reset-second", sourceType: "text" });
  const candidate = imported.items[0];
  assert.equal(candidate.parsed.category, "鋭匙鉗子");
  assert.equal(candidate.parsed.specShape, "右向");
  assert.equal(candidate.parsed._learning.original.category, nextOriginal.category);
  assert.equal(candidate.parsed._learning.original.specShape, nextOriginal.specShape);

  h.failNextStatusWrite();
  const resetOrder = validOrder(candidate.parsed, {
    category: nextOriginal.category,
    specShape: nextOriginal.specShape,
  });
  const failed = approve(h, candidate, resetOrder, { learnProduct: true });
  assert.equal(failed.items.length, 0);
  assert.equal(failed.errors.length, 1, "the reset lesson persists even if candidate status update fails");
  assert.equal(h.learningRules().length, 0);
  const row = h.learningRows()[1];
  const disabled = JSON.parse(row[1]);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.intakeId, candidate.id);

  const retry = h.context.approveIntakes({ items: [{ intakeId: candidate.id, order: {}, learnProduct: true }] });
  assert.equal(retry.errors.length, 0);
  assert.equal(h.context.readIntake_().find((item) => item.id === candidate.id).status, "approved");
  assert.equal(h.learningRules().length, 0, "a retry after reset must not resurrect the rule");
  assert.equal(JSON.parse(h.learningRows()[1][1]).disabled, true);
  assert.equal(JSON.parse(h.learningRows()[1][1]).intakeId, candidate.id);
});

test("duplicate block prevents both job creation and learning writes", () => {
  const h = harness();
  const parsed = baseParsed();
  const candidate = h.addCandidate("duplicate-learning", parsed);
  h.addJob("manual-existing", validOrder(parsed, { sourceType: "manual" }));
  const writesBefore = h.writes.length;
  const result = approve(h, candidate, validOrder(parsed, { category: "鋭匙鉗子" }), { learnProduct: true });
  assert.equal(result.items.length, 0);
  assert.equal(result.errors[0].code, "INTAKE_DUPLICATE");
  assert.equal(h.tables.get(h.context.APP.SHEETS.JOBS).length, 2);
  assert.equal(h.learningRows().length, 1);
  assert.equal(h.writes.length, writesBefore);
  assert.equal(h.context.readIntake_().find((item) => item.id === candidate.id).status, "pending");
});

test("fully approved retry performs no job, lesson, status, or audit writes", () => {
  const h = harness();
  const parsed = baseParsed();
  const candidate = h.addCandidate("approved-retry", parsed);
  const request = h.approveRequest(candidate, validOrder(parsed, { category: "鋭匙鉗子" }), { learnProduct: true });
  const first = h.context.approveIntakes({ items: [request] });
  assert.equal(first.errors.length, 0);
  const before = { writes: h.writes.length, jobs: h.calls.savedJobs, statuses: h.calls.statusWrites, logs: h.logs.length };
  const retry = h.context.approveIntakes({ items: [{ intakeId: candidate.id, order: {}, learnProduct: true, learnNote: true }] });
  assert.equal(retry.errors.length, 0);
  assert.deepEqual({ writes: h.writes.length, jobs: h.calls.savedJobs, statuses: h.calls.statusWrites, logs: h.logs.length }, before);
  assert.equal(h.learningRules().length, 1);
});

test("failed lesson write leaves the saved job pending and retry repairs exactly one lesson", () => {
  const h = harness();
  const parsed = baseParsed();
  const candidate = h.addCandidate("partial-learning", parsed);
  const request = h.approveRequest(candidate, validOrder(parsed, { category: "鋭匙鉗子" }), { learnProduct: true });
  h.failNextLearningWrite();
  const first = h.context.approveIntakes({ items: [request] });
  assert.equal(first.items.length, 0);
  assert.equal(first.errors.length, 1);
  assert.equal(h.tables.get(h.context.APP.SHEETS.JOBS).length, 2, "authoritative job remains saved");
  assert.equal(h.learningRows().length, 1, "only the learning header exists after the failed write");
  assert.equal(h.context.readIntake_()[0].status, "pending");

  const retry = h.context.approveIntakes({ items: [{ intakeId: candidate.id, order: {}, learnProduct: true }] });
  assert.equal(retry.errors.length, 0);
  assert.equal(h.calls.savedJobs, 1, "retry reuses the saved job");
  assert.equal(h.learningRows().length, 2);
  assert.equal(h.learningRules().length, 1);
  assert.equal(h.context.readIntake_()[0].status, "approved");
});

test("a stale correction skips the lesson update but still completes approval", () => {
  const h = harness();
  const parsed = baseParsed();
  const newerRule = h.context.IntakeLearning.learn({ rules: [], parsed, order: validOrder(parsed, { specShape: "右向" }),
    intakeId: "newer-correction", includeNote: false, updatedAt: "2026-10-14T00:00:00.000Z" }).rule;
  h.context.withDocumentLock_(() => h.context.writeIntakeLearningRule_(newerRule));
  const candidate = h.addCandidate("older-correction", parsed);
  const staleJob = h.addJob(candidate.id, validOrder(parsed, { specShape: "下向" }));
  const ruleRowsBefore = h.learningRows().length;
  const result = approve(h, candidate, validOrder(parsed, { specShape: "下向" }), { learnProduct: true });
  assert.equal(result.errors.length, 0);
  assert.equal(result.items[0].job.id, staleJob.id);
  assert.match(result.items[0].learningNotice, /別の確認で更新/);
  assert.equal(h.learningRows().length, ruleRowsBefore);
  assert.equal(h.learningRules()[0].target.specShape, "右向");
  assert.equal(h.context.readIntake_().find((item) => item.id === candidate.id).status, "approved");
});

test("job save failure cannot create a learning rule", () => {
  const h = harness();
  const parsed = baseParsed();
  const candidate = h.addCandidate("job-failure", parsed);
  const save = h.context.saveJobUnlocked_;
  h.context.saveJobUnlocked_ = () => { throw new Error("job storage unavailable"); };
  const result = approve(h, candidate, validOrder(parsed, { category: "鋭匙鉗子" }), { learnProduct: true });
  h.context.saveJobUnlocked_ = save;
  assert.equal(result.errors.length, 1);
  assert.equal(h.learningRows().length, 1);
  assert.equal(h.calls.statusWrites, 0);
  assert.equal(h.context.readIntake_()[0].status, "pending");
});
