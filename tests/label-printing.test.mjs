import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const sources = await Promise.all(["Config.gs", "Parser.gs", "Repository.gs"].map(
  (name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8"),
));

const fixedNow = "2026-09-24T03:04:05.000Z";
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
}

function harness() {
  const values = [];
  const writes = [];
  let context;
  const sheet = {
    getLastRow: () => values.length + 1,
    getRange: (row, column, rowCount = 1, columnCount) => ({
      getValues: () => values.slice(row - 2, row - 2 + rowCount).map((entry) => entry.slice(column - 1, column - 1 + columnCount)),
      setValues: (newValues) => {
        newValues.forEach((newRow, rowIndex) => {
          const target = row - 2 + rowIndex;
          values[target] = [...newRow];
          writes.push({ rowNumber: row + rowIndex, values: [...newRow] });
        });
      },
    }),
  };
  context = vm.createContext({ requireAppAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), requireAdminAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), requireEditorAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), requireOwnerAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), getAccessSettings: () => ({emails: [], version: 1}),
    Date: FixedDate, Math, Number, Object, RegExp, String, Array, JSON,
    Utilities: { getUuid: () => "test-uuid" },
    SpreadsheetApp: { flush: () => {} },
  });
  vm.runInContext(sources.join("\n"), context);
  Object.assign(context, {
    getSpreadsheet_: () => ({ getSheetByName: () => sheet }),
    ensureSystem_: () => {},
    withDocumentLock_: (callback) => callback(),
    appendLog_: () => {},
  });
  return {
    context,
    writes,
    addJobs: (jobs) => values.push(...jobs.map((entry) => context.jobToRow_(entry))),
    jobs: () => context.readJobs_(),
  };
}

function job(context, id, labelPrintStatus, overrides = {}) {
  const normalized = context.normalizeJobInput_({
    customer: "テスト商事", product: "ケリソンパンチ", quantity: 1,
    shippingStatus: "waiting", labelPrintStatus, ...overrides,
  }, null);
  return { ...normalized, id, version: overrides.version ?? 3, updatedAt: "2026-09-01T00:00:00.000Z", ...overrides };
}

test("印刷待ちと再印刷待ちを印刷済みに保存し、時刻と版数を更新する", () => {
  const fixture = harness();
  const { context, jobs } = fixture;
  fixture.addJobs([
    job(context, "JOB-WAITING", "waiting"),
    job(context, "JOB-REPRINT", "reprint", { version: 7, labelPrintedAt: "" }),
  ]);

  const updated = context.markLabelsPrinted({ jobs: [
    { id: "JOB-WAITING", version: 3 },
    { id: "JOB-REPRINT", version: 7 },
  ] });

  assert.deepEqual(updated.map((entry) => entry.labelPrintStatus), ["printed", "printed"]);
  assert.deepEqual(updated.map((entry) => entry.labelPrintedAt), [fixedNow, fixedNow]);
  assert.deepEqual(updated.map((entry) => entry.updatedAt), [fixedNow, fixedNow]);
  assert.deepEqual(updated.map((entry) => entry.version), [4, 8]);
  assert.deepEqual(jobs().map((entry) => [entry.id, entry.labelPrintStatus, entry.labelPrintedAt, entry.version]), [
    ["JOB-WAITING", "printed", fixedNow, 4],
    ["JOB-REPRINT", "printed", fixedNow, 8],
  ]);
});

test("指定外の案件はそのまま保持する", () => {
  const fixture = harness();
  const { context } = fixture;
  fixture.addJobs([
    job(context, "JOB-TARGET", "waiting"),
    job(context, "JOB-OTHER", "reprint", { version: 9, note: "変更しない" }),
  ]);
  const before = fixture.jobs()[1];

  context.markLabelsPrinted({ jobs: [{ id: "JOB-TARGET", version: 3 }] });

  assert.deepEqual(fixture.jobs()[1], before);
  assert.equal(fixture.writes.length, 1);
});

test("対象の版数が一つでも古ければ部分書込を行わない", () => {
  const fixture = harness();
  const { context } = fixture;
  fixture.addJobs([
    job(context, "JOB-FIRST", "waiting", { version: 2 }),
    job(context, "JOB-STALE", "reprint", { version: 5 }),
  ]);
  const before = fixture.jobs();

  assert.throws(() => context.markLabelsPrinted({ jobs: [
    { id: "JOB-FIRST", version: 2 },
    { id: "JOB-STALE", version: 4 },
  ] }), /別の端末で更新されています/);

  assert.deepEqual(fixture.jobs(), before);
  assert.equal(fixture.writes.length, 0);
});
