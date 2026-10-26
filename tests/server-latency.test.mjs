import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all(["Config.gs", "Parser.gs", "Repository.gs", "Polishing.gs", "Code.gs"].map(
  name => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8"),
));
const timestamp = "2026-10-15T00:00:00.000Z";

function harness() {
  const grids = new Map();
  const calls = { opens: 0, propertyReads: 0, reads: [], writes: [], clears: [], decorated: [], logs: [] };
  const state = { role: "owner", onLock: null, mirrorFailure: false };
  const properties = new Map([["SPREADSHEET_ID", "current-book"]]);
  const lock = {
    held: false,
    waitLock() { this.held = true; state.onLock?.(); },
    releaseLock() { this.held = false; },
  };
  const sheet = name => {
    if (!grids.has(name)) return null;
    const grid = grids.get(name);
    return {
      getLastRow: () => grid.length,
      getLastColumn: () => Math.max(0, ...grid.map(row => row.length)),
      getRange(row, column, height = 1, width = 1) {
        const values = () => Array.from({ length: height }, (_, r) =>
          Array.from({ length: width }, (_, c) => grid[row + r - 1]?.[column + c - 1] ?? ""));
        const range = {
          getValues() {
            calls.reads.push({ name, row, height, mode: "values", locked: lock.held });
            return values();
          },
          getDisplayValues() {
            calls.reads.push({ name, row, height, mode: "display", locked: lock.held });
            return values().map(cells => cells.map(value => String(value)));
          },
          setValues(rows) {
            if (name === "工程管理_研磨" && row > 1 && state.mirrorFailure) throw new Error("mirror unavailable");
            calls.writes.push({ name, row, height: rows.length, locked: lock.held });
            rows.forEach((cells, r) => {
              grid[row + r - 1] ||= [];
              cells.forEach((value, c) => { grid[row + r - 1][column + c - 1] = value; });
            });
          },
          clearContent() {
            calls.clears.push({ name, row, height, locked: lock.held });
            for (let r = 0; r < height; r += 1) for (let c = 0; c < width; c += 1) {
              if (grid[row + r - 1]) grid[row + r - 1][column + c - 1] = "";
            }
          },
          setFontWeight() { return range; }, setBackground() { return range; }, setFontColor() { return range; },
        };
        return range;
      },
      setFrozenRows() {}, autoResizeColumns() {},
    };
  };
  const spreadsheet = {
    getId: () => "current-book",
    getSheetByName: sheet,
    insertSheet(name) { grids.set(name, []); return sheet(name); },
  };
  const access = () => ({ role: state.role, isOwner: state.role === "owner", isAdmin: state.role === "owner",
    canEdit: ["owner", "editor"].includes(state.role), canWork: ["owner", "editor", "worker"].includes(state.role) });
  const requireRole = key => {
    const context = access();
    if (state.role === "unauthenticated" || key && !context[key]) throw new Error("ACCESS_DENIED");
    return context;
  };
  const context = vm.createContext({
    Date, Math, Number, Object, RegExp, String, Array, JSON, Error,
    requireAppAccess_: () => requireRole(), requireEditorAccess_: () => requireRole("canEdit"),
    requireWorkerAccess_: () => requireRole("canWork"), requireOwnerAccess_: () => requireRole("isOwner"),
    requireAdminAccess_: () => requireRole("isAdmin"), getAccessSettings: () => ({}), getAiImportStatus: () => ({}),
    ScriptApp: { getScriptId: () => "current-script" },
    SpreadsheetApp: { openById(id) { assert.equal(id, "current-book"); calls.opens += 1; return spreadsheet; }, flush() {} },
    LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) { calls.propertyReads += 1; return properties.get(key) ?? null; },
      setProperty: (key, value) => properties.set(key, value),
      deleteProperty: key => properties.delete(key),
    }) },
    Utilities: { getUuid: () => "new-job", formatDate: date => new Date(date).toISOString().slice(0, 10) },
  });
  vm.runInContext(sources.join("\n"), context);
  const app = context.APP;
  for (const [name, headers] of [
    [app.SHEETS.JOBS, app.JOB_HEADERS], [app.SHEETS.SETTINGS, app.SETTING_HEADERS],
    [app.SHEETS.INTAKE, app.INTAKE_HEADERS], [app.SHEETS.LOG, app.LOG_HEADERS],
    [app.SHEETS.LEARNING, app.LEARNING_HEADERS], [app.SHEETS.POLISHING, context.POLISHING_HEADERS],
  ]) grids.set(name, [[...headers]]);
  grids.get(app.SHEETS.SETTINGS).push(...Object.entries(app.DEFAULTS).map(([key, value]) => [key, value, ""]));
  context.appendLog_ = (...entry) => { calls.logs.push({ entry, locked: lock.held }); };
  context.decorateProductJobs_ = jobs => {
    calls.decorated.push(jobs.map(job => job.id));
    return jobs.map(job => Object.assign(job, { productMaster: { classCode: "A", material: "試験材料" } }));
  };
  const job = (id, extra = {}) => ({
    id, customer: "テスト", product: "鋭匙鉗子", productCode: "P-1", dueDate: "2026-11-01", quantity: 10,
    specLength: "", specShape: "", bladeWidth: "", serialNo: id, category: "鋭匙鉗子",
    stages: Object.fromEntries(app.STAGES.map(key => [key, { status: "working", assignee: "望" }])),
    shippingStatus: "waiting", note: "", sourceType: "manual", sourceRef: "", priority: "normal", archived: false,
    createdAt: timestamp, updatedAt: timestamp, version: 1, completedAt: "", labelPrintStatus: "printed",
    labelPrintedAt: timestamp, distributionAssignee: "", polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] },
    ...extra,
  });
  const seed = jobs => grids.set(app.SHEETS.JOBS, [[...app.JOB_HEADERS], ...jobs.map(item => context.jobToRow_(item))]);
  const dataReads = name => calls.reads.filter(call => call.name === name && call.row > 1);
  const reset = () => {
    for (const name of ["reads", "writes", "clears", "decorated", "logs"]) calls[name].length = 0;
  };
  return { context, app, grids, calls, state, properties, lock, job, seed, dataReads, reset };
}

function returnedPolishing(quantity = 10) {
  return { sentQuantity: quantity, returnedQuantity: quantity, history: [
    { requestId: "sent", action: "send", quantity, at: timestamp },
    { requestId: "returned", action: "return", quantity, at: timestamp },
  ] };
}

test("startup reads settings once and shares only the workbook handle, while later reads see changed sheet data", () => {
  const h = harness();
  h.state.role = "worker";
  h.seed([h.job("A")]);
  const settingsGrid = h.grids.get(h.app.SHEETS.SETTINGS);
  settingsGrid.push(["customerRules", "private", ""], ["importSettings", "private", ""]);
  const snapshot = h.context.getSnapshot({});
  assert.equal(snapshot.jobs[0].version, 1);
  assert.equal(h.dataReads(h.app.SHEETS.SETTINGS).length, 1);
  assert.equal(h.dataReads(h.app.SHEETS.JOBS).length, 1);
  assert.equal(h.calls.opens, 1);
  assert.equal(snapshot.settings.gmailQuery, undefined);
  assert.equal(snapshot.settings.customerRules, undefined);
  assert.equal(snapshot.settings.importSettings, undefined);

  // No row cache: another request/reader using the same handle sees live cells.
  h.grids.get(h.app.SHEETS.JOBS)[1][h.app.JOB_HEADERS.indexOf("version")] = 7;
  settingsGrid.find(row => row[0] === "syncIntervalSeconds")[1] = "60";
  h.reset();
  const fresh = h.context.getSnapshot({});
  assert.equal(fresh.jobs[0].version, 7);
  assert.equal(fresh.settings.syncIntervalSeconds, "60");
  assert.equal(h.dataReads(h.app.SHEETS.SETTINGS).length, 1);
  assert.equal(h.dataReads(h.app.SHEETS.JOBS).length, 1);
});

test("startup includes newly initialized defaults without rereading settings", () => {
  const h = harness();
  h.grids.set(h.app.SHEETS.SETTINGS, [[...h.app.SETTING_HEADERS], ["custom", "kept", ""]]);
  const snapshot = h.context.getSnapshot({});
  assert.equal(snapshot.settings.syncIntervalSeconds, "20");
  assert.equal(snapshot.settings.custom, "kept");
  assert.equal(h.dataReads(h.app.SHEETS.SETTINGS).length, 1);
  assert.equal(h.grids.get(h.app.SHEETS.SETTINGS).filter(row => row[0] === "syncIntervalSeconds").length, 1);
});

test("process saves read canonical rows once under the lock and skip unrelated polishing rewrites", () => {
  const h = harness();
  const original = h.job("A", { polishing: returnedPolishing() });
  h.seed([original, h.job("B")]);
  h.context.syncPolishingMirror_();
  h.reset();
  const result = h.context.saveJobProcess({ id: "A", version: 1, stages: { welding: { status: "done", assignee: "豊" } } });
  assert.equal(result.version, 2);
  assert.equal(result.stages.welding.status, "done");
  assert.equal(h.dataReads(h.app.SHEETS.JOBS).length, 1, "no second full read or raw-row read");
  assert.ok(h.dataReads(h.app.SHEETS.JOBS).every(call => call.locked));
  assert.equal(h.calls.writes.filter(call => call.name === h.app.SHEETS.POLISHING).length, 0);
  assert.equal(h.calls.clears.length, 0);
  assert.equal(h.calls.logs.length, 1);
  assert.ok(h.calls.logs.every(call => call.locked));

  // A later update must reread the row, including edits arriving before lock acquisition.
  h.reset();
  h.state.onLock = () => { h.grids.get(h.app.SHEETS.JOBS)[1][h.app.JOB_HEADERS.indexOf("version")] = 3; };
  assert.throws(() => h.context.saveJobProcess({ id: "A", version: 2, stages: { welding: { status: "done", assignee: "豊" } } }), /別の端末/);
  assert.equal(h.dataReads(h.app.SHEETS.JOBS).length, 1);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.lock.held, false);
});

test("finish saves update the polishing mirror from committed rows without a reread or a full clear", () => {
  const h = harness();
  h.seed([h.job("A", { polishing: returnedPolishing() }), h.job("B")]);
  h.context.syncPolishingMirror_();
  h.reset();
  h.context.saveJobProcess({ id: "A", version: 1, stages: { finish: { status: "done", assignee: "豊" } } });
  assert.equal(h.dataReads(h.app.SHEETS.JOBS).length, 1);
  assert.equal(h.grids.get(h.app.SHEETS.POLISHING)[1][9], "完了");
  assert.equal(h.calls.writes.filter(call => call.name === h.app.SHEETS.POLISHING).length, 1);
  assert.equal(h.calls.clears.length, 0);
  assert.ok(h.calls.decorated.every(ids => !ids.includes("B")), "only polishing jobs and the response need master matching");
});

test("polishing movement reads jobs once and uses the new quantities for both response and mirror", () => {
  const h = harness();
  h.seed([h.job("A"), h.job("B", { polishing: returnedPolishing() }), h.job("C")]);
  const result = h.context.savePolishingMovement({ requestId: "send-A", action: "send", items: [{ id: "A", version: 1, quantity: 4 }] });
  assert.equal(result.jobs[0].polishing.sentQuantity, 4);
  assert.equal(h.dataReads(h.app.SHEETS.JOBS).length, 1);
  assert.ok(h.dataReads(h.app.SHEETS.JOBS).every(call => call.locked));
  assert.equal(h.dataReads(h.app.SHEETS.SETTINGS).length, 2, "initialization and the fresh locked settings read are shared with mirror/response");
  const mirror = h.grids.get(h.app.SHEETS.POLISHING);
  assert.equal(mirror.find(row => row[0] === "A")[6], 4);
  assert.equal(mirror.find(row => row[0] === "B")[7], 10);
  assert.equal(mirror.some(row => row[0] === "C"), false);
  assert.equal(h.calls.clears.length, 0);
  assert.ok(h.calls.writes.filter(call => call.row > 1).every(call => call.locked));
  assert.equal(h.calls.logs.length, 1);

  h.reset();
  const retry = h.context.savePolishingMovement({ requestId: "send-A", action: "send", items: [{ id: "A", version: 1, quantity: 4 }] });
  assert.equal(retry.jobs[0].version, 2);
  assert.equal(h.calls.writes.filter(call => call.name === h.app.SHEETS.JOBS).length, 0);
  assert.equal(h.calls.logs.length, 0);
  assert.equal(h.dataReads(h.app.SHEETS.JOBS).length, 1);
});

test("archive skips an unrelated mirror but removes returned jobs and clears only the old tail", () => {
  const h = harness();
  h.seed([h.job("A", { polishing: returnedPolishing() }), h.job("B", { polishing: returnedPolishing() }), h.job("C")]);
  h.context.syncPolishingMirror_();
  h.reset();
  h.context.setJobArchived({ id: "C", version: 1, archived: true });
  assert.equal(h.dataReads(h.app.SHEETS.JOBS).length, 1);
  assert.equal(h.calls.writes.filter(call => call.name === h.app.SHEETS.POLISHING).length, 0);

  h.reset();
  h.context.setJobArchived({ id: "A", version: 1, archived: true });
  assert.equal(h.dataReads(h.app.SHEETS.JOBS).length, 1);
  assert.equal(h.grids.get(h.app.SHEETS.POLISHING)[1][0], "B");
  assert.equal(h.grids.get(h.app.SHEETS.POLISHING)[2][0], "");
  assert.deepEqual(h.calls.clears.map(({ row, height }) => ({ row, height })), [{ row: 3, height: 1 }]);
  assert.ok(h.calls.clears.every(call => call.locked));
});

test("failed mirror writes preserve the previous readable rows and retain repair recovery", () => {
  const h = harness();
  h.seed([h.job("A", { polishing: returnedPolishing() })]);
  h.context.syncPolishingMirror_();
  const before = [...h.grids.get(h.app.SHEETS.POLISHING)[1]];
  h.reset();
  h.state.mirrorFailure = true;
  h.context.saveJobProcess({ id: "A", version: 1, stages: { finish: { status: "done", assignee: "豊" } } });
  assert.deepEqual(h.grids.get(h.app.SHEETS.POLISHING)[1], before);
  assert.equal(h.calls.clears.length, 0);
  assert.equal(h.properties.get(h.context.POLISHING_MIRROR_REPAIR_PROPERTY), "true");
  h.state.mirrorFailure = false;
  h.context.repairPolishingMirrorIfNeeded_();
  assert.equal(h.grids.get(h.app.SHEETS.POLISHING)[1][9], "完了");
  assert.equal(h.properties.has(h.context.POLISHING_MIRROR_REPAIR_PROPERTY), false);
});
