import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all(["Config.gs", "Parser.gs", "Repository.gs", "Import.gs"].map(
  (name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8"),
));
const sourceUrl = "https://docs.google.com/spreadsheets/d/source-workbook/edit?gid=1652379946#gid=1652379946";
const headers = ["得意先", "品名", "納期", "数量", "全長", "型", "刃幅", "連番", "溶接", "元作り", "浮き止め～立ち上がり", "厚みとり", "仕上げ", "備考", "大分類", "品番", "出荷状況", "元行番号"];
const fixedNow = "2026-10-08T03:04:05.000Z";
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedNow])); } }

function row(overrides = {}) {
  const values = { "得意先": "テスト商事", "品名": "ケリソン 18cm 2mm", "納期": "2026-10-31", "数量": "5", "連番": "注文-01", "溶接": "豊済", "元作り": "幹", "浮き止め～立ち上がり": "望研", "厚みとり": "", "仕上げ": "未着手", "大分類": "ケリソンパンチ", "品番": "06-04-08", "元行番号": "7", ...overrides };
  return headers.map((header) => values[header] ?? "");
}

function csv(values) {
  return values.map((cells) => cells.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
}

function harness({ initial = [], sourceValues = [], role = "owner" } = {}) {
  const writes = [], logs = [], parsedCsv = [], grid = [], csvGrids = new Map();
  let uuid = 0, locked = false, ensures = 0, context;
  const sheet = {
    getLastRow: () => grid.length,
    getRange: (rowNumber, column, rowCount, columnCount) => ({
      getValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => grid[rowNumber - 1 + r]?.[column - 1 + c] ?? "")),
      setValues: (rows) => {
        writes.push({ locked, rowNumber, rows: structuredClone(rows) });
        rows.forEach((cells, index) => { grid[rowNumber - 1 + index] = [...cells]; });
      },
    }),
  };
  const spreadsheet = { getId: () => "target-workbook", getSheetByName: (name) => name === "2026.10"
    ? { getDataRange: () => ({ getDisplayValues: () => sourceValues }) }
    : name === "工程管理_案件" ? sheet : null };
  const ctx = vm.createContext({
    Date: FixedDate, Math, Number, Object, RegExp, String, Array, JSON, Error,
    requireOwnerAccess_: () => { if (role !== "owner") throw new Error("OWNER_REQUIRED: owner only"); return { role }; },
    Utilities: {
      getUuid: () => `import-job-${++uuid}`, DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" },
      computeDigest: (_algorithm, value) => [...createHash("sha256").update(value, "utf8").digest()],
      parseCsv: (text) => { parsedCsv.push(text); if (!csvGrids.has(text)) throw new Error("Unknown CSV fixture"); return structuredClone(csvGrids.get(text)); },
    },
    SpreadsheetApp: { openById: () => { throw new Error("External workbook must not be opened"); }, flush: () => {} },
  });
  context = ctx;
  vm.runInContext(sources.join("\n"), ctx);
  Object.assign(ctx, {
    getSpreadsheet_: () => spreadsheet,
    ensureSystem_: () => { ensures += 1; },
    withDocumentLock_: (callback) => { assert.equal(locked, false); locked = true; try { return callback(); } finally { locked = false; } },
    appendLog_: (...entry) => logs.push(entry),
  });
  grid.push([...ctx.APP.JOB_HEADERS]);
  initial.forEach((input) => grid.push(ctx.jobToRow_(ctx.normalizeJobInput_(input, null))));
  return {
    context, grid, writes, logs, parsedCsv, jobs: () => ctx.readJobs_(), ensures: () => ensures,
    request: (rows = [row()], input = {}, columnHeaders = headers) => {
      const values = [columnHeaders, ...rows];
      const csvText = csv(values);
      csvGrids.set(csvText, values);
      return { sheetName: "2026.10", sourceUrl, csvText, ...input };
    },
  };
}

test("legacy stage cells preserve assignees and the requested 済/研 progress semantics", () => {
  const { context } = harness();
  const expected = [
    ["", "not_started", ""], ["豊", "working", "豊"], ["幹 済", "done", "幹"], ["望（研）", "working", "望"],
    ["未着手", "not_started", ""], ["作業中", "working", ""], ["完了", "done", ""], ["保留", "hold", ""],
    ["保", "working", "保"], ["順・済", "done", "順"], ["河研", "working", "河"],
  ];
  for (const [input, status, assignee] of expected) {
    const parsed = context.legacyStageInput_(input);
    assert.equal(parsed.status, status, input);
    assert.equal(parsed.assignee, assignee, input);
  }
  assert.throws(() => context.legacyStageInput_("太郎済"), /判定できません/);
  assert.throws(() => context.legacyStageInput_("豊不明"), /判定できません/);
});

test("header aliases map product variants to the same five stored stages", () => {
  const { context } = harness();
  const detected = context.detectLegacyHeaders_([["数量", "元行番号", "品名", "得意先", "溶接", "元づくり", "浮き止め・立上り", "頭付け・巾取り", "仕上", "品番"]]);
  for (const [key, column] of Object.entries({ quantity: 0, sourceRow: 1, product: 2, customer: 3, welding: 4, base: 5, grinding: 6, heat: 7, finish: 8, productCode: 9 })) assert.equal(detected.map[key], column, key);
  assert.equal(context.detectLegacyHeaders_([["得意先", "品名", "納期", "立ち上り", "頭付け・幅取り"]]).map.heat, 4);
});

test("CSV preview validates and returns every new order without target writes or external workbook access", () => {
  const h = harness();
  const request = h.request([row({ "備考": '改行\n引用符"と,カンマ', "大分類": "鋭匙鉗子" })]);
  const result = h.context.migrateLegacySheet({ ...request, dryRun: true });
  assert.equal(result.imported, 0);
  assert.equal(result.total, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.jobs.length, 1);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.mappedHeaders.productCode.header, "品番");
  assert.equal(result.mappedHeaders.sourceRow.column, 18);
  const job = result.jobs[0];
  assert.equal(job.sourceRef, "legacy:source-workbook:1652379946:7");
  assert.equal(job.productCode, "06-04-08");
  assert.equal(job.category, "鋭匙鉗子", "explicit category wins over product-name inference");
  assert.equal(job.stages.welding.assignee, "豊");
  assert.equal(job.stages.welding.status, "done");
  assert.equal(job.stages.base.status, "working");
  assert.equal(job.stages.grinding.status, "working");
  assert.equal(job.stages.grinding.assignee, "望");
  assert.equal(job.labelPrintStatus, "not_required");
  assert.equal(job.completedAt, "");
  assert.equal(job.note, '改行\n引用符"と,カンマ');
  assert.equal(h.parsedCsv.length, 1);
  assert.equal(h.ensures(), 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.logs.length, 0);
});

test("apply appends one validated batch under lock and fresh retries skip even archived source rows", () => {
  const h = harness();
  const request = h.request([row(), row({ "元行番号": "18", "連番": "注文-02" })]);
  const preview = h.context.migrateLegacySheet({ ...request, dryRun: true });
  const applied = h.context.migrateLegacySheet({ ...request, expectedFingerprint: preview.fingerprint });
  assert.equal(applied.imported, 2);
  assert.equal(applied.total, 2);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].locked, true);
  assert.equal(h.logs.length, 1);
  h.grid[1][h.context.APP.JOB_HEADERS.indexOf("archived")] = true;
  const retryPreview = h.context.migrateLegacySheet({ ...request, dryRun: true });
  assert.equal(retryPreview.skipped, 2);
  assert.equal(retryPreview.jobs.length, 0);
  const retry = h.context.migrateLegacySheet({ ...request, expectedFingerprint: retryPreview.fingerprint });
  assert.equal(retry.imported, 0);
  assert.equal(retry.skipped, 2);
  assert.equal(h.writes.length, 1);
});

test("an invalid later row blocks the entire import before system setup or target writes", () => {
  const h = harness();
  const request = h.request([row(), row({ "元行番号": "23", "元作り": "太郎済" })]);
  assert.throws(() => h.context.migrateLegacySheet({ ...request, dryRun: true }), /元表 23行目.*base.*判定できません/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.ensures(), 0);
  assert.equal(h.logs.length, 0);
  const blankCustomer = h.request([row(), row({ "元行番号": "24", "得意先": "" })]);
  assert.throws(() => h.context.migrateLegacySheet({ ...blankCustomer, dryRun: true }), /得意先と品名の両方/);
  assert.equal(h.writes.length, 0);
  const ordinary = harness({ sourceValues: [headers.slice(0, -1), row().slice(0, -1), row({ "元作り": "太郎済" }).slice(0, -1)] });
  assert.throws(() => ordinary.context.migrateLegacySheet({ sheetName: "2026.10" }), /元表 3行目.*base.*判定できません/);
  assert.equal(ordinary.writes.length, 0, "apply validates later rows before appending earlier candidates");
  assert.equal(ordinary.ensures(), 0);
});

test("CSV apply requires a preview and rejects changed CSV, source identity, or existing target rows", () => {
  const h = harness();
  const request = h.request();
  assert.throws(() => h.context.migrateLegacySheet(request), /先にプレビュー/);
  const preview = h.context.migrateLegacySheet({ ...request, dryRun: true });
  const changedCsv = h.request([row({ "数量": "6" })]);
  assert.throws(() => h.context.migrateLegacySheet({ ...changedCsv, expectedFingerprint: preview.fingerprint }), /変更されています/);
  assert.throws(() => h.context.migrateLegacySheet({ ...request, sourceUrl: sourceUrl.replace("source-workbook", "other-workbook"), expectedFingerprint: preview.fingerprint }), /変更されています/);
  h.grid.push(h.context.jobToRow_(h.context.normalizeJobInput_({ customer: "別得意先", product: "鋭匙鉗子", quantity: 1, stages: {} }, null)));
  assert.throws(() => h.context.migrateLegacySheet({ ...request, expectedFingerprint: preview.fingerprint }), /変更されています/);
  assert.equal(h.writes.length, 0);
});

test("exact active order duplicates are skipped but distinct original rows inside a new CSV survive", () => {
  const seed = harness();
  const request = seed.request();
  const job = seed.context.migrateLegacySheet({ ...request, dryRun: true }).jobs[0];
  const existing = harness({ initial: [{ ...job, sourceRef: "previous-import" }] });
  const existingPreview = existing.context.migrateLegacySheet({ ...existing.request(), dryRun: true });
  assert.equal(existingPreview.skipped, 1);
  assert.equal(existingPreview.jobs.length, 0);
  const distinct = harness();
  const distinctPreview = distinct.context.migrateLegacySheet({ ...distinct.request([row(), row({ "元行番号": "8" })]), dryRun: true });
  assert.equal(distinctPreview.jobs.length, 2);
});

test("source row collisions, invalid URL/size/quantity and shipped unfinished orders fail without writes", () => {
  const h = harness();
  assert.throws(() => h.context.migrateLegacySheet({ ...h.request([row(), row()]), dryRun: true }), /元行番号が重複/);
  assert.throws(() => h.context.migrateLegacySheet({ ...h.request(), sourceUrl: "https://example.com/spreadsheets/d/source-workbook/edit?gid=1", dryRun: true }), /GoogleスプレッドシートURL/);
  assert.throws(() => h.context.migrateLegacySheet({ ...h.request(), csvText: "x".repeat(250001), dryRun: true }), /250000/);
  assert.throws(() => h.context.migrateLegacySheet({ ...h.request([row({ "数量": "不明" })]), dryRun: true }), /数量/);
  assert.throws(() => h.context.migrateLegacySheet({ ...h.request([row({ "納期": "10/31" })]), dryRun: true }), /YYYY-MM-DD/);
  assert.throws(() => h.context.migrateLegacySheet({ ...h.request([row({ "納期": "2026-02-30" })]), dryRun: true }), /正しい日付/);
  assert.throws(() => h.context.migrateLegacySheet({ ...h.request([row({ "出荷状況": "済" })]), dryRun: true }), /最終仕上げを完了/);
  assert.equal(h.writes.length, 0);
});

test("a shipped import retains a completion timestamp and stays outside the label queue", () => {
  const h = harness();
  const request = h.request([row({ "溶接": "豊済", "元作り": "幹済", "浮き止め～立ち上がり": "望済", "厚みとり": "鈴済", "仕上げ": "河済", "出荷状況": "出荷完了" })]);
  const preview = h.context.migrateLegacySheet({ ...request, dryRun: true });
  assert.equal(preview.jobs[0].completedAt, fixedNow);
  assert.equal(preview.jobs[0].polishing.sentQuantity, 0);
  assert.equal(preview.jobs[0].polishing.returnedQuantity, 0);
  assert.equal(preview.jobs[0].polishing.history.length, 0);
  h.context.migrateLegacySheet({ ...request, expectedFingerprint: preview.fingerprint });
  assert.equal(h.jobs()[0].shippingStatus, "shipped");
  assert.equal(h.jobs()[0].completedAt, fixedNow);
  assert.equal(h.jobs()[0].labelPrintStatus, "not_required");
});

test("historical ordinary finishing completion imports without fabricating a final return or resetting the source state", () => {
  const h = harness();
  const request = h.request([row({ "仕上げ": "河済", "出荷状況": "" })]);
  const preview = h.context.migrateLegacySheet({ ...request, dryRun: true });
  assert.equal(preview.jobs[0].stages.finish.status, "done");
  assert.equal(preview.jobs[0].stages.finish.assignee, "河");
  assert.equal(preview.jobs[0].completedAt, "");
  assert.equal(h.context.finalFinishingReady_(preview.jobs[0]), false);
  h.context.migrateLegacySheet({ ...request, expectedFingerprint: preview.fingerprint });
  assert.equal(h.jobs()[0].stages.finish.status, "done");
  assert.equal(h.jobs()[0].polishing.history.length, 0);
});

test("ordinary same-workbook imports retain their source refs and skip structural rows", () => {
  const sourceValues = [headers.slice(0, -1), row().slice(0, -1), [], ["合計", "", "", "5"], ["得意先", "品名"]];
  const h = harness({ sourceValues });
  const applied = h.context.migrateLegacySheet({ sheetName: "2026.10" });
  assert.equal(applied.imported, 1);
  assert.equal(applied.total, 1);
  assert.equal(h.jobs()[0].sourceRef, "legacy:2026.10:2");
  assert.equal(h.jobs()[0].stages.base.assignee, "幹");
  const retry = h.context.migrateLegacySheet({ sheetName: "2026.10" });
  assert.equal(retry.imported, 0);
  assert.equal(retry.skipped, 1);
});

test("only the owner reaches parsing, preview or writes", () => {
  for (const role of ["viewer", "worker", "editor", "admin"]) {
    const h = harness({ role });
    assert.throws(() => h.context.migrateLegacySheet({ ...h.request(), dryRun: true }), /OWNER_REQUIRED/);
    assert.throws(() => h.context.migrateLegacySheet(h.request()), /OWNER_REQUIRED/);
    assert.equal(h.parsedCsv.length, 0);
    assert.equal(h.ensures(), 0);
    assert.equal(h.writes.length, 0);
  }
});
