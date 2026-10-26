import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const [config, parser, repository, client] = await Promise.all([
  ...["Config.gs", "Parser.gs", "Repository.gs"].map((name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8")),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
]);
const firstNow = "2026-10-19T03:00:00.000Z";
const secondNow = "2026-11-01T04:05:06.000Z";
const oldDate = "2024-05-06T01:02:03.000Z";
const forgedDate = "1999-01-01T00:00:00.000Z";
const stages = () => Object.fromEntries(["welding", "base", "grinding", "heat", "finish"].map((key) => [key, {
  status: key === "finish" ? "done" : "not_started", assignee: "",
}]));
const job = (overrides = {}) => ({
  id: "SHIPMENT-DATE", customer: "検証商事", product: "ケリソンパンチ", quantity: 8,
  dueDate: "", serialNo: "R-1", specLength: "", specShape: "", bladeWidth: "", category: "ケリソンパンチ",
  stages: stages(), shippingStatus: "shipped", completedAt: "", note: "before", priority: "normal", archived: false,
  sourceType: "legacy", sourceRef: "local-date-fixture", createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-02T00:00:00.000Z", version: 4, productCode: "", distributionAssignee: "",
  labelPrintStatus: "printed", labelPrintedAt: "2020-01-02T00:00:00.000Z", ...overrides,
});

function harness(initialJobs = [], initialRole = "editor") {
  let now = firstNow, role = initialRole, locked = false;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return Date.parse(now); }
  }
  const grid = [], writes = [], checks = [];
  const sheet = {
    getLastRow: () => grid.length,
    getRange: (row, column, rowCount = 1, columnCount = 1) => ({
      getValues: () => Array.from({ length: rowCount }, (_, r) => Array.from({ length: columnCount }, (_, c) => grid[row - 1 + r]?.[column - 1 + c] ?? "")),
      setValues: (values) => values.forEach((cells, r) => {
        grid[row - 1 + r] ||= [];
        cells.forEach((value, c) => { grid[row - 1 + r][column - 1 + c] = value; });
        writes.push({ locked });
      }),
    }),
  };
  const server = vm.createContext({
    Date: FixedDate, Math, Number, Object, RegExp, String,
    Utilities: { getUuid: () => "new-date-job" },
    SpreadsheetApp: { flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() { locked = true; }, releaseLock() { locked = false; } }) },
    requireEditorAccess_: () => { checks.push("editor"); if (!["owner", "admin", "editor"].includes(role)) throw new Error("EDITOR_REQUIRED"); },
    requireWorkerAccess_: () => { checks.push("worker"); if (!["owner", "admin", "editor", "worker"].includes(role)) throw new Error("WORKER_REQUIRED"); return { role, canWork: true, canEdit: ["owner", "admin", "editor"].includes(role) }; },
  });
  vm.runInContext(`${config}\n${parser}\n${repository}`, server);
  Object.assign(server, { ensureSystem_() {}, getSpreadsheet_: () => ({ getSheetByName: () => sheet }), appendLog_() {} });
  grid.push([...server.APP.JOB_HEADERS], ...initialJobs.map((entry) => server.jobToRow_(entry)));

  const storage = new Map([["production-board-demo-v2", JSON.stringify({ jobs: initialJobs, settings: {}, intake: [], localIntakeParserVersion: 999 })]]);
  const elements = new Map();
  const uiContext = vm.createContext({
    Date: FixedDate, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL, structuredClone,
    document: { querySelector: (selector) => { if (!elements.has(selector)) elements.set(selector, { textContent: "" }); return elements.get(selector); }, querySelectorAll: () => [] },
    window: {}, localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
  });
  vm.runInContext(`${client.slice(0, client.indexOf("async function init()"))}\nglobalThis.ui = { api, state, matchesCompletedPeriod, filteredJobs, shipmentDateLabel, ledgerTotalsText, renderMetrics };`, uiContext);
  uiContext.delay = async () => {};
  const ui = uiContext.ui;
  ui.state.access = { role: "owner", canEdit: true, canWork: true };
  return { server, ui, elements, writes, checks, grid,
    setNow(value) { now = value; }, setRole(value) { role = value; },
    storedJobs: () => server.readJobs_(),
  };
}

for (const completedAt of ["", oldDate, undefined]) {
  test(`ordinary save preserves existing shipped date ${JSON.stringify(completedAt)} and ignores a supplied date`, async () => {
    const existing = job({ completedAt });
    const h = harness([existing]);
    const payload = { ...existing, note: "note changed", completedAt: forgedDate };
    const saved = h.server.saveJob(payload);
    const local = await h.ui.api.saveJob(payload);
    assert.equal(saved.completedAt, completedAt || "");
    assert.equal(local.completedAt, saved.completedAt, "MockApi and server use the same shipment-date transition");
    assert.equal(h.storedJobs()[0].completedAt, saved.completedAt);
    assert.equal(saved.note, "note changed");
    assert.equal(saved.updatedAt, firstNow);
    assert.equal(saved.version, 5);
    assert.equal(h.writes[0].locked, true);
    assert.deepEqual(h.checks, ["editor"]);
    h.ui.state.jobs = [saved];
    h.ui.state.filters.completed.period = "undated";
    assert.equal(h.ui.filteredJobs("completed").length, completedAt ? 0 : 1);
    if (!completedAt) assert.equal(h.ui.ledgerTotalsText(h.ui.filteredJobs("completed")), "1件・8丁");
    assert.equal(h.ui.shipmentDateLabel(saved), completedAt ? "2024/05/06" : "未記録");
    h.ui.state.filters.completed.period = "2026-10";
    assert.equal(h.ui.filteredJobs("completed").length, 0);
    assert.equal(h.ui.matchesCompletedPeriod(saved, "current"), false);
    h.ui.renderMetrics();
    assert.equal(h.elements.get("#metric-done").textContent, "0", "ordinary edits never count as shipments this month");
  });
}

test("new shipment, reopening and reshipping use server time and match MockApi", async () => {
  // An old timestamp on a waiting row must not override the new shipment time.
  const existing = job({ shippingStatus: "waiting", completedAt: oldDate, polishing: { sentQuantity: 8, returnedQuantity: 8, history: [
    { requestId: "before-send", action: "send", quantity: 8, at: "2024-05-04T00:00:00.000Z" },
    { requestId: "before-return", action: "return", quantity: 8, at: "2024-05-05T00:00:00.000Z" },
  ] } });
  const h = harness([existing]);
  let previous = existing;
  for (const [shippingStatus, expected, now] of [
    ["shipped", firstNow, firstNow], ["waiting", "", firstNow], ["shipped", secondNow, secondNow],
  ]) {
    h.setNow(now);
    const payload = { ...previous, shippingStatus, completedAt: forgedDate };
    const saved = h.server.saveJob(payload);
    const local = await h.ui.api.saveJob(payload);
    assert.equal(saved.completedAt, expected);
    assert.equal(local.completedAt, expected);
    assert.equal(h.storedJobs()[0].completedAt, expected);
    assert.equal(saved.stages.welding.status, "not_started");
    previous = saved;
  }
  assert.ok(h.writes.every((write) => write.locked));
});

test("new shipped registration cannot bypass actual polishing return with a forged completion or date", async () => {
  const h = harness();
  const input = job({ id: "NEW-SHIPPED", version: 0, completedAt: forgedDate });
  assert.throws(() => h.server.saveJob(input), /研磨|全数/);
  await assert.rejects(h.ui.api.saveJob(input), /研磨|全数/);
  assert.equal(h.storedJobs().length, 0);
  assert.equal(h.writes.length, 0);
});

for (const completedAt of ["", oldDate]) {
  test(`editor process save preserves shipped date ${JSON.stringify(completedAt)} and protected cells`, async () => {
    const existing = job({ completedAt });
    const h = harness([existing], "editor");
    const before = [...h.grid[1]];
    const nextStages = { ...existing.stages, welding: { status: "working", assignee: "豊" } };
    const payload = { id: existing.id, version: 4, stages: nextStages, shippingStatus: "shipped" };
    const saved = h.server.saveJobProcess(payload);
    const local = await h.ui.api.saveJobProcess(payload);
    assert.equal(saved.completedAt, completedAt);
    assert.equal(local.completedAt, completedAt);
    assert.equal(h.storedJobs()[0].completedAt, completedAt);
    const changed = new Set(["weldingStatus", "weldingAssignee", "version", "updatedAt"]);
    h.server.APP.JOB_HEADERS.forEach((header, index) => {
      if (!changed.has(header)) assert.equal(h.grid[1][index], before[index], header);
    });
    assert.equal(h.writes[0].locked, true);
    assert.deepEqual(h.checks, ["worker"]);
    assert.throws(() => h.server.saveJobProcess({ ...payload, version: 5, completedAt: forgedDate }), /許可されていない項目/);
    assert.throws(() => h.server.saveJobProcess(payload), /別の端末/);
    h.setRole("worker");
    assert.throws(() => h.server.saveJobProcess({ ...payload, version: 5 }), /EDITOR_REQUIRED/);
    assert.throws(() => h.server.saveJob({ ...saved, note: "forged worker order edit" }), /EDITOR_REQUIRED/);
    h.setRole("viewer");
    assert.throws(() => h.server.saveJobProcess({ ...payload, version: 5 }), /WORKER_REQUIRED/);
    assert.equal(h.writes.length, 1, "denied and stale requests never persist");
  });
}
