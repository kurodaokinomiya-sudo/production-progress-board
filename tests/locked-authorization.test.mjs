import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { sheetsFixture } from "./helpers/sheets-fixture.mjs";

const extraFiles = [
  "src/materials.js", "src/finished-stock-orders.js", "src/finished-stock.js", "src/intake-learning.js", "src/intake-duplicates.js",
  "apps-script/Materials.gs", "apps-script/FinishedStock.gs", "apps-script/Polishing.gs",
  "apps-script/Code.gs", "apps-script/ProductMaster.gs", "apps-script/Import.gs", "apps-script/AiImport.gs",
  "apps-script/IntakeLearning.gs", "apps-script/AccessControl.gs",
];
const owner = "owner@example.invalid", actor = "queued@example.invalid";
const parsed = [{ parsed: { customer: "合成", product: "鋭匙鉗子", quantity: 3 }, confidence: 0.8 }];
const text = "得意先: 合成\n品名: 鋭匙鉗子\n数量: 3\n納期: 2026-11-30";

async function fixture(initialRole = "editor") {
  const h = await sheetsFixture(extraFiles), c = h.context;
  let activeEmail = initialRole === "owner" ? owner : actor, revision = 0, hook, acquired = 0, released = 0;
  c.Session.getActiveUser = () => ({ getEmail: () => activeEmail });
  c.Session.getEffectiveUser = () => ({ getEmail: () => owner });
  const role = value => {
    h.properties.set(c.ACCESS_CONFIG_KEY, JSON.stringify({ version: ++revision, users: value === "removed" || value === "owner" ? [] : [{ email: actor, role: value }] }));
  };
  role(initialRole);
  c.syncPolishingMirrorBestEffort_ = () => "";
  // Setup uses the same real access helpers; no real accounts or services run.
  if (initialRole === "worker") role("editor");
  const job = c.saveJob({ customer: "合成", product: "鋭匙鉗子", quantity: 3, requestId: "seed" });
  role(initialRole);
  const intake = c.appendIntake_({ sourceType: "text", sourceRef: "seed", parsed: parsed[0].parsed, confidence: 0.8, status: "pending" });
  c.Utilities.base64Decode = () => [];
  c.Utilities.newBlob = () => ({});
  c.ocrBlob_ = () => text;
  c.runAiImport_ = () => parsed;
  c.ScriptApp = { getScriptId: () => "synthetic-script" };
  const spreadsheet = c.getSpreadsheet_();
  spreadsheet.getId = () => "synthetic-spreadsheet"; spreadsheet.getName = () => "Synthetic";
  c.SpreadsheetApp.getActiveSpreadsheet = () => spreadsheet;
  c.GmailApp = { search: () => [] };
  c.LockService.getScriptLock = () => ({
    waitLock() {
      assert.equal(h.state.locked, false, "no nested lock acquisition");
      const run = hook; hook = null; run?.();
      h.state.locked = true; acquired += 1;
    },
    releaseLock() { assert.equal(h.state.locked, true); h.state.locked = false; released += 1; },
  });
  const beforeLock = callback => { hook = callback; };
  const grids = () => JSON.stringify([...h.grids]);
  return { ...h, c, job, intake, role, grids, beforeLock, counts: () => ({ acquired, released }), identity: email => { activeEmail = email; } };
}

const mutations = [
  ["saveJob", "editor", h => h.c.saveJob({ ...h.job, note: "queued", requestId: "queued-save" })],
  ["setJobArchived", "editor", h => h.c.setJobArchived({ id: h.job.id, version: h.job.version, archived: true })],
  ["saveJobProcess", "worker", h => h.c.saveJobProcess({ id: h.job.id, version: h.job.version, requestId: "queued-process", stages: { welding: { status: "done", assignee: "豊" } } })],
  ["setDistributionAssignee", "worker", h => h.c.setDistributionAssignee({ id: h.job.id, version: h.job.version, assignee: "豊" })],
  ["markLabelsPrinted", "editor", h => h.c.markLabelsPrinted({ jobs: [{ id: h.job.id, version: h.job.version }] })],
  ["approveIntake", "editor", h => h.c.approveIntake({ intakeId: h.intake.id, order: { customer: "合成", product: "鋭匙鉗子", quantity: 3 } })],
  ["approveIntakes", "editor", h => h.c.approveIntakes({ items: [{ intakeId: h.intake.id, order: { customer: "合成", product: "鋭匙鉗子", quantity: 3 } }] })],
  ["rejectIntake", "editor", h => h.c.rejectIntake({ intakeId: h.intake.id })],
  ["rejectIntakes", "editor", h => h.c.rejectIntakes({ intakeIds: [h.intake.id] })],
  ...["saveMaterialOrder", "receiveMaterialOrder", "adjustMaterialStock", "cancelMaterialOrder"].map(name => [name, "editor", h => h.c[name]({})]),
  ["getMaterialInventory (opening repair)", "editor", h => h.c.getMaterialInventory()],
  ...["receiveFinishedStock", "shipFinishedStock", "openFinishedStock", "reverseFinishedStock", "saveFinishedStockSchedule"].map(name => [name, "editor", h => h.c[name]({})]),
  ["getFinishedStock (fulfillment repair)", "editor", h => h.c.getFinishedStock()],
  ["savePolishingMovement", "editor", h => h.c.savePolishingMovement({ action: "send", requestId: "queued-polish", date: "2026-10-01", items: [{ id: h.job.id, version: h.job.version, quantity: 3 }] })],
  ["savePolishingEventDate", "editor", h => h.c.savePolishingEventDate({ id: h.job.id, version: h.job.version, eventRequestId: "send", requestId: "queued-date", date: "2026-10-01" })],
  ["saveSettings", "admin", h => h.c.saveSettings({ syncIntervalSeconds: "30" })],
  ["saveCustomerRules", "admin", h => h.c.saveCustomerRules({ expectedVersion: 0, rules: h.c.defaultCustomerRules_() })],
  ["savePolishingRates", "admin", h => h.c.savePolishingRates({ month: "2026-10", rates: {}, expectedRates: null })],
  ["savePolishingProductRule", "editor", h => h.c.savePolishingProductRule({ id: h.job.id, version: h.job.version, classCode: "A", expectedRule: null })],
  ["createIntakeFromText", "editor", h => h.c.createIntakeFromText({ text, engine: "legacy" })],
  ["createIntakeFromImage", "editor", h => h.c.createIntakeFromImage({ mimeType: "image/png", base64: "AQID" })],
  ["createIntakeFromPdfText", "editor", h => h.c.createIntakeFromPdfText({ mimeType: "application/pdf", text })],
  ["createIntakeWithAi", "editor", h => h.c.createIntakeWithAi({ text })],
  ["forgetIntakeLearningRule", "editor", h => h.c.forgetIntakeLearningRule({ key: "synthetic", intakeId: h.intake.id })],
];

for (const [name, minimumRole, invoke] of mutations) {
  for (const initialRole of minimumRole === "worker" ? ["worker", "editor"] : [minimumRole]) {
    for (const nextRole of ["viewer", "removed", ...(minimumRole === "worker" ? [] : ["worker"]), ...(minimumRole === "admin" ? ["editor"] : [])]) {
      test(`N03 ${name}: ${initialRole} -> ${nextRole} during lock wait writes no data or audit`, async () => {
        const h = await fixture(initialRole), before = h.grids(), writes = h.state.writes;
        h.beforeLock(() => h.role(nextRole));
        assert.throws(() => invoke(h), /ACCESS_DENIED|WORKER_REQUIRED|EDITOR_REQUIRED|ADMIN_REQUIRED/);
        assert.deepEqual(h.counts(), { acquired: 1, released: 1 }, "the denial occurs after acquiring and releases the lock");
        assert.equal(h.grids(), before, "jobs, inventory events and audit rows are unchanged");
        assert.equal(h.state.writes, writes);
      });
    }
  }
}

test("N03 editor -> worker uses the current scope for process saves and distribution", async () => {
  const h = await fixture(), c = h.c;
  h.beforeLock(() => h.role("worker"));
  assert.throws(() => c.saveJobProcess({ id: h.job.id, version: h.job.version, shippingStatus: "shipped", stages: {} }), /権限|編集/);
  assert.equal(c.readJobs_()[0].version, h.job.version);
  h.role("editor"); h.beforeLock(() => h.role("worker"));
  const saved = c.saveJobProcess({ id: h.job.id, version: h.job.version, requestId: "worker-process", stages: { welding: { status: "done", assignee: "豊" } } });
  assert.equal(saved.stages.welding.status, "done");
  assert.equal(saved.materials, undefined, "the response uses the worker's current visibility");
  const writes = h.state.writes;
  assert.equal(c.saveJobProcess({ id: h.job.id, version: h.job.version, requestId: "worker-process", stages: { welding: { status: "done", assignee: "豊" } } }).version, saved.version);
  assert.equal(h.state.writes, writes, "same request retry is idempotent");
  h.role("editor"); h.beforeLock(() => h.role("worker"));
  const assigned = c.setDistributionAssignee({ id: saved.id, version: saved.version, assignee: "豊" });
  assert.equal(assigned.distributionAssignee, "豊");
  assert.equal(assigned.materials, undefined);
  h.role("editor");
  const sent = c.savePolishingMovement({ action: "send", requestId: "ready-send", date: "2026-10-01", items: [{ id: assigned.id, version: assigned.version, quantity: 3 }] });
  const returned = c.savePolishingMovement({ action: "return", requestId: "ready-return", date: "2026-10-02", items: [{ id: assigned.id, version: sent.jobs[0].version, quantity: 3 }] });
  const ready = c.saveJob({ ...returned.jobs[0], requestId: "ready-finish", stages: { ...returned.jobs[0].stages, finish: { status: "done", assignee: "豊" } } });
  const beforeReady = h.grids();
  h.beforeLock(() => h.role("worker"));
  assert.throws(() => c.setDistributionAssignee({ id: ready.id, version: ready.version, assignee: "幹" }), /EDITOR_REQUIRED/);
  assert.equal(h.grids(), beforeReady, "an editor downgraded to worker cannot change a ready job's distribution");
});

test("N03 snapshot downgrade does not seed inventory or expose editor imports/settings", async () => {
  const h = await fixture(), c = h.c;
  c.getAiImportStatus = () => { throw new Error("restricted AI status was read"); };
  c.readSettings_ = () => ({ gmailQuery: "private", maxEmailThreads: "20", customerRules: "private", importSettings: "private" });
  h.beforeLock(() => h.role("worker"));
  const writes = h.state.writes, snapshot = c.getSnapshot();
  assert.equal(snapshot.access.role, "worker");
  assert.equal(snapshot.materialInventory, null);
  assert.equal(snapshot.intake.length, 0);
  assert.equal(snapshot.aiImport.configured, false);
  for (const key of ["gmailQuery", "maxEmailThreads", "customerRules", "importSettings"]) assert.equal(snapshot.settings[key], undefined);
  assert.equal(h.state.writes, writes);
});

for (const operation of ["saveSettings", "migrateLegacySheet", "scanOrderEmails", "appendIntakeIfNew_", "setupSystem"]) {
  test(`N03 owner boundary ${operation} rechecks direct identity inside the shared lock`, async () => {
    const h = await fixture("owner"), c = h.c, before = h.grids();
    h.role("admin");
    h.beforeLock(() => h.identity(actor));
    const calls = {
      saveSettings: () => c.saveSettings({ gmailQuery: "from:synthetic" }),
      migrateLegacySheet: () => c.migrateLegacySheet({ sheetName: "synthetic-source", dryRun: true }),
      scanOrderEmails: () => c.scanOrderEmails({}),
      appendIntakeIfNew_: () => c.appendIntakeIfNew_({ sourceRef: "gmail:synthetic", parsed: parsed[0].parsed }),
      setupSystem: () => c.setupSystem(),
    };
    assert.throws(calls[operation], /OWNER_REQUIRED/);
    assert.equal(h.grids(), before);
    assert.deepEqual(h.counts(), { acquired: 1, released: 1 });
  });
}

test("N03 owner setup repairs a pending derived mirror within its existing lock", async () => {
  const h = await fixture("owner"), c = h.c;
  const source = await readFile(new URL("../apps-script/Config.gs", import.meta.url), "utf8");
  const start = source.indexOf("function ensureSystem_("), next = source.indexOf("\nfunction ", start + 1);
  vm.runInContext(source.slice(start, next), c);
  c.ensureSheet_ = () => {}; c.ensurePolishingSheet_ = () => {}; c.ensureDefaultSettings_ = () => ({});
  h.properties.set(c.POLISHING_MIRROR_REPAIR_PROPERTY, "true");
  let repairs = 0;
  c.syncPolishingMirror_ = () => { assert.equal(h.state.locked, true); repairs += 1; };
  assert.equal(c.setupSystem().ok, true);
  assert.deepEqual(h.counts(), { acquired: 1, released: 1 }, "repair reuses the setup lock");
  assert.equal(repairs, 1);
  assert.equal(h.properties.has(c.POLISHING_MIRROR_REPAIR_PROPERTY), false);
});

test("N03 derived-mirror repair permits viewers but rechecks revocation after waiting", async () => {
  const h = await fixture("editor"), c = h.c;
  let repairs = 0;
  c.syncPolishingMirror_ = () => { assert.equal(h.state.locked, true); repairs += 1; };
  h.properties.set(c.POLISHING_MIRROR_REPAIR_PROPERTY, "true");
  h.beforeLock(() => h.role("viewer"));
  c.repairPolishingMirrorIfNeeded_();
  assert.equal(repairs, 1); assert.equal(h.properties.has(c.POLISHING_MIRROR_REPAIR_PROPERTY), false);
  h.properties.set(c.POLISHING_MIRROR_REPAIR_PROPERTY, "true");
  h.beforeLock(() => h.role("removed"));
  c.repairPolishingMirrorIfNeeded_();
  assert.equal(repairs, 1, "a revoked caller does not write the mirror");
  assert.equal(h.properties.get(c.POLISHING_MIRROR_REPAIR_PROPERTY), "true", "the repair remains pending");
  assert.deepEqual(h.counts(), { acquired: 2, released: 2 });
});

test("N03 refreshing a product master fetches outside the lock and publishes only after current admin access", async () => {
  const h = await fixture("admin"), c = h.c, cached = new Map();
  let reads = 0, publications = 0;
  c.CacheService = { getScriptCache: () => ({ get: key => cached.get(key) ?? null, put(key, value) { assert.equal(h.state.locked, true); publications += 1; cached.set(key, value); } }) };
  c.SpreadsheetApp.openById = () => {
    assert.equal(h.state.locked, false, "external master fetch stays outside the mutation lock"); reads += 1;
    return { getSheets: () => [{ getSheetId: () => c.PRODUCT_MASTER_SHEET_ID_, getLastRow: () => 4, getRange: (_row, col) => ({ getDisplayValues: () => col === 8 ? [["合成"]] : [["TEST", "鋭匙鉗子", "直", "3mm", "180", "材料"]] }) }] };
  };
  h.beforeLock(() => h.role("editor"));
  assert.throws(() => c.refreshProductMaster(), /ADMIN_REQUIRED/);
  assert.equal(reads, 1); assert.equal(publications, 0);
  h.role("admin");
  const refreshed = c.refreshProductMaster();
  assert.equal(refreshed.productMasterStatus.status, "live");
  assert.ok(publications > 0);
});

test("N03 AI quota mutation checks editor/owner inside the lock before any external request", async () => {
  for (const ownerOnly of [false, true]) {
    const h = await fixture(ownerOnly ? "owner" : "editor"), c = h.c;
    h.properties.set("GEMINI_API_KEY", "synthetic-not-a-real-key"); h.properties.set("AI_FREE_TIER_CONFIRMED", "true");
    let requests = 0;
    c.UrlFetchApp = { fetch() { requests += 1; throw new Error("external request should not run"); } };
    h.beforeLock(() => { if (ownerOnly) { h.role("editor"); h.identity(actor); } else h.role("viewer"); });
    assert.throws(() => ownerOnly ? c.runAiDiagnosticStep({ step: "connection" }) : c.sendAiRequest_({}, []), /OWNER_REQUIRED|EDITOR_REQUIRED/);
    assert.equal(h.properties.get("AI_IMPORT_USAGE"), undefined);
    assert.equal(requests, 0);
    assert.deepEqual(h.counts(), { acquired: 1, released: 1 });
  }
});

test("N03 current owner remains implicit and cannot be downgraded by allowlist edits", async () => {
  const h = await fixture("owner"), c = h.c;
  h.beforeLock(() => h.role("removed"));
  const settings = c.saveSettings({ syncIntervalSeconds: "30" });
  assert.equal(settings.syncIntervalSeconds, "30");
  assert.equal(c.requireOwnerAccess_().role, "owner");
});

test("N03 lock acquisition failures and writer exceptions do not leave a lock or write a denied update", async () => {
  const h = await fixture(), c = h.c, before = h.grids();
  c.LockService.getScriptLock = () => ({ waitLock() { throw new Error("lock timeout"); }, releaseLock() { throw new Error("must not release an unacquired lock"); } });
  assert.throws(() => c.saveJob({ ...h.job, requestId: "timeout" }), /lock timeout/);
  assert.equal(h.grids(), before); assert.equal(h.state.locked, false);
  let released = 0;
  c.LockService.getScriptLock = () => ({ waitLock() { h.state.locked = true; }, releaseLock() { h.state.locked = false; released += 1; } });
  assert.throws(() => c.saveJob({ ...h.job, version: 999, requestId: "conflict" }), /別の端末/);
  assert.equal(h.grids(), before); assert.equal(h.state.locked, false); assert.equal(released, 1);
});

// Keep the audited entry-point inventory alongside behavioral checks. Every
// mutation wrapper delegates to one of these protected callbacks; authentication
// and maintenance-read paths deliberately keep their distinct permission level.
test("N03 audited mutation families all recheck their required permission inside a shared-lock callback", async () => {
  const inventory = [
    ["Config.gs", "setupSystem", "requireOwnerAccess_"],
    ["Repository.gs", "saveJob", "requireEditorAccess_"], ["Repository.gs", "setJobArchived", "requireEditorAccess_"],
    ["Repository.gs", "saveJobProcess", "requireWorkerAccess_"], ["Repository.gs", "setDistributionAssignee", "requireWorkerAccess_"],
    ["Repository.gs", "markLabelsPrinted", "requireEditorAccess_"], ["Repository.gs", "appendIntakeIfNew_", "requireOwnerAccess_"],
    ["Repository.gs", "approveIntakes", "requireEditorAccess_"], ["Repository.gs", "rejectIntakes", "requireEditorAccess_"],
    ["FinishedStock.gs", "getFinishedStock", "requireEditorAccess_"], ["FinishedStock.gs", "mutateFinishedStock_", "requireEditorAccess_"],
    ["Materials.gs", "getMaterialInventory", "requireEditorAccess_"], ["Materials.gs", "mutateMaterials_", "requireEditorAccess_"],
    ["Polishing.gs", "savePolishingMovement", "requireEditorAccess_"], ["Polishing.gs", "savePolishingEventDate", "requireEditorAccess_"],
    ["Code.gs", "saveSettings", "requireAdminAccess_"], ["Code.gs", "saveCustomerRules", "requireAdminAccess_"],
    ["ProductMaster.gs", "refreshProductMaster", "requireAdminAccess_"], ["ProductMaster.gs", "savePolishingRates", "requireAdminAccess_"],
    ["ProductMaster.gs", "savePolishingProductRule", "requireEditorAccess_"], ["Import.gs", "saveParsedIntake_", "requireEditorAccess_"],
    ["Import.gs", "migrateLegacySheet", "requireOwnerAccess_"], ["IntakeLearning.gs", "forgetIntakeLearningRule", "requireEditorAccess_"],
  ];
  for (const [file, name, permission] of inventory) {
    const source = await readFile(new URL(`../apps-script/${file}`, import.meta.url), "utf8");
    const start = source.indexOf(`function ${name}(`), next = source.indexOf("\nfunction ", start + 1);
    const body = source.slice(start, next < 0 ? undefined : next);
    assert.match(body, new RegExp(`with(?:Document|CustomerRules)Lock_\\(function\\s*\\(\\)\\s*\\{\\s*(?:access\\s*=\\s*)?${permission}\\(\\)`), `${file}:${name} must acquire fresh access at its protected boundary`);
  }
});
