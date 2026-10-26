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

function harness(initialJobs = []) {
  let context;
  const grid = [];
  const writes = [];
  const logs = [];
  const sheet = {
    getLastRow: () => grid.length,
    getLastColumn: () => grid[0]?.length || 0,
    getRange: (row, column, rowCount = 1, columnCount = 1) => ({
      getValues: () => Array.from({ length: rowCount }, (_, rowOffset) => Array.from(
        { length: columnCount }, (_, columnOffset) => grid[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? "",
      )),
      getDisplayValues: () => Array.from({ length: rowCount }, (_, rowOffset) => Array.from(
        { length: columnCount }, (_, columnOffset) => String(grid[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? ""),
      )),
      setValues: (newValues) => {
        newValues.forEach((newRow, rowOffset) => {
          const targetRow = row - 1 + rowOffset;
          grid[targetRow] ||= [];
          newRow.forEach((value, columnOffset) => { grid[targetRow][column - 1 + columnOffset] = value; });
          writes.push({ row: row + rowOffset, values: [...newRow] });
        });
      },
      setFontWeight() { return this; },
      setBackground() { return this; },
      setFontColor() { return this; },
    }),
  };
  const lock = { waitLock() {}, releaseLock() {} };
  const contextApi = vm.createContext({ requireAppAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), requireAdminAccess_: () => ({email: "owner@example.com", role: "owner", isAdmin: true, canEdit: true}), requireEditorAccess_: () => ({email: "owner@example.com", role: "owner", isAdmin: true, canEdit: true}), requireWorkerAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true, canWork: true}), requireOwnerAccess_: () => ({email: "owner@example.com", role: "owner", isOwner: true, isAdmin: true, canEdit: true}), getAccessSettings: () => ({emails: [], version: 1}),
    Date: FixedDate, Math, Number, Object, RegExp, String, Array, JSON,
    Utilities: { getUuid: () => "test-uuid" },
    SpreadsheetApp: { flush() {} },
    LockService: { getScriptLock: () => lock },
  });
  context = contextApi;
  vm.runInContext(sources.join("\n"), context);
  grid.push([...context.APP.JOB_HEADERS]);
  grid.push(...initialJobs.map((job) => context.jobToRow_(job)));
  Object.assign(context, {
    getSpreadsheet_: () => ({ getSheetByName: () => sheet }),
    ensureSystem_: () => {},
    appendLog_: (...entry) => logs.push(entry),
  });
  return {
    context,
    writes,
    logs,
    jobs: () => context.readJobs_(),
    grid,
    sheet,
  };
}

function makeJob(context, { id = "JOB-DIST", category = "鋭匙鉗子", distributionAssignee = "", version = 4, ...overrides } = {}) {
  const normalized = context.normalizeJobInput_({
    customer: "検証商事",
    product: category === "鋭匙鉗子" ? "鋭匙鉗子" : "ケリソンパンチ",
    category,
    quantity: 3,
    shippingStatus: "waiting",
    note: "既存メモ",
    stages: Object.fromEntries(context.APP.STAGES.map((key) => [key, { status: "working", assignee: "幹" }])),
  }, null);
  return {
    ...normalized,
    id,
    version,
    distributionAssignee,
    updatedAt: "2026-09-01T00:00:00.000Z",
    labelPrintStatus: "printed",
    labelPrintedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

test("配布担当を永続化し、通常の案件編集でも保持する", () => {
  const fixture = harness();
  const { context } = fixture;
  fixture.grid.push(context.jobToRow_(makeJob(context)));

  const assigned = context.setDistributionAssignee({ id: "JOB-DIST", version: 4, assignee: "豊" });
  assert.equal(assigned.distributionAssignee, "豊");
  assert.equal(assigned.version, 5);
  assert.equal(assigned.updatedAt, fixedNow);
  assert.deepEqual(fixture.jobs()[0].distributionAssignee, "豊");
  assert.equal(fixture.logs.length, 1);

  const edited = context.saveJob({ ...assigned, version: 5, note: "通常編集" });
  assert.equal(edited.distributionAssignee, "豊");
  assert.equal(edited.note, "通常編集");
  assert.equal(fixture.jobs()[0].distributionAssignee, "豊");
});

test("新規案件は担当未設定で、通常保存の明示変更も保存する", () => {
  const fixture = harness();
  const { context } = fixture;
  const unassigned = context.saveJob({ ...makeJob(context, { id: "JOB-NEW", distributionAssignee: undefined }), id: "JOB-NEW", version: 0, distributionAssignee: undefined });
  assert.equal(unassigned.distributionAssignee, "");

  const assigned = context.saveJob({ ...unassigned, version: 1, distributionAssignee: "望" });
  assert.equal(assigned.distributionAssignee, "望");
  assert.equal(fixture.jobs()[0].distributionAssignee, "望");
});

test("同じ担当者の再設定は書込も更新番号増加も行わない", () => {
  const fixture = harness();
  const { context } = fixture;
  fixture.grid.push(context.jobToRow_(makeJob(context, { distributionAssignee: "豊" })));
  const before = fixture.jobs()[0];

  const result = context.setDistributionAssignee({ id: before.id, version: before.version, assignee: "豊" });

  assert.equal(result.version, before.version);
  assert.equal(result.updatedAt, before.updatedAt);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.logs, []);
});

test("空欄を指定すると配布担当を解除する", () => {
  const fixture = harness();
  const { context } = fixture;
  fixture.grid.push(context.jobToRow_(makeJob(context, { distributionAssignee: "豊" })));

  const cleared = context.setDistributionAssignee({ id: "JOB-DIST", version: 4, assignee: "" });

  assert.equal(cleared.distributionAssignee, "");
  assert.equal(cleared.version, 5);
  assert.equal(fixture.jobs()[0].distributionAssignee, "");
});

test("無効な担当者、別カテゴリ、削除済み案件、競合版数は無更新で拒否する", () => {
  const fixture = harness();
  const { context } = fixture;
  fixture.grid.push(context.jobToRow_(makeJob(context, { id: "JOB-DIST" })));
  fixture.grid.push(context.jobToRow_(makeJob(context, { id: "JOB-KERI", category: "ケリソンパンチ" })));
  fixture.grid.push(context.jobToRow_(makeJob(context, { id: "JOB-ARCHIVED", archived: true })));
  const before = fixture.jobs();

  assert.throws(() => context.setDistributionAssignee({ id: "JOB-DIST", version: 4, assignee: "架空" }), /配布担当者が不正/);
  assert.throws(() => context.setDistributionAssignee({ id: "JOB-KERI", version: 4, assignee: "豊" }), /鋭匙鉗子/);
  assert.throws(() => context.setDistributionAssignee({ id: "JOB-ARCHIVED", version: 4, assignee: "豊" }), /削除済み/);
  assert.throws(() => context.setDistributionAssignee({ id: "JOB-DIST", version: 3, assignee: "豊" }), /別の端末で先に更新/);

  assert.deepEqual(fixture.jobs(), before);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.logs, []);
});

test("配布担当の更新は工程、ラベル、出荷の各状態を変更しない", () => {
  const fixture = harness();
  const { context } = fixture;
  fixture.grid.push(context.jobToRow_(makeJob(context)));
  const before = fixture.jobs()[0];

  const updated = context.setDistributionAssignee({ id: before.id, version: before.version, assignee: "順" });

  assert.deepEqual(updated.stages, before.stages);
  assert.equal(updated.shippingStatus, before.shippingStatus);
  assert.equal(updated.completedAt, before.completedAt);
  assert.equal(updated.labelPrintStatus, before.labelPrintStatus);
  assert.equal(updated.labelPrintedAt, before.labelPrintedAt);
  assert.equal(updated.note, before.note);
});

test("旧形式の行は配布担当を空欄として読み、ヘッダー追加で既存列を保つ", () => {
  const fixture = harness();
  const { context } = fixture;
  const oldWidth = context.APP.JOB_HEADERS.indexOf("distributionAssignee");
  const oldHeaders = context.APP.JOB_HEADERS.slice(0, oldWidth);
  const oldValues = context.jobToRow_(makeJob(context, { distributionAssignee: "豊" })).slice(0, oldWidth);
  const oldRecord = Object.fromEntries(oldHeaders.map((header, index) => [header, oldValues[index]]));
  assert.equal(context.jobFromRow_(oldRecord).distributionAssignee, "");

  const legacyGrid = [oldHeaders, oldValues];
  const legacySheet = {
    getLastRow: () => legacyGrid.length,
    getLastColumn: () => legacyGrid[0].length,
    getRange: (row, column, rowCount = 1, columnCount = 1) => ({
      getDisplayValues: () => Array.from({ length: rowCount }, (_, rowOffset) => Array.from(
        { length: columnCount }, (_, columnOffset) => String(legacyGrid[row - 1 + rowOffset]?.[column - 1 + columnOffset] ?? ""),
      )),
      setValues: (values) => values.forEach((entry, rowOffset) => entry.forEach((value, columnOffset) => {
        legacyGrid[row - 1 + rowOffset][column - 1 + columnOffset] = value;
      })),
      setFontWeight() { return this; },
      setBackground() { return this; },
      setFontColor() { return this; },
    }),
  };

  context.ensureSheet_({ getSheetByName: () => legacySheet }, context.APP.SHEETS.JOBS, context.APP.JOB_HEADERS);

  assert.equal(legacyGrid[0][oldWidth], "distributionAssignee");
  assert.deepEqual(Array.from(legacyGrid[0].slice(-7)), ["productCode", "externalOrderNo", "externalLineNo", "materialsJson", "stockPlannedQuantity", "completionKind", "processSaveJson"]);
  assert.deepEqual(legacyGrid[1].slice(0, oldValues.length), oldValues);
  assert.equal(legacyGrid[1][oldValues.length], undefined);
});
