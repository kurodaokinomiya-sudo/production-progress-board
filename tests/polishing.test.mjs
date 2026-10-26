import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const sources = await Promise.all(["Config.gs", "Parser.gs", "Repository.gs", "Polishing.gs"].map(
  (name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8"),
));
const fixedNow = "2026-10-05T03:04:05.000Z";
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedNow])); } }
let role = "editor";

function harness(initial = []) {
  const grids = new Map();
  const writes = [];
  const logs = [];
  const scriptProperties = new Map();
  const mirrorState = { fail: false };
  const lock = { waitLock() { this.held = true; }, releaseLock() { this.held = false; } };
  const makeSheet = (name) => {
    const grid = grids.get(name) || [];
    grids.set(name, grid);
    return {
      getLastRow: () => grid.length,
      getLastColumn: () => grid[0]?.length || 0,
      getRange(row, column, rowCount = 1, columnCount = 1) {
        return {
          getValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => grid[row - 1 + r]?.[column - 1 + c] ?? "")),
          getDisplayValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => String(grid[row - 1 + r]?.[column - 1 + c] ?? ""))),
          setValues(values) {
            if (name === "工程管理_研磨" && mirrorState.fail) throw new Error("mirror unavailable");
            values.forEach((valuesRow, r) => {
              grid[row - 1 + r] ||= [];
              valuesRow.forEach((value, c) => { grid[row - 1 + r][column - 1 + c] = value; });
              writes.push({ sheet: name, row: row + r, values: [...valuesRow], locked: lock.held === true });
            });
          },
          clearContent() { for (let r = 0; r < rowCount; r += 1) for (let c = 0; c < columnCount; c += 1) if (grid[row - 1 + r]) grid[row - 1 + r][column - 1 + c] = ""; },
          setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
        };
      },
      setFrozenRows() {}, autoResizeColumns() {}, setFontWeight() {}, setBackground() {}, setFontColor() {},
    };
  };
  let ctx;
  const spreadsheet = { getSheetByName: makeSheet, insertSheet(name) { return makeSheet(name); } };
  ctx = vm.createContext({
    requireAppAccess_: () => { if (role === "unauthenticated") throw new Error("ACCESS_DENIED:"); return { role, canWork: ["worker", "editor", "admin", "owner"].includes(role), canEdit: ["editor", "admin", "owner"].includes(role) }; },
    requireWorkerAccess_: () => { const access = ctx.requireAppAccess_(); if (!access.canWork) throw new Error("WORKER_REQUIRED:"); return access; },
    requireEditorAccess_: () => { const access = ctx.requireAppAccess_(); if (!access.canEdit) throw new Error("EDITOR_REQUIRED:"); return access; },
    Date: FixedDate, Math, Number, Object, RegExp, String, Array, JSON, Error,
    Utilities: { getUuid: () => "new-job-id", formatDate(date, zone) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
      return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
    } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => scriptProperties.get(key) || null, setProperty: (key, value) => scriptProperties.set(key, value), deleteProperty: (key) => scriptProperties.delete(key) }) },
    SpreadsheetApp: { flush() {} }, LockService: { getScriptLock: () => lock },
  });
  vm.runInContext(sources.join("\n"), ctx);
  grids.set(ctx.APP.SHEETS.JOBS, [[...ctx.APP.JOB_HEADERS], ...initial.map((job) => ctx.jobToRow_(job))]);
  Object.assign(ctx, {
    getSpreadsheet_: () => spreadsheet,
    ensureSystem_: () => { ctx.ensurePolishingSheet_(spreadsheet); },
    appendLog_: (...entry) => logs.push(entry),
  });
  return { context: ctx, grids, writes, logs, scriptProperties, mirrorState, jobs: () => ctx.readJobs_() };
}

function fixture(ctx, id, extra = {}) {
  const stages = Object.fromEntries(ctx.APP.STAGES.map((key) => [key, { status: "working", assignee: "" }]));
  return { id, customer: `得意先-${id}`, product: "鋭匙鉗子 18cm", dueDate: "2026-11-01", quantity: 10,
    specLength: "", specShape: "", bladeWidth: "", serialNo: `SN-${id}`, category: "鋭匙鉗子", stages,
    shippingStatus: "waiting", note: "memo", sourceType: "manual", sourceRef: "", priority: "normal", archived: false,
    createdAt: fixedNow, updatedAt: fixedNow, version: 1, completedAt: "", labelPrintStatus: "printed",
    labelPrintedAt: fixedNow, distributionAssignee: "河", polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] }, ...extra };
}

const move = (id, version, quantity, requestId, action = "send") => ({ requestId, action, items: [{ id, version, quantity }] });
const undoReturn = (id, version, quantity, requestId, returnRequestId) => ({ requestId, action: "undo-return", items: [{ id, version, quantity, returnRequestId }] });
const fullReturnState = (quantity = 5) => ({ sentQuantity: quantity, returnedQuantity: quantity, history: [
  { requestId: "sent", action: "send", quantity, at: "2026-09-29T00:00:00.000Z" },
  { requestId: "returned", action: "return", quantity, at: "2026-10-01T00:00:00.000Z" },
] });

test("historical shipped jobs without polishing history accept quantity corrections and retain completion", () => {
  const seed = harness();
  const makeLegacy = (id, completedAt) => fixture(seed.context, id, {
    quantity: "", shippingStatus: "shipped", completedAt,
    stages: { ...fixture(seed.context, `unused-${id}`).stages, finish: { status: "done", assignee: "" } },
    polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] },
  });
  const h = harness([
    makeLegacy("LEGACY-4", "2026-10-20T01:02:03.000Z"),
    makeLegacy("LEGACY-5", "2026-10-14T01:02:03.000Z"),
  ]);

  for (const [id, quantity, completedAt] of [
    ["LEGACY-4", 4, "2026-10-20T01:02:03.000Z"],
    ["LEGACY-5", 5, "2026-10-14T01:02:03.000Z"],
  ]) {
    const previous = h.jobs().find((job) => job.id === id);
    const saved = h.context.saveJob({ ...previous, quantity });
    assert.equal(saved.quantity, quantity, id);
    assert.equal(saved.shippingStatus, "shipped", id);
    assert.equal(saved.stages.finish.status, "done", id);
    assert.equal(saved.completedAt, completedAt, id);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.polishing)), { sentQuantity: 0, returnedQuantity: 0, history: [] }, id);
    assert.equal(h.jobs().find((job) => job.id === id).completedAt, completedAt, `${id} persisted completion`);
  }

  const sameQuantity = harness([makeLegacy("LEGACY-SAME", "2026-10-15T01:02:03.000Z")]);
  const unchanged = sameQuantity.context.saveJob({ ...sameQuantity.jobs()[0] });
  assert.equal(unchanged.shippingStatus, "shipped");
  assert.equal(unchanged.completedAt, "2026-10-15T01:02:03.000Z");
});

test("historical shipped quantity correction still requires missing polishing evidence to be truly absent", () => {
  const seed = harness();
  const partial = { sentQuantity: 5, returnedQuantity: 2, history: [
    { requestId: "sent", action: "send", quantity: 5, at: "2026-10-01T00:00:00.000Z" },
    { requestId: "returned", action: "return", quantity: 2, at: "2026-10-02T00:00:00.000Z" },
  ] };
  const canceled = { sentQuantity: 0, returnedQuantity: 0, history: [
    { requestId: "sent", action: "send", quantity: 5, at: "2026-10-01T00:00:00.000Z" },
    { requestId: "canceled", action: "cancel", quantity: 5, at: "2026-10-02T00:00:00.000Z" },
  ] };
  for (const [id, polishing] of [["PARTIAL", partial], ["CANCELED", canceled]]) {
    const previous = fixture(seed.context, id, {
      quantity: 5, shippingStatus: "shipped", completedAt: "2026-10-20T01:02:03.000Z",
      stages: { ...fixture(seed.context, `unused-${id}`).stages, finish: { status: "done", assignee: "" } }, polishing,
    });
    const h = harness([previous]);
    assert.throws(() => h.context.saveJob({ ...h.jobs()[0], quantity: 6 }), /研磨の全数発送と全数の戻り/, id);
    assert.equal(h.jobs()[0].quantity, 5, `${id} row stays unchanged on rejection`);
  }
});

test("recorded polishing quantities and new shipment gates remain enforced", () => {
  const seed = harness();
  const shipped = fixture(seed.context, "FULL", {
    quantity: 5, shippingStatus: "shipped", completedAt: "2026-10-20T01:02:03.000Z",
    stages: { ...fixture(seed.context, "unused-full").stages, finish: { status: "done", assignee: "" } },
    polishing: fullReturnState(5),
  });
  const h = harness([shipped]);
  assert.throws(() => h.context.saveJob({ ...h.jobs()[0], quantity: 6 }), /研磨の全数発送と全数の戻り/);
  assert.equal(h.jobs()[0].quantity, 5);

  const fresh = harness();
  const newShipped = fixture(fresh.context, "NEW-SHIPPED", {
    quantity: 4, shippingStatus: "shipped", stages: { ...fixture(fresh.context, "unused-new").stages, finish: { status: "done", assignee: "" } },
  });
  assert.throws(() => fresh.context.saveJob({ ...newShipped, version: 0 }), /研磨の全数発送と全数の戻り/);

  const waiting = harness([fixture(seed.context, "WAITING", {
    quantity: 5, shippingStatus: "waiting", stages: { ...fixture(seed.context, "unused-waiting").stages, finish: { status: "done", assignee: "" } },
  })]);
  assert.throws(() => waiting.context.saveJob({ ...waiting.jobs()[0], shippingStatus: "shipped" }), /研磨の全数発送と全数の戻り/);
});

test("dispatch and return dates use the selected Japan day and keep actual recording timestamps", () => {
  const seed = harness(), h = harness([fixture(seed.context, "DATE")]);
  const sent = h.context.savePolishingMovement({...move("DATE", 1, 5, "dated-send"), date:"2026-09-29"}).jobs[0];
  assert.equal(sent.polishing.history[0].at, "2026-09-28T15:00:00.000Z");
  assert.equal(sent.polishing.history[0].recordedAt, fixedNow);
  const returned = h.context.savePolishingMovement({...move("DATE", 2, 5, "dated-return", "return"), date:"2026-09-30"}).jobs[0];
  assert.equal(returned.polishing.history[1].at, "2026-09-29T15:00:00.000Z");
  assert.equal(returned.updatedAt, fixedNow);
  assert.equal(h.context.polishingLastEventDate_(returned, "return"), "2026/09/30 00:00");
  assert.equal(h.logs[1][3].date, "2026-09-30");
  assert.equal(h.context.savePolishingMovement({...move("DATE", 1, 5, "dated-send"), date:"2026-09-29"}).jobs[0].version, 3);
  assert.throws(() => h.context.savePolishingMovement({...move("DATE", 3, 5, "dated-send"), date:"2026-09-30"}), /リクエストID/);
  assert.ok(h.writes.filter((write) => write.sheet === h.context.APP.SHEETS.JOBS).every((write) => write.locked));
});

test("invalid, nonexistent and future dates reject before canonical writes", () => {
  const seed = harness(), h = harness([fixture(seed.context, "DATE")]);
  for (const date of ["", null, "2026-2-03", "2026-02-30", "2026-10-06", "not-a-date"]) {
    assert.throws(() => h.context.savePolishingMovement({...move("DATE", 1, 1, "bad-date"), date}), /日付/);
  }
  assert.equal(h.writes.filter((write) => write.sheet === h.context.APP.SHEETS.JOBS).length, 0);
});

test("backdated return batch validates all dates before writing, including repeated send cycles", () => {
  const seed = harness(), h = harness([fixture(seed.context, "A"), fixture(seed.context, "B")]);
  h.context.savePolishingMovement({...move("A", 1, 5, "send-a"), date:"2026-09-30"});
  h.context.savePolishingMovement({...move("B", 1, 5, "send-b"), date:"2026-10-02"});
  const before = JSON.stringify(h.grids.get(h.context.APP.SHEETS.JOBS));
  assert.throws(() => h.context.savePolishingMovement({requestId:"bad-batch-date",action:"return",date:"2026-10-01",items:[
    {id:"A",version:2,quantity:5},{id:"B",version:2,quantity:5},
  ]}), /発送日より前/);
  assert.equal(JSON.stringify(h.grids.get(h.context.APP.SHEETS.JOBS)), before);
  h.context.savePolishingMovement({...move("A", 2, 5, "return-a", "return"), date:"2026-09-30"});
  h.context.savePolishingMovement({...move("A", 3, 5, "send-a2"), date:"2026-10-03"});
  assert.throws(() => h.context.savePolishingMovement({...move("A", 4, 5, "return-a2", "return"), date:"2026-10-02"}), /発送日より前/);
});

test("history date correction preserves quantities, raw cells and lifecycle, including shipped jobs", () => {
  const seed = harness(), h = harness([fixture(seed.context, "EDIT", {quantity:5,shippingStatus:"shipped",polishing:fullReturnState()})]);
  const before = h.grids.get(h.context.APP.SHEETS.JOBS)[1].slice();
  const payload = {id:"EDIT",version:1,eventRequestId:"returned",date:"2026-09-30",requestId:"date-edit"};
  const saved = h.context.savePolishingEventDate(payload).jobs[0];
  assert.equal(saved.polishing.history[1].at, "2026-09-29T15:00:00.000Z");
  assert.equal(saved.polishing.history[1].recordedAt, fullReturnState().history[1].at);
  assert.equal(saved.polishing.history[1].dateEdits[0].previousAt, fullReturnState().history[1].at);
  assert.equal(saved.polishing.sentQuantity, 5);
  assert.equal(saved.polishing.returnedQuantity, 5);
  assert.equal(saved.shippingStatus, "shipped");
  const after = h.grids.get(h.context.APP.SHEETS.JOBS)[1];
  h.context.APP.JOB_HEADERS.forEach((header, index) => { if (!["polishingJson","updatedAt","version"].includes(header)) assert.deepEqual(after[index], before[index], header); });
  assert.equal(h.grids.get(h.context.APP.SHEETS.POLISHING)[1][11], "2026/09/30 00:00");
  assert.equal(h.context.savePolishingEventDate(payload).jobs[0].version, 2, "lost-response retry is idempotent despite old version");
  assert.equal(h.logs.length, 1);
  h.context.savePolishingEventDate({...payload,version:2,date:"2026-10-02",requestId:"date-edit-2"});
  assert.equal(h.context.savePolishingEventDate(payload).jobs[0].polishing.history[1].at, "2026-10-01T15:00:00.000Z", "old retry must not overwrite a newer correction");
  assert.equal(h.jobs()[0].polishing.history[1].dateEdits.length, 2, "normalization preserves the correction audit");
  assert.throws(() => h.context.savePolishingEventDate({...payload,date:"2026-10-01"}), /リクエストID/);
});

test("date corrections enforce chronology, version, history identity and editor access", () => {
  const seed = harness(), h = harness([fixture(seed.context, "EDIT", {quantity:5,polishing:fullReturnState()})]);
  const payload = {id:"EDIT",version:1,eventRequestId:"returned",date:"2026-09-30",requestId:"edit"};
  assert.throws(() => h.context.savePolishingEventDate({...payload,date:"2026-09-28"}), /発送日より前/);
  assert.throws(() => h.context.savePolishingEventDate({...payload,eventRequestId:"sent",date:"2026-10-02"}), /発送日より前/);
  assert.throws(() => h.context.savePolishingEventDate({...payload,version:8}), /別の端末/);
  assert.throws(() => h.context.savePolishingEventDate({...payload,eventRequestId:"missing"}), /履歴が見つかりません/);
  for (const restricted of ["worker", "viewer", "unauthenticated"]) {
    role = restricted;
    assert.throws(() => h.context.savePolishingEventDate(payload), /(EDITOR_REQUIRED|ACCESS_DENIED)/);
  }
  role = "editor";
  assert.equal(h.writes.filter((write) => write.sheet === h.context.APP.SHEETS.JOBS).length, 0);
});

test("legacy polishing headings are renamed to 発送 without changing rows or accepting unknown sheets", () => {
  const h = harness();
  const legacy = [...h.context.POLISHING_HEADERS];
  legacy[6] = "持出し数量";
  legacy[10] = "最終送付日";
  const row = ["A", "得意先", "品名", "SN-A", "2026-11-01", 10, 10, 0, 10, "—", "2026/10/05 12:04", ""];
  h.grids.set(h.context.APP.SHEETS.POLISHING, [legacy, [...row]]);
  h.context.ensurePolishingSheet_(h.context.getSpreadsheet_());
  assert.deepEqual(h.grids.get(h.context.APP.SHEETS.POLISHING), [[...h.context.POLISHING_HEADERS], row]);
  assert.equal(h.writes.length, 1);
  h.context.ensurePolishingSheet_(h.context.getSpreadsheet_());
  assert.equal(h.writes.length, 1, "subsequent reads must not rewrite the headings");
  const invalid = harness();
  invalid.grids.set(invalid.context.APP.SHEETS.POLISHING, [["別の見出し", ...legacy.slice(1)], [...row]]);
  assert.throws(() => invalid.context.ensurePolishingSheet_(invalid.context.getSpreadsheet_()), /見出しがアプリ形式と異なります/);
  assert.equal(invalid.writes.length, 0);
});

test("partial send and returns accumulate, batches update several jobs, and retries are idempotent", () => {
  const seed = harness();
  const a = fixture(seed.context, "A", { stages: { ...fixture(seed.context, "A").stages, finish: { status: "done", assignee: "望" } } });
  const b = fixture(seed.context, "B");
  const h = harness([a, b]);
  const result = h.context.savePolishingMovement({ requestId: "batch-1", action: "send", items: [{ id: "A", version: 1, quantity: 4 }, { id: "B", version: 1, quantity: 2 }] });
  assert.deepEqual(result.jobs.map((job) => job.polishing.sentQuantity), [4, 2]);
  assert.deepEqual(result.jobs.map((job) => job.version), [2, 2]);
  assert.equal(result.jobs[0].stages.finish.status, "not_started");
  assert.equal(result.jobs[0].stages.finish.assignee, "望");
  assert.ok(h.writes.filter((write) => write.sheet === h.context.APP.SHEETS.JOBS).every((write) => write.locked));
  assert.equal(h.context.savePolishingMovement(move("A", 1, 4, "batch-1")).jobs[0].version, 2, "retry succeeds with stale version");
  assert.throws(() => h.context.savePolishingMovement(move("A", 2, 3, "batch-1")), /リクエストID/);
  h.context.savePolishingMovement(move("A", 2, 1, "send-2"));
  const returned = h.context.savePolishingMovement(move("A", 3, 2, "return-1", "return")).jobs[0];
  assert.equal(returned.polishing.returnedQuantity, 2);
  assert.equal(returned.polishing.sentQuantity - returned.polishing.returnedQuantity, 3);
  h.context.savePolishingMovement(move("A", 4, 1, "return-2", "return"));
  assert.equal(h.jobs().find((job) => job.id === "A").polishing.returnedQuantity, 3);
});

test("invalid or stale batch writes no canonical rows; over-return and over-cancel are rejected", () => {
  const seed = harness();
  const h = harness([fixture(seed.context, "A"), fixture(seed.context, "B")]);
  assert.throws(() => h.context.savePolishingMovement({ requestId: "bad", action: "send", items: [{ id: "A", version: 1, quantity: 3 }, { id: "B", version: 8, quantity: 2 }] }), /別の端末/);
  assert.equal(h.writes.filter((write) => write.sheet === h.context.APP.SHEETS.JOBS).length, 0);
  h.context.savePolishingMovement(move("A", 1, 2, "s1"));
  assert.throws(() => h.context.savePolishingMovement(move("A", 2, 3, "r1", "return")), /未返却数量/);
  assert.throws(() => h.context.savePolishingMovement(move("A", 2, 3, "c1", "cancel")), /未返却数量/);
  assert.throws(() => h.context.savePolishingMovement({ requestId: "dupe", action: "send", items: [{ id: "A", version: 2, quantity: 1 }, { id: "A", version: 2, quantity: 1 }] }), /同じ案件/);
});

test("undo-return restores the whole return to polishing and resets finishing without changing assignees", () => {
  const seed = harness();
  for (const status of ["done", "working"]) {
    const job = fixture(seed.context, status, { quantity: 5, polishing: fullReturnState() });
    job.stages.finish = { status, assignee: "望" };
    const h = harness([job]);
    const undone = h.context.savePolishingMovement(undoReturn(status, 1, 5, "undo", "returned")).jobs[0];
    assert.equal(undone.polishing.sentQuantity, 5);
    assert.equal(undone.polishing.returnedQuantity, 0);
    assert.equal(h.context.polishingOutstanding_(undone.polishing), 5);
    assert.deepEqual(JSON.parse(JSON.stringify(undone.polishing.history.slice(0, 2))), fullReturnState().history, "original send and return remain in the history");
    assert.deepEqual(JSON.parse(JSON.stringify(undone.polishing.history[2])), { requestId: "undo", action: "undo-return", quantity: 5, at: fixedNow, returnRequestId: "returned" });
    assert.equal(undone.stages.finish.status, "not_started");
    assert.equal(undone.stages.finish.assignee, "望");
    assert.equal(undone.shippingStatus, "not_ready");
    assert.equal(undone.version, 2);
    assert.equal(undone.updatedAt, fixedNow);
    for (const key of ["quantity", "customer", "dueDate", "note", "distributionAssignee", "labelPrintStatus", "labelPrintedAt"]) assert.equal(undone[key], job[key], key);
    assert.equal(h.context.polishingActiveReturns_(undone.polishing).length, 0);
    assert.equal(h.context.polishingLastEventDate_(undone, "send"), "2026/09/29 09:00");
    assert.equal(h.context.polishingLastEventDate_(undone, "return"), "");
    assert.throws(() => h.context.saveJobProcess({ id: status, version: undone.version, stages: { finish: { status: "done", assignee: "望" } } }), /研磨/, "returned work cannot immediately be marked finished again");
    const mirror = h.grids.get(h.context.APP.SHEETS.POLISHING)[1];
    assert.deepEqual(mirror.slice(6, 12), [5, 0, 5, "—", "2026/09/29 09:00", ""]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.logs[0])), ["job.polishing.undo-return", "job", status, { requestId: "undo", quantity: 5, version: 2, returnRequestId: "returned" }]);
  }
});

test("a real return clears premature legacy ordinary completion so final finishing must be completed after return", () => {
  role = "editor";
  const seed = harness();
  const job = fixture(seed.context, "PREMATURE", { quantity: 5, polishing: { sentQuantity: 5, returnedQuantity: 3, history: [
    { requestId: "sent", action: "send", quantity: 5, at: "2026-09-29T00:00:00.000Z" },
    { requestId: "partial-return", action: "return", quantity: 3, at: "2026-10-01T00:00:00.000Z" },
  ] } });
  job.stages.finish = { status: "done", assignee: "望" };
  const h = harness([job]);
  const headers = h.context.APP.JOB_HEADERS;
  const original = h.grids.get(h.context.APP.SHEETS.JOBS)[1].slice();
  const payload = move(job.id, job.version, 2, "remaining-return", "return");
  const returned = h.context.savePolishingMovement(payload).jobs[0];
  assert.equal(h.context.finalFinishingReady_(returned), true);
  assert.equal(returned.stages.finish.status, "not_started");
  assert.equal(returned.stages.finish.assignee, "望");
  assert.equal(returned.shippingStatus, "not_ready");
  assert.equal(returned.version, 2);
  assert.equal(h.grids.get(h.context.APP.SHEETS.POLISHING)[1][9], "待ち");
  const changed = new Set(["polishingJson", "finishStatus", "shippingStatus", "version", "updatedAt"]);
  const stored = h.grids.get(h.context.APP.SHEETS.JOBS)[1];
  headers.forEach((header, index) => { if (!changed.has(header)) assert.deepEqual(stored[index], original[index], header); });
  assert.equal(h.logs[0][0], "job.polishing.return");
  role = "worker";
  const finished = h.context.saveJobProcess({ id: job.id, version: returned.version, stages: { finish: { status: "done", assignee: "望" } } });
  assert.equal(finished.stages.finish.status, "done");
  assert.equal(finished.version, 3);
  assert.equal(h.grids.get(h.context.APP.SHEETS.POLISHING)[1][9], "完了");
  role = "editor";
  const retried = h.context.savePolishingMovement(payload).jobs[0];
  assert.equal(retried.stages.finish.status, "done", "retrying the old return must not reset a later explicit final completion");
  assert.equal(retried.version, finished.version);
  assert.ok(h.writes.filter((write) => write.sheet === h.context.APP.SHEETS.JOBS).every((write) => write.locked));
});

test("undoing the latest partial return retains earlier returns and uses their date in the mirror", () => {
  const seed = harness();
  const history = [
    { requestId: "sent", action: "send", quantity: 10, at: "2026-09-29T00:00:00.000Z" },
    { requestId: "true-return", action: "return", quantity: 2, at: "2026-09-30T15:30:00.000Z" },
    { requestId: "mistake", action: "return", quantity: 8, at: "2026-10-04T00:00:00.000Z" },
  ];
  const h = harness([fixture(seed.context, "A", { polishing: { sentQuantity: 10, returnedQuantity: 10, history } })]);
  const undone = h.context.savePolishingMovement(undoReturn("A", 1, 8, "undo-latest", "mistake")).jobs[0];
  assert.equal(undone.polishing.sentQuantity, 10);
  assert.equal(undone.polishing.returnedQuantity, 2);
  assert.deepEqual(Array.from(h.context.polishingActiveReturns_(JSON.stringify(undone.polishing)), event => event.requestId), ["true-return"]);
  const mirror = h.grids.get(h.context.APP.SHEETS.POLISHING)[1];
  assert.deepEqual(mirror.slice(6, 12), [10, 2, 8, "待ち", "2026/09/29 09:00", "2026/10/01 00:30"]);
  const restored = h.context.savePolishingMovement(undoReturn("A", 2, 2, "undo-earlier", "true-return")).jobs[0];
  assert.equal(restored.polishing.returnedQuantity, 0, "the earlier return becomes the latest active target after the later return is undone");
  assert.equal(h.grids.get(h.context.APP.SHEETS.POLISHING)[1][11], "");
});

test("undo-return preserves raw cells and changes only movement, version, and lifecycle fields", () => {
  const seed = harness();
  const h = harness([fixture(seed.context, "RAW", { quantity: 5, polishing: fullReturnState() })]);
  const headers = h.context.APP.JOB_HEADERS;
  const row = h.grids.get(h.context.APP.SHEETS.JOBS)[1];
  const set = (key, value) => { row[headers.indexOf(key)] = value; };
  set("category", "");
  set("specLength", "");
  set("finishStatus", "working");
  set("finishAssignee", "望");
  set("dueDate", new FixedDate("2026-11-01T00:00:00.000Z"));
  set("labelPrintStatus", "legacy-label-state");
  set("labelPrintedAt", new FixedDate("2026-09-15T00:00:00.000Z"));
  const original = row.slice();
  h.context.savePolishingMovement(undoReturn("RAW", 1, 5, "undo-raw", "returned"));
  const stored = h.grids.get(h.context.APP.SHEETS.JOBS)[1];
  const allowed = new Set(["polishingJson", "updatedAt", "version", "finishStatus", "shippingStatus"]);
  headers.forEach((header, index) => { if (!allowed.has(header)) assert.deepEqual(stored[index], original[index], header); });
  assert.equal(stored[headers.indexOf("finishStatus")], "not_started");
  assert.equal(stored[headers.indexOf("shippingStatus")], "not_ready");
  assert.equal(stored[headers.indexOf("finishAssignee")], "望");
  assert.equal(stored[headers.indexOf("dueDate")] instanceof Date, true);
});

test("undo-return is idempotent and rejects changed targets, quantities, versions, and repeated corrections", () => {
  const seed = harness();
  const h = harness([fixture(seed.context, "A", { polishing: { sentQuantity: 5, returnedQuantity: 5, history: [
    { requestId: "sent", action: "send", quantity: 5, at: fixedNow },
    { requestId: "first", action: "return", quantity: 2, at: fixedNow },
    { requestId: "latest", action: "return", quantity: 3, at: fixedNow },
  ] } })]);
  const canonicalWrites = () => h.writes.filter(write => write.sheet === h.context.APP.SHEETS.JOBS).length;
  assert.throws(() => h.context.savePolishingMovement(undoReturn("A", 1, 2, "older", "first")), /最新の返却履歴/);
  assert.throws(() => h.context.savePolishingMovement(undoReturn("A", 1, 2, "partial", "latest")), /全数量/);
  assert.throws(() => h.context.savePolishingMovement(undoReturn("A", 1, 3, "missing", "unknown")), /最新の返却履歴/);
  for (const reference of [undefined, "", " ", 123, "x".repeat(121)]) assert.throws(() => h.context.savePolishingMovement(undoReturn("A", 1, 3, "invalid", reference)), /指定が不正/);
  assert.equal(canonicalWrites(), 0);
  const input = undoReturn("A", 1, 3, "undo", "latest");
  assert.equal(h.context.savePolishingMovement(input).jobs[0].version, 2);
  assert.equal(h.context.savePolishingMovement(input).jobs[0].version, 2, "retry succeeds with the original stale version and target");
  assert.equal(canonicalWrites(), 1);
  assert.equal(h.logs.length, 1);
  assert.throws(() => h.context.savePolishingMovement(undoReturn("A", 1, 3, "undo", "first")), /リクエストID/);
  assert.throws(() => h.context.savePolishingMovement(undoReturn("A", 1, 2, "undo", "latest")), /リクエストID/);
  assert.throws(() => h.context.savePolishingMovement(undoReturn("A", 2, 3, "again", "latest")), /最新の返却履歴/);
  assert.throws(() => h.context.savePolishingMovement(undoReturn("A", 1, 2, "stale", "first")), /別の端末/);
  assert.equal(canonicalWrites(), 1);
  const returned = h.context.savePolishingMovement(move("A", 2, 3, "real-return", "return")).jobs[0];
  assert.equal(returned.polishing.returnedQuantity, 5, "a genuine later return can reuse the restored outstanding quantity");
  assert.deepEqual(Array.from(h.context.polishingActiveReturns_(returned.polishing), event => event.requestId), ["first", "real-return"]);
});

test("undo-return keeps batch validation atomic and enforces archive, shipment, and worker access", () => {
  const seed = harness();
  const jobs = ["A", "B"].map(id => fixture(seed.context, id, { quantity: 5, polishing: fullReturnState() }));
  const h = harness(jobs);
  const batch = { requestId: "undo-batch", action: "undo-return", items: [
    { id: "A", version: 1, quantity: 5, returnRequestId: "returned" },
    { id: "B", version: 1, quantity: 5, returnRequestId: "wrong" },
  ] };
  assert.throws(() => h.context.savePolishingMovement(batch), /最新の返却履歴/);
  assert.equal(h.writes.filter(write => write.sheet === h.context.APP.SHEETS.JOBS).length, 0);
  assert.equal(h.jobs()[0].polishing.returnedQuantity, 5);
  batch.items[1].returnRequestId = "returned";
  assert.deepEqual(Array.from(h.context.savePolishingMovement(batch).jobs, job => job.polishing.returnedQuantity), [0, 0]);
  assert.ok(h.writes.filter(write => write.sheet === h.context.APP.SHEETS.JOBS).every(write => write.locked));
  for (const [extra, message] of [[{ archived: true }, /削除済み/], [{ shippingStatus: "shipped" }, /出荷済み/]]) {
    const protectedJob = harness([fixture(seed.context, "protected", { quantity: 5, polishing: fullReturnState(), ...extra })]);
    assert.throws(() => protectedJob.context.savePolishingMovement(undoReturn("protected", 1, 5, "undo", "returned")), message);
    assert.equal(protectedJob.writes.filter(write => write.sheet === protectedJob.context.APP.SHEETS.JOBS).length, 0);
  }
  for (const deniedRole of ["worker", "viewer", "unauthenticated"]) {
    role = deniedRole;
    try { assert.throws(() => h.context.savePolishingMovement(undoReturn("A", 2, 5, "denied", "returned")), /EDITOR_REQUIRED|ACCESS_DENIED/); }
    finally { role = "editor"; }
  }
});

test("history replay validates undo references, exact quantities, single correction, and net totals", () => {
  const h = harness();
  const original = fullReturnState();
  const undo = { requestId: "undo", action: "undo-return", quantity: 5, at: fixedNow, returnRequestId: "returned" };
  const valid = { sentQuantity: 5, returnedQuantity: 0, history: [...original.history, undo] };
  assert.equal(h.context.normalizePolishing_(JSON.stringify(valid)).history[2].returnRequestId, "returned");
  for (const reference of [undefined, null, 123, "", " ", "unknown", "sent", "undo", "x".repeat(121)]) {
    assert.throws(() => h.context.normalizePolishing_({ ...valid, history: [...original.history, { ...undo, returnRequestId: reference }] }), /返却取消の参照または数量/);
  }
  assert.throws(() => h.context.normalizePolishing_({ sentQuantity: 5, returnedQuantity: 1, history: [...original.history, { ...undo, quantity: 4 }] }), /返却取消の参照または数量/);
  assert.throws(() => h.context.normalizePolishing_({ ...valid, history: [original.history[0], undo, original.history[1]] }), /返却取消の参照または数量/, "a reference cannot point to a later return");
  assert.throws(() => h.context.normalizePolishing_({ ...valid, history: [...valid.history, { ...undo, requestId: "undo-twice" }] }), /返却取消の参照または数量/);
  assert.throws(() => h.context.normalizePolishing_({ ...valid, returnedQuantity: 5 }), /累計数量が一致しません/);
  assert.throws(() => h.context.normalizePolishing_({ ...valid, sentQuantity: 0, history: [...valid.history, { requestId: "cancel", action: "cancel", quantity: 6, at: fixedNow }] }), /取消数量が未返却数量を超えています/);
  const resent = { sentQuantity: 5, returnedQuantity: 5, history: [...valid.history, { requestId: "real-return", action: "return", quantity: 5, at: fixedNow }] };
  assert.deepEqual(Array.from(h.context.polishingActiveReturns_(resent), event => event.requestId), ["real-return"]);
  assert.throws(() => h.context.normalizePolishing_({ ...resent, returnedQuantity: 0, history: [...resent.history, { ...undo, requestId: "undo-old-again" }] }), /返却取消の参照または数量/, "another genuine return does not make an already corrected return eligible twice");
  assert.throws(() => h.context.normalizePolishing_({ ...resent, history: [...resent.history, { requestId: "too-many", action: "return", quantity: 1, at: fixedNow }] }), /返却数量が送付数量を超えています/);
});

test("ordinary and process saves preserve polishing history and process save preserves its stored JSON text", () => {
  const seed = harness();
  const h = harness([fixture(seed.context, "A")]);
  h.context.savePolishingMovement(move("A", 1, 2, "s1"));
  const job = h.jobs()[0];
  job.note = "updated";
  role = "editor";
  const saved = h.context.saveJob({ ...job, version: job.version });
  role = "worker";
  assert.equal(saved.polishing.sentQuantity, 2);
  const column = h.context.APP.JOB_HEADERS.indexOf("polishingJson");
  const raw = ` ${JSON.stringify(saved.polishing)} `;
  h.grids.get(h.context.APP.SHEETS.JOBS)[1][column] = raw;
  const stages = { finish: { status: "working", assignee: "望" } };
  const processed = h.context.saveJobProcess({ id: "A", version: saved.version, stages });
  assert.equal(processed.polishing.sentQuantity, 2);
  assert.equal(h.grids.get(h.context.APP.SHEETS.JOBS)[1][column], raw);
  for (const key of ["labelPrintStatus", "labelPrintedAt", "distributionAssignee", "note"]) assert.equal(processed[key], saved[key], key);
  role = "editor";
});

test("send and return update only movement and lifecycle cells in the raw job row", () => {
  const seed = harness();
  const h = harness([fixture(seed.context, "RAW")]);
  const headers = h.context.APP.JOB_HEADERS;
  const row = h.grids.get(h.context.APP.SHEETS.JOBS)[1];
  const set = (key, value) => { row[headers.indexOf(key)] = value; };
  set("specLength", "");
  set("specShape", "");
  set("bladeWidth", "");
  set("category", "");
  set("dueDate", new FixedDate("2026-11-01T00:00:00.000Z"));
  set("labelPrintStatus", "legacy-label-state");
  set("labelPrintedAt", new FixedDate("2026-09-15T00:00:00.000Z"));
  const protectedColumns = new Set(["polishingJson", "updatedAt", "version", "finishStatus", "shippingStatus"]);
  const original = row.slice();
  h.context.savePolishingMovement(move("RAW", 1, 3, "raw-send"));
  let stored = h.grids.get(h.context.APP.SHEETS.JOBS)[1];
  headers.forEach((header, index) => { if (!protectedColumns.has(header)) assert.deepEqual(stored[index], original[index], header); });
  assert.equal(stored[headers.indexOf("specLength")], "");
  assert.equal(stored[headers.indexOf("category")], "");
  assert.equal(stored[headers.indexOf("labelPrintStatus")], "legacy-label-state");
  assert.equal(stored[headers.indexOf("dueDate")] instanceof Date, true);
  assert.equal(stored[headers.indexOf("finishStatus")], "not_started");
  assert.equal(stored[headers.indexOf("finishAssignee")], "");

  const beforeReturn = stored.slice();
  h.context.savePolishingMovement(move("RAW", 2, 1, "raw-return", "return"));
  stored = h.grids.get(h.context.APP.SHEETS.JOBS)[1];
  const returnAllowed = new Set(["polishingJson", "updatedAt", "version"]);
  headers.forEach((header, index) => { if (!returnAllowed.has(header)) assert.deepEqual(stored[index], beforeReturn[index], header); });
});

test("finish, quantity, archive, shipped-job, and role lifecycle rules are enforced", () => {
  const seed = harness();
  const h = harness([fixture(seed.context, "A"), fixture(seed.context, "S", { shippingStatus: "shipped" }), fixture(seed.context, "C")]);
  h.context.savePolishingMovement(move("A", 1, 4, "s1"));
  const job = h.jobs().find((item) => item.id === "A");
  const done = Object.fromEntries(h.context.APP.STAGES.map((key) => [key, { status: "done", assignee: "" }]));
  assert.throws(() => h.context.saveJobProcess({ id: "A", version: job.version, stages: done, shippingStatus: "shipped" }), /研磨/);
  role = "editor";
  assert.throws(() => h.context.saveJob({ ...job, quantity: 3, version: job.version }), /数量より少なく/);
  role = "editor";
  assert.throws(() => h.context.setJobArchived({ id: "A", version: job.version, archived: true }), /未返却/);
  role = "editor";
  assert.throws(() => h.context.savePolishingMovement(move("S", 1, 1, "s2")), /出荷済み/);
  h.context.savePolishingMovement(move("C", 1, 2, "send-c"));
  h.context.savePolishingMovement(move("C", 2, 2, "cancel-c", "cancel"));
  const canceled = h.jobs().find((item) => item.id === "C");
  assert.equal(canceled.polishing.sentQuantity, 0);
  assert.throws(() => h.context.saveJobProcess({ id: "C", version: canceled.version, stages: done, shippingStatus: "shipped" }), /研磨の全数発送と全数の戻り/);
  h.context.savePolishingMovement(move("C", canceled.version, 10, "send-c-again"));
  const returned = h.context.savePolishingMovement(move("C", canceled.version + 1, 10, "return-c", "return")).jobs[0];
  assert.doesNotThrow(() => h.context.saveJobProcess({ id: "C", version: returned.version, stages: done, shippingStatus: "shipped" }));
  role = "worker";
  assert.throws(() => h.context.savePolishingMovement(move("A", job.version, 1, "worker")), /EDITOR_REQUIRED/);
  role = "viewer";
  assert.throws(() => h.context.savePolishingMovement(move("A", job.version, 1, "viewer")), /EDITOR_REQUIRED/);
  role = "editor";
});

test("readable polishing mirror is derived from canonical jobs and updated by movement and finish saves", () => {
  const seed = harness();
  const h = harness([fixture(seed.context, "A")]);
  h.context.savePolishingMovement(move("A", 1, 5, "s1"));
  let mirror = h.grids.get(h.context.APP.SHEETS.POLISHING);
  assert.deepEqual(mirror[0], ["案件ID", "得意先", "品名", "製造番号", "納期", "総数量", "発送数量", "戻り数量", "研磨屋の数量", "最終仕上げ状態", "発送日", "最終返却日", "製品番号", "研磨区分", "使用材料", "江部自由単価", "嘉代自由単価"]);
  assert.equal(mirror[1][0], "A");
  assert.equal(mirror[1][6], 5);
  assert.equal(mirror[1][8], 5);
  const job = h.jobs()[0];
  h.context.saveJobProcess({ id: "A", version: job.version, stages: { finish: { status: "working", assignee: "" } } });
  mirror = h.grids.get(h.context.APP.SHEETS.POLISHING);
  assert.equal(mirror[1][9], "—");
  h.context.savePolishingMovement(move("A", 3, 2, "r1", "return"));
  mirror = h.grids.get(h.context.APP.SHEETS.POLISHING);
  assert.equal(mirror[1][9], "中");
  assert.match(mirror[1][10], /^2026\/10\/05/);
  assert.match(mirror[1][11], /^2026\/10\/05/);
});

test("malformed stored polishing history is rejected without dropping recorded quantities", () => {
  const seed = harness();
  const job = fixture(seed.context, "A");
  const h = harness([job]);
  const column = h.context.APP.JOB_HEADERS.indexOf("polishingJson");
  h.grids.get(h.context.APP.SHEETS.JOBS)[1][column] = "{broken";
  assert.throws(() => h.jobs(), /履歴の保存データ/);
  h.grids.get(h.context.APP.SHEETS.JOBS)[1][column] = JSON.stringify({ sentQuantity: 2, returnedQuantity: 3, history: [] });
  assert.throws(() => h.jobs(), /履歴の保存データ/);
  h.grids.get(h.context.APP.SHEETS.JOBS)[1][column] = JSON.stringify({ sentQuantity: 2, returnedQuantity: 1, history: [{ requestId: "s", action: "send", quantity: 2, at: "bad-date" }] });
  assert.throws(() => h.jobs(), /履歴の保存データ/);
});

test("polishing mirror shows custom vendor rates only for free-price products and preserves zero versus unknown", () => {
  const seed = harness();
  const h = harness(["CUSTOM", "UNKNOWN", "NORMAL"].map(id => fixture(seed.context, id, { polishing: fullReturnState() })));
  h.context.decorateProductJobs_ = jobs => jobs.map(job => ({ ...job, productMaster: {
    classCode: job.id === "NORMAL" ? "A" : "自由設定",
    customRates: job.id === "UNKNOWN" ? { "江部": null, "嘉代": 1234 } : { "江部": 0, "嘉代": 2345.67 },
  } }));
  h.context.syncPolishingMirror_();
  const mirror = h.grids.get(h.context.APP.SHEETS.POLISHING);
  assert.deepEqual(mirror.find(row => row[0] === "CUSTOM").slice(15), [0, 2345.67]);
  assert.deepEqual(mirror.find(row => row[0] === "UNKNOWN").slice(15), ["", 1234]);
  assert.deepEqual(mirror.find(row => row[0] === "NORMAL").slice(15), ["", ""]);
});

test("failed mirror reports a warning and leaves a repair flag for locked recovery", () => {
  const seed = harness();
  const h = harness([fixture(seed.context, "A")]);
  h.context.ensurePolishingSheet_(h.context.getSpreadsheet_());
  h.mirrorState.fail = true;
  const response = h.context.savePolishingMovement(move("A", 1, 3, "s1"));
  assert.match(response.mirrorWarning, /更新できませんでした/);
  assert.equal(h.scriptProperties.get("POLISHING_MIRROR_REPAIR_REQUIRED"), "true");
  h.mirrorState.fail = false;
  h.context.repairPolishingMirrorIfNeeded_();
  assert.equal(h.scriptProperties.has("POLISHING_MIRROR_REPAIR_REQUIRED"), false);
  assert.equal(h.grids.get(h.context.APP.SHEETS.POLISHING)[1][0], "A");
  assert.ok(h.writes.some((write) => write.sheet === h.context.APP.SHEETS.JOBS && write.locked));
});
