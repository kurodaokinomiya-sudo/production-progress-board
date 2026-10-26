import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all([
  "../src/intake-learning.js", "../apps-script/Config.gs", "../apps-script/IntakeLearning.gs",
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
const copy = (value) => JSON.parse(JSON.stringify(value));

function harness() {
  const grids = new Map();
  const writes = [];
  const logs = [];
  let role = "editor", locked = false, sheetReads = 0;
  const sheets = new Map();
  const makeSheet = (name) => {
    if (sheets.has(name)) return sheets.get(name);
    const grid = grids.get(name) || [];
    grids.set(name, grid);
    const sheet = {
      getLastRow: () => grid.length,
      getLastColumn: () => Math.max(0, ...grid.map((row) => row.length)),
      getRange(row, column, height = 1, width = 1) {
        return {
          getValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => grid[row - 1 + r]?.[column - 1 + c] ?? "")),
          getDisplayValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => String(grid[row - 1 + r]?.[column - 1 + c] ?? ""))),
          setValues(values) {
            values.forEach((valueRow, r) => {
              grid[row - 1 + r] ||= [];
              valueRow.forEach((value, c) => { grid[row - 1 + r][column - 1 + c] = value; });
              writes.push({ sheet: name, row: row + r, values: [...valueRow], locked });
            });
          },
          setValue(value) {
            grid[row - 1] ||= [];
            grid[row - 1][column - 1] = value;
            writes.push({ sheet: name, row, value, locked });
          },
          setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
        };
      },
      setFrozenRows() {}, autoResizeColumns() {}, setFontWeight() {}, setBackground() {}, setFontColor() {},
    };
    sheets.set(name, sheet);
    return sheet;
  };
  const spreadsheet = {
    getSheetByName(name) { sheetReads += 1; return sheets.get(name) || null; },
    insertSheet(name) { return makeSheet(name); },
  };
  const context = vm.createContext({
    Date, Math, Number, Object, String, Array, JSON, RegExp, Error,
    requireEditorAccess_: () => {
      if (role !== "editor") throw new Error("EDITOR_REQUIRED: 編集権限が必要です。");
      return { role, canEdit: true };
    },
    SpreadsheetApp: { flush() {} },
    LockService: { getScriptLock: () => ({
      waitLock() { locked = true; },
      releaseLock() { locked = false; },
    }) },
    Utilities: { getUuid: () => "uuid" },
  });
  vm.runInContext(sources.join("\n"), context);
  Object.assign(context, {
    getSpreadsheet_: () => spreadsheet,
    ensureDefaultSettings_: () => {},
    appendLog_: (...entry) => logs.push(entry),
    withDocumentLock_: (callback) => {
      locked = true;
      try { return callback(); } finally { locked = false; }
    },
  });
  return {
    context, grids, writes, logs,
    setRole(value) { role = value; },
    get sheetReads() { return sheetReads; },
    get locked() { return locked; },
  };
}

function ruleFrom(context, overrides = {}) {
  const parsed = { customer: "甲医科", product: "左向 ケリソンパンチ 3mm", productCode: "K-03-L", category: "ケリソンパンチ" };
  const result = context.IntakeLearning.learn({
    rules: [], parsed, order: { ...parsed, category: "鋭匙鉗子" }, intakeId: "intake-1",
    includeNote: false, updatedAt: "2026-10-14T00:00:00.000Z", ...overrides,
  });
  return result.rule;
}

test("system setup creates the bounded learning sheet with the expected columns", () => {
  const h = harness();
  h.context.ensureSystem_();
  assert.deepEqual(h.grids.get(h.context.APP.SHEETS.LEARNING)[0], ["key", "ruleJson", "updatedAt"]);
});

test("learning rules are upserted by stable key and forgotten by soft disable", () => {
  const h = harness();
  const { context } = h;
  context.ensureSystem_();
  const sheetName = context.APP.SHEETS.LEARNING;
  const first = ruleFrom(context);
  context.withDocumentLock_(() => context.writeIntakeLearningRule_(first));
  assert.equal(context.getIntakeLearningRules().rules.length, 1);

  const updated = { ...first, intakeId: "intake-2", updatedAt: "2026-10-14T01:00:00.000Z", target: { ...first.target, specShape: "右向" }, fields: [...first.fields, "specShape"] };
  context.withDocumentLock_(() => context.writeIntakeLearningRule_(updated));
  const rows = h.grids.get(sheetName);
  assert.equal(rows.length, 2, "upsert keeps one data row");
  assert.equal(JSON.parse(rows[1][1]).intakeId, "intake-2");
  const other = context.IntakeLearning.learn({
    rules: [], parsed: { customer: "乙医科", product: "鉗子 Z型 5mm", productCode: "K-Z5", category: "ケリソンパンチ" },
    order: { customer: "乙医科", product: "鉗子 Z型 5mm", productCode: "K-Z5", category: "鋭匙鉗子" },
    intakeId: "unrelated", includeNote: false, updatedAt: "2026-10-14T02:00:00.000Z",
  }).rule;
  context.withDocumentLock_(() => context.writeIntakeLearningRule_(other));

  assert.throws(() => context.forgetIntakeLearningRule({ key: first.key, intakeId: "intake-1" }), /別の画面で更新/);
  assert.equal(context.getIntakeLearningRules().rules.length, 2, "stale forget must preserve the newer rule and unrelated rules");
  const forgotten = context.forgetIntakeLearningRule({ key: first.key, intakeId: "intake-2" });
  assert.equal(forgotten.rules.length, 1);
  assert.equal(forgotten.rules[0].key, other.key, "forget preserves other active rules");
  assert.equal(rows.length, 3, "forget marks the row inactive instead of deleting it");
  assert.equal(JSON.parse(rows[1][1]).disabled, true);
  assert.equal(h.logs.at(-1)[0], "intake.learning.forget");
  assert.ok(h.writes.filter((write) => write.row > 1).every((write) => write.locked), "data rows are changed only under the document lock");
});

test("learning management requires editor access before spreadsheet access", () => {
  const h = harness();
  h.setRole("worker");
  const before = h.sheetReads;
  assert.throws(() => h.context.getIntakeLearningRules(), /EDITOR_REQUIRED/);
  assert.throws(() => h.context.forgetIntakeLearningRule({ key: "any", intakeId: "any" }), /EDITOR_REQUIRED/);
  assert.equal(h.sheetReads, before);
});

test("oversized serialized lessons are rejected before any sheet write", () => {
  const h = harness();
  h.context.ensureSystem_();
  const before = h.writes.length;
  assert.throws(() => h.context.withDocumentLock_(() => h.context.writeIntakeLearningRule_(
    { key: "too-large", updatedAt: "2026-10-14", oversized: "x".repeat(16000) },
  )), /長すぎます/);
  assert.equal(h.writes.length, before);
});
