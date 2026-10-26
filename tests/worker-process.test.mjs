import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const sources = await Promise.all(["Config.gs", "Parser.gs", "Repository.gs"].map(
  (name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8"),
));
const fixedNow = "2026-10-05T03:04:05.000Z";
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedNow])); } }
let role = "worker";

function harness(initialJobs = []) {
  let context;
  const grid = [];
  const writes = [];
  const logs = [];
  const lock = { waitLock() { this.held = true; }, releaseLock() { this.held = false; } };
  const sheet = {
    getLastRow: () => grid.length,
    getLastColumn: () => grid[0]?.length || 0,
    getRange: (row, column, rowCount = 1, columnCount = 1) => ({
      getValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => grid[row - 1 + r]?.[column - 1 + c] ?? "")),
      getDisplayValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => String(grid[row - 1 + r]?.[column - 1 + c] ?? ""))),
      setValues: (rows) => rows.forEach((values, r) => {
        grid[row - 1 + r] ||= [];
        values.forEach((value, c) => { grid[row - 1 + r][column - 1 + c] = value; });
        writes.push({ row: row + r, values: [...values], locked: lock.held === true });
      }),
    }),
  };
  const ctx = vm.createContext({
    requireAppAccess_: () => { if (role === "unauthenticated") throw new Error("ACCESS_DENIED:"); return { role, canWork: role === "worker" || role === "editor" || role === "admin" || role === "owner", canEdit: role === "editor" || role === "admin" || role === "owner" }; },
    requireWorkerAccess_: () => { const access = ctx.requireAppAccess_(); if (!access.canWork) throw new Error("WORKER_REQUIRED:"); return access; },
    requireEditorAccess_: () => { const access = ctx.requireAppAccess_(); if (!access.canEdit) throw new Error("EDITOR_REQUIRED:"); return access; },
    Date: FixedDate, Math, Number, Object, RegExp, String, Array, JSON, Error,
    Utilities: { getUuid: () => "new-job-id", formatDate: (date, timeZone, pattern) => {
      assert.equal(timeZone, "Asia/Tokyo");
      assert.equal(pattern, "yyyy-MM-dd");
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(date).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    } }, SpreadsheetApp: { flush() {} }, LockService: { getScriptLock: () => lock },
  });
  context = ctx;
  vm.runInContext(sources.join("\n"), ctx);
  grid.push([...ctx.APP.JOB_HEADERS], ...initialJobs.map((job) => ctx.jobToRow_(job)));
  Object.assign(ctx, {
    getSpreadsheet_: () => ({ getSheetByName: () => sheet }), ensureSystem_: () => {},
    appendLog_: (...entry) => logs.push(entry),
  });
  return { context: ctx, grid, writes, logs, jobs: () => ctx.readJobs_() };
}

const allDone = (ctx) => Object.fromEntries(ctx.APP.STAGES.map((key) => [key, { status: "done", assignee: "豊" }]));
const fullReturn = (quantity = 7) => ({ sentQuantity: quantity, returnedQuantity: quantity, history: [
  { requestId: "sent", action: "send", quantity, at: "2026-10-01T00:00:00.000Z" },
  { requestId: "returned", action: "return", quantity, at: "2026-10-02T00:00:00.000Z" },
] });
function fixtureJob(ctx, overrides = {}) {
  const stages = Object.fromEntries(ctx.APP.STAGES.map((key) => [key, { status: "working", assignee: "望" }]));
  return {
    id: "JOB-WORKER", customer: "保護得意先", product: "鋭匙鉗子 18cm", productCode: "06-04-08", dueDate: "2026-11-01", quantity: 7,
    specLength: "", specShape: "", bladeWidth: "", serialNo: "保存番号", category: "", stages,
    shippingStatus: "waiting", note: "保護メモ", sourceType: "api-import", sourceRef: "secret-ref",
    priority: "urgent", archived: false, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z",
    version: 4, completedAt: "", labelPrintStatus: "printed", labelPrintedAt: "2026-09-15T00:00:00.000Z",
    distributionAssignee: "河", ...overrides,
  };
}

test("worker final completion enters the ready queue with locked, versioned saves and protected metadata intact", () => {
  role = "worker";
  const seed = harness();
  const job = fixtureJob(seed.context, { polishing: fullReturn() });
  const h = harness([job]);
  const { context } = h;
  const dueDateColumn = context.APP.JOB_HEADERS.indexOf("dueDate");
  const archivedColumn = context.APP.JOB_HEADERS.indexOf("archived");
  h.grid[1][dueDateColumn] = new FixedDate("2026-10-31T15:00:00.000Z");
  h.grid[1][archivedColumn] = "false";
  const stages = { finish: { status: "done", assignee: "豊" } };
  const ready = context.saveJobProcess({ id: job.id, version: 4, stages, shippingStatus: "waiting" });
  assert.equal(ready.version, 5);
  assert.equal(ready.shippingStatus, "waiting");
  assert.equal(ready.stages.finish.status, "done");
  for (const key of ["welding", "base", "grinding", "heat"]) {
    assert.equal(ready.stages[key].status, job.stages[key].status, key);
    assert.equal(ready.stages[key].assignee, job.stages[key].assignee, key);
  }
  assert.equal(ready.completedAt, "");
  assert.equal(ready.updatedAt, fixedNow);
  for (const key of ["customer", "product", "productCode", "quantity", "serialNo", "note", "sourceType", "sourceRef", "priority", "labelPrintStatus", "labelPrintedAt", "distributionAssignee"]) assert.equal(ready[key], job[key], key);
  assert.equal(ready.archived, false);
  assert.equal(ready.dueDate, "2026-11-01");
  assert.equal(ready.createdAt, job.createdAt);
  assert.equal(ready.category, "鋭匙鉗子");
  assert.equal(h.grid[1][dueDateColumn] instanceof Date, true, "raw date cell remains a Date in storage");
  assert.equal(h.grid[1][archivedColumn], "false", "legacy archived representation stays untouched");
  assert.equal(h.jobs()[0].category, "鋭匙鉗子", "normal read model may infer display category while the stored empty value remains empty");
  assert.equal(h.grid[1][context.APP.JOB_HEADERS.indexOf("category")], "");
  assert.equal(h.grid[1][context.APP.JOB_HEADERS.indexOf("specLength")], "");
  assert.equal(h.grid[1][context.APP.JOB_HEADERS.indexOf("sourceRef")], "secret-ref");
  assert.equal(h.grid[1][context.APP.JOB_HEADERS.indexOf("labelPrintStatus")], "printed");
  assert.equal(h.grid[1][context.APP.JOB_HEADERS.indexOf("productCode")], "06-04-08");
  assert.equal(h.logs.length, 1);
  assert.equal(h.writes[0].locked, true, "job persistence occurs while holding the document lock");

  role = "editor";
  const shipped = context.saveJobProcess({ id: job.id, version: ready.version, stages: {}, shippingStatus: "shipped" });
  assert.equal(shipped.shippingStatus, "shipped");
  assert.equal(shipped.completedAt, fixedNow);
  assert.equal(shipped.version, 6);
  for (const key of ["welding", "base", "grinding", "heat"]) assert.equal(shipped.stages[key].status, job.stages[key].status, "earlier stages do not gate shipment");
  const reopenedStages = { welding: { status: "working", assignee: "保" } };
  const reopened = context.saveJobProcess({ id: job.id, version: 6, stages: reopenedStages, shippingStatus: "waiting" });
  assert.equal(reopened.stages.welding.status, "working");
  assert.equal(reopened.stages.base.status, "working", "omitted stages retain their previous values");
  assert.equal(reopened.shippingStatus, "waiting");
  assert.equal(reopened.completedAt, "");
  assert.equal(reopened.version, 7);

  const editorSaved = context.saveJob({ ...reopened, version: reopened.version, note: "editor standard save", productCode: "06-04-8" });
  assert.equal(editorSaved.note, "editor standard save");
  assert.equal(editorSaved.productCode, "06-04-8");
  assert.equal(h.jobs()[0].productCode, "06-04-8");
  assert.equal(h.jobs()[0].note, "editor standard save");
  role = "worker";
});

test("process save rejects forgery, invalid stages/lifecycle, stale, missing, and archived jobs", () => {
  role = "worker";
  const seed = harness();
  const ctx = seed.context;
  const job = fixtureJob(ctx);
  const h = harness([job]);
  const stages = allDone(h.context);
  for (const payload of [
    { id: job.id, version: 4, stages, customer: "forged" },
    { id: job.id, version: 4, stages, sourceRef: "forged" },
  ]) assert.throws(() => h.context.saveJobProcess(payload), /許可されていない項目/);
  assert.throws(() => h.context.saveJobProcess({ id: job.id, version: 4, stages: { bogus: { status: "done", assignee: "" } } }), /不明な工程/);
  assert.throws(() => h.context.saveJobProcess({ id: job.id, version: 4, stages: { welding: { status: "invalid", assignee: "" } } }), /状態が不正/);
  assert.throws(() => h.context.saveJobProcess({ id: job.id, version: 4, stages: { welding: { status: "done", assignee: "架空" } } }), /担当者が不正/);
  assert.throws(() => h.context.saveJobProcess({ id: job.id, version: 4, stages, shippingStatus: "completed" }), /出荷状態が不正/);
  const incomplete = { ...stages, finish: { status: "working", assignee: "" } };
  assert.throws(() => h.context.saveJobProcess({ id: job.id, version: 4, stages: incomplete, shippingStatus: "shipped" }), /EDITOR_REQUIRED/);
  role = "editor";
  assert.throws(() => h.context.saveJobProcess({ id: job.id, version: 4, stages: incomplete, shippingStatus: "shipped" }), /最終仕上げを完了/);
  role = "worker";
  assert.throws(() => h.context.saveJobProcess({ id: job.id, version: 3, stages }), /別の端末/);
  assert.throws(() => h.context.saveJobProcess({ id: "missing", version: 1, stages }), /見つかりません/);
  const archived = fixtureJob(ctx, { id: "ARCHIVED", archived: true });
  const archivedHarness = harness([archived]);
  assert.throws(() => archivedHarness.context.saveJobProcess({ id: archived.id, version: 4, stages }), /削除済み/);
  assert.equal(h.grid.length, 2, "process RPC never creates new jobs");
  assert.equal(h.writes.length, 0, "denied requests do not persist");
  assert.throws(() => h.context.saveJobProcess({ id: job.id, version: "4", stages }), /形式が不正/);
});

test("workers cannot forge shipment or other shipping transitions even while completing the final stage", () => {
  role = "worker";
  const seed = harness();
  const job = fixtureJob(seed.context, { shippingStatus: "not_ready", polishing: fullReturn() });
  const h = harness([job]);
  const before = [...h.grid[1]];
  for (const shippingStatus of ["waiting", "shipped", "hold"]) {
    assert.throws(() => h.context.saveJobProcess({ id: job.id, version: job.version, stages: { finish: { status: "done", assignee: "豊" } }, shippingStatus }), /EDITOR_REQUIRED/);
  }
  assert.deepEqual(Array.from(h.grid[1]), before);
  assert.equal(h.writes.length, 0);
  assert.equal(h.logs.length, 0);
  const ready = h.context.saveJobProcess({ id: job.id, version: job.version, stages: { finish: { status: "done", assignee: "豊" } } });
  assert.equal(ready.shippingStatus, "not_ready", "queue entry derives from final completion without a shipping transition");
  assert.equal(ready.stages.finish.status, "done");
  assert.equal(ready.completedAt, "");
});

test("ready and shipped jobs are read-only to workers across process and distribution updates", () => {
  role = "worker";
  const seed = harness();
  for (const shippingStatus of ["not_ready", "waiting", "hold", "shipped"]) {
    const job = fixtureJob(seed.context, { shippingStatus, stages: allDone(seed.context), polishing: fullReturn() });
    const h = harness([job]);
    const before = [...h.grid[1]];
    for (const stages of [{}, { finish: { status: "working", assignee: "望" } }, { welding: { status: "working", assignee: "望" } }]) {
      assert.throws(() => h.context.saveJobProcess({ id: job.id, version: job.version, stages }), /EDITOR_REQUIRED/, shippingStatus);
    }
    assert.throws(() => h.context.saveJobProcess({ id: job.id, version: job.version, stages: {}, shippingStatus: "waiting" }), /EDITOR_REQUIRED/, "worker cannot reopen a shipped job");
    for (const assignee of [job.distributionAssignee, "豊", ""]) {
      assert.throws(() => h.context.setDistributionAssignee({ id: job.id, version: job.version, assignee }), /EDITOR_REQUIRED/, shippingStatus);
    }
    assert.deepEqual(Array.from(h.grid[1]), before);
    assert.equal(h.writes.length, 0);
    assert.equal(h.logs.length, 0);
  }
  const legacyShipped = fixtureJob(seed.context, { shippingStatus: "shipped" });
  const h = harness([legacyShipped]);
  assert.throws(() => h.context.saveJobProcess({ id: legacyShipped.id, version: legacyShipped.version, stages: {} }), /EDITOR_REQUIRED/, "shipped legacy rows remain locked even when finish is incomplete");
  assert.throws(() => h.context.setDistributionAssignee({ id: legacyShipped.id, version: legacyShipped.version, assignee: "豊" }), /EDITOR_REQUIRED/);
  assert.equal(h.writes.length, 0);
});

test("editors, admins and owners retain ready/shipped edits, shipment and reopening", () => {
  const seed = harness();
  for (const editorRole of ["editor", "admin", "owner"]) {
    role = editorRole;
    const job = fixtureJob(seed.context, { stages: allDone(seed.context), polishing: fullReturn() });
    const h = harness([job]);
    const edited = h.context.saveJobProcess({ id: job.id, version: job.version, stages: { base: { status: "working", assignee: "保" } } });
    const assigned = h.context.setDistributionAssignee({ id: job.id, version: edited.version, assignee: "豊" });
    const shipped = h.context.saveJobProcess({ id: job.id, version: assigned.version, stages: {}, shippingStatus: "shipped" });
    assert.equal(shipped.completedAt, fixedNow);
    assert.equal(shipped.stages.base.status, "working");
    const reassigned = h.context.setDistributionAssignee({ id: job.id, version: shipped.version, assignee: "望" });
    assert.equal(reassigned.completedAt, fixedNow);
    const reopened = h.context.saveJobProcess({ id: job.id, version: reassigned.version, stages: { finish: { status: "working", assignee: "保" } }, shippingStatus: "waiting" });
    assert.equal(reopened.shippingStatus, "waiting");
    assert.equal(reopened.completedAt, "");
    assert.equal(reopened.stages.finish.status, "working");
    role = "worker";
    const workerSaved = h.context.saveJobProcess({ id: job.id, version: reopened.version, stages: { base: { status: "done", assignee: "保" } } });
    assert.equal(workerSaved.stages.base.status, "done", "reopened in-progress jobs return to worker editing");
    assert.ok(h.writes.every((write) => write.locked));
  }
  role = "worker";
});

test("new final completion requires the actual full return and keeps rejected worker rows untouched", () => {
  role = "worker";
  const seed = harness();
  for (const polishing of [
    { sentQuantity: 0, returnedQuantity: 0, history: [] },
    { sentQuantity: 0, returnedQuantity: 0, history: [
      { requestId: "sent", action: "send", quantity: 7, at: "2026-10-01T00:00:00.000Z" },
      { requestId: "canceled", action: "cancel", quantity: 7, at: "2026-10-02T00:00:00.000Z" },
    ] },
    fullReturn(6),
    { sentQuantity: 7, returnedQuantity: 6, history: [
      { requestId: "sent", action: "send", quantity: 7, at: "2026-10-01T00:00:00.000Z" },
      { requestId: "returned", action: "return", quantity: 6, at: "2026-10-02T00:00:00.000Z" },
    ] },
  ]) {
    const job = fixtureJob(seed.context, { polishing });
    const h = harness([job]);
    const before = Array.from(h.grid[1]);
    assert.throws(() => h.context.saveJobProcess({ id: job.id, version: job.version, stages: { finish: { status: "done", assignee: "豊" } } }), /研磨の全数発送と全数の戻り/);
    assert.deepEqual(Array.from(h.grid[1]), before);
    assert.equal(h.writes.length, 0);
    assert.equal(h.logs.length, 0);
    const working = h.context.saveJobProcess({ id: job.id, version: job.version, stages: { finish: { status: "working", assignee: "豊" } } });
    assert.equal(working.stages.finish.status, "working");
    assert.equal(h.writes[0].locked, true);
  }
});

test("historical ordinary completion remains recoverable by workers without changing its stored status on read", () => {
  role = "worker";
  const seed = harness();
  for (const shippingStatus of ["not_ready", "waiting", "hold"]) {
    const job = fixtureJob(seed.context, { shippingStatus, stages: allDone(seed.context) });
    const h = harness([job]);
    assert.equal(h.jobs()[0].stages.finish.status, "done");
    assert.equal(h.writes.length, 0, "read does not reset legacy completion");
    const edited = h.context.saveJobProcess({ id: job.id, version: job.version, stages: { welding: { status: "working", assignee: "望" } } });
    assert.equal(edited.stages.finish.status, "done", "an unrelated process edit preserves historical storage");
    const assigned = h.context.setDistributionAssignee({ id: job.id, version: edited.version, assignee: "豊" });
    const downgraded = h.context.saveJobProcess({ id: job.id, version: assigned.version, stages: { finish: { status: "working", assignee: "望" } } });
    assert.equal(downgraded.stages.finish.status, "working");
    assert.equal(downgraded.shippingStatus, shippingStatus);
    assert.throws(() => h.context.saveJobProcess({ id: job.id, version: downgraded.version, stages: { finish: { status: "done", assignee: "望" } } }), /研磨の全数発送と全数の戻り/);
    role = "editor";
    assert.throws(() => h.context.saveJobProcess({ id: job.id, version: downgraded.version, stages: { finish: { status: "done", assignee: "望" } }, shippingStatus: "shipped" }), /研磨の全数発送と全数の戻り/);
    role = "worker";
    assert.ok(h.writes.every((write) => write.locked));
  }
});

test("worker distribution assignment uses a versioned locked update and denies viewer or unauthenticated calls", () => {
  role = "worker";
  const seed = harness();
  const job = fixtureJob(seed.context);
  const h = harness([job]);
  const assigned = h.context.setDistributionAssignee({ id: job.id, version: 4, assignee: "豊" });
  assert.equal(assigned.distributionAssignee, "豊");
  assert.equal(assigned.version, 5);
  assert.equal(assigned.customer, job.customer);
  assert.equal(h.logs.length, 1);
  assert.equal(h.writes[0].locked, true);
  assert.throws(() => h.context.setDistributionAssignee({ id: job.id, version: 4, assignee: "河" }), /別の端末/);
  assert.throws(() => h.context.setDistributionAssignee({ id: job.id, version: 5, assignee: "invalid" }), /担当者が不正/);
  role = "viewer";
  assert.throws(() => h.context.setDistributionAssignee({ id: job.id, version: 5, assignee: "河" }), /WORKER_REQUIRED/);
  assert.throws(() => h.context.saveJobProcess({ id: job.id, version: 5, stages: allDone(h.context) }), /WORKER_REQUIRED/);
  role = "unauthenticated";
  assert.throws(() => h.context.setDistributionAssignee({ id: job.id, version: 5, assignee: "河" }), /ACCESS_DENIED/);
  role = "worker";
});
