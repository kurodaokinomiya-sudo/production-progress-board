import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const directory = new URL("../apps-script/", import.meta.url);
const files = (await readdir(directory)).filter((name) => name.endsWith(".gs") && name !== "AccessControl.gs");
const source = (await Promise.all(files.map((name) => readFile(new URL(name, directory), "utf8")))).join("\n");
const publicFunctions = [...source.matchAll(/^function ([A-Za-z0-9]+)\(/gm)].map((match) => match[1]);
const denied = () => { throw new Error("ACCESS_DENIED: blocked before data access"); };

function harness() {
  const context = vm.createContext({ requireAppAccess_: denied, requireWorkerAccess_: denied, requireEditorAccess_: denied, requireAdminAccess_: denied, requireOwnerAccess_: denied });
  vm.runInContext(source, context);
  return context;
}

test("every data RPC rejects unauthenticated callers before accessing Google services", () => {
  const context = harness();
  for (const name of publicFunctions.filter((name) => name !== "doGet")) {
    assert.throws(() => context[name]({ email: "owner@example.com", isAdmin: true }), /ACCESS_DENIED:/, name);
  }
  assert.ok(publicFunctions.length >= 22);
});

test("collaborators cannot call admin operations or edit Gmail settings directly", () => {
  const context = harness();
  context.requireAppAccess_ = () => ({ email: "allowed@example.com", isAdmin: false });
  context.requireEditorAccess_ = denied;
  context.requireAdminAccess_ = () => { throw new Error("ADMIN_REQUIRED:"); };
  context.requireOwnerAccess_ = () => { throw new Error("OWNER_REQUIRED:"); };
  for (const name of ["setupSystem", "scanOrderEmails", "migrateLegacySheet", "runAiDiagnosticStep"]) {
    assert.throws(() => context[name]({ isAdmin: true }), /(ADMIN_REQUIRED|OWNER_REQUIRED):/, name);
  }
  for (const name of ["createIntakeFromImage", "createIntakeFromPdfText", "createIntakeFromText", "createIntakeWithAi", "saveJob", "markLabelsPrinted"]) {
    assert.throws(() => context[name]({}), /ACCESS_DENIED:/, name);
  }
  for (const input of [{ gmailQuery: "in:anywhere" }, { maxEmailThreads: "50" }]) {
    assert.throws(() => context.saveSettings(input), /ADMIN_REQUIRED:/);
  }
});

test("collaborator snapshots omit account administration, editor URL, and Gmail configuration", () => {
  const context = harness();
  Object.assign(context, {
    requireAppAccess_: () => ({ email: "allowed@example.com", isAdmin: false }),
    ensureSystem_: () => {}, readJobs_: () => [{ id: "shared-job" }], readIntake_: () => [],
    readSettings_: () => ({ gmailQuery: "private-query", maxEmailThreads: "20", distributionAssignees: "[]" }),
    getAiImportStatus: () => ({ ready: true }),
    getAccessSettings: () => { throw new Error("must not read administrator configuration"); },
  });
  const result = context.getSnapshot({});
  assert.equal(result.access.email, "allowed@example.com");
  assert.equal(result.accessSettings, null);
  assert.equal(result.scriptEditorUrl, "");
  assert.equal(result.settings.gmailQuery, undefined);
  assert.equal(result.settings.maxEmailThreads, undefined);
  assert.equal(result.settings.distributionAssignees, "[]");
  assert.equal(result.jobs[0].id, "shared-job");
});

test("viewers are denied every public data mutation RPC before Google services are used", () => {
  const context = harness();
  context.requireAppAccess_ = () => ({ email: "viewer@example.com", role: "viewer", isOwner: false, isAdmin: false, canEdit: false, directGoogleIdentity: true });
  context.requireEditorAccess_ = () => {
    if (!context.requireAppAccess_().canEdit) throw new Error("EDITOR_REQUIRED: read-only account");
  };
  context.requireWorkerAccess_ = () => {
    if (!context.requireAppAccess_().canWork) throw new Error("WORKER_REQUIRED: read-only account");
  };
  context.requireAdminAccess_ = () => { throw new Error("ADMIN_REQUIRED: read-only account"); };
  context.requireOwnerAccess_ = () => { throw new Error("OWNER_REQUIRED: read-only account"); };

  const editorMutations = [
    "createIntakeFromImage", "createIntakeFromPdfText", "createIntakeFromText", "createIntakeWithAi",
    "saveJob", "setJobArchived", "markLabelsPrinted",
    "approveIntake", "approveIntakes", "rejectIntake", "rejectIntakes", "savePolishingMovement", "savePolishingEventDate", "savePolishingProductRule"
  ];
  for (const name of editorMutations) assert.throws(() => context[name]({}), /EDITOR_REQUIRED:/, name);
  assert.throws(() => context.setDistributionAssignee({}), /WORKER_REQUIRED:/);
  assert.throws(() => context.saveJobProcess({}), /WORKER_REQUIRED:/);
  for (const name of ["saveSettings", "saveCustomerRules", "savePolishingRates"]) assert.throws(() => context[name]({}), /ADMIN_REQUIRED:/, name);
  for (const name of ["setupSystem", "scanOrderEmails", "migrateLegacySheet", "runAiDiagnosticStep"]) {
    assert.throws(() => context[name]({}), /OWNER_REQUIRED:/, name);
  }
});

test("workers cannot import or administer, but can use worker mutation entrypoints", () => {
  const context = harness();
  context.requireAppAccess_ = () => ({ email: "worker@example.com", role: "worker", isOwner: false, isAdmin: false, canEdit: false, canWork: true, directGoogleIdentity: true });
  context.requireWorkerAccess_ = () => context.requireAppAccess_();
  context.requireEditorAccess_ = () => { throw new Error("EDITOR_REQUIRED:"); };
  context.requireAdminAccess_ = () => { throw new Error("ADMIN_REQUIRED:"); };
  context.requireOwnerAccess_ = () => { throw new Error("OWNER_REQUIRED:"); };
  for (const name of ["createIntakeFromImage", "createIntakeFromPdfText", "createIntakeFromText", "createIntakeWithAi", "saveJob", "setJobArchived", "markLabelsPrinted", "approveIntake", "approveIntakes", "rejectIntake", "rejectIntakes", "getAiImportStatus", "getCustomerRules"]) {
    assert.throws(() => context[name]({}), /(EDITOR_REQUIRED|ADMIN_REQUIRED):/, name);
  }
  for (const name of ["savePolishingMovement", "savePolishingEventDate", "savePolishingProductRule"]) assert.throws(() => context[name]({}), /EDITOR_REQUIRED:/, `workers cannot call ${name}`);
  for (const name of ["saveSettings", "saveCustomerRules", "savePolishingRates"]) assert.throws(() => context[name]({}), /ADMIN_REQUIRED:/, name);
  assert.throws(() => context.setupSystem({}), /OWNER_REQUIRED:/);
});

test("editors can change polishing movements and product rules, while polishing rates remain admin-only", () => {
  const context = harness();
  context.requireAppAccess_ = () => ({ email: "editor@example.com", role: "editor", isOwner: false, isAdmin: false, canEdit: true, canWork: true, directGoogleIdentity: true });
  context.requireEditorAccess_ = () => context.requireAppAccess_();
  context.requireWorkerAccess_ = () => context.requireAppAccess_();
  context.requireAdminAccess_ = () => { throw new Error("ADMIN_REQUIRED: admin only"); };
  assert.throws(() => context.savePolishingMovement({}), /研磨更新の形式が不正/);
  assert.throws(() => context.savePolishingEventDate({}), /研磨日付の更新形式が不正/);
  assert.throws(() => context.savePolishingProductRule({}), /案件情報が不正/);
  assert.throws(() => context.savePolishingRates({}), /ADMIN_REQUIRED:/);
});

test("worker snapshot skips intake and AI settings reads", () => {
  const context = harness();
  Object.assign(context, {
    requireAppAccess_: () => ({ email: "worker@example.com", role: "worker", isOwner: false, isAdmin: false, canEdit: false, canWork: true }),
    ensureSystem_: () => {}, readJobs_: () => [], readIntake_: () => { throw new Error("intake must not be read"); },
    readSettings_: () => ({ stageAssignees: "{}", distributionAssignees: "[]", customerRules: "private" }),
    getAiImportStatus: () => { throw new Error("AI status must not be read"); },
    getAccessSettings: () => { throw new Error("admin settings must not be read"); },
  });
  const snapshot = context.getSnapshot({});
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.intake)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.aiImport)), { configured: false, ready: false, model: "" });
  assert.equal(snapshot.settings.stageAssignees, "{}");
  assert.equal(snapshot.settings.distributionAssignees, "[]");
  assert.equal(snapshot.settings.customerRules, undefined);
});

test("non-owner admin snapshots expose account settings but hide owner Gmail data and entrypoints", () => {
  const context = harness();
  context.requireAppAccess_ = () => ({ email: "admin@example.com", role: "admin", isOwner: false, isAdmin: true, canEdit: true, directGoogleIdentity: true });
  context.requireAdminAccess_ = () => context.requireAppAccess_();
  context.requireOwnerAccess_ = () => { throw new Error("OWNER_REQUIRED: owner only"); };
  Object.assign(context, {
    ensureSystem_: () => {},
    readJobs_: () => [],
    readIntake_: () => [],
    readSettings_: () => ({ gmailQuery: "private-query", maxEmailThreads: "20", syncIntervalSeconds: "20" }),
    getAiImportStatus: () => ({ ready: true }),
    getAccessSettings: () => ({ users: [{ email: "editor@example.com", role: "editor" }], version: 3, isAdmin: true }),
    ScriptApp: { getScriptId: () => "script-id" }
  });

  const result = context.getSnapshot({});
  assert.deepEqual(JSON.parse(JSON.stringify(result.accessSettings)), { users: [{ email: "editor@example.com", role: "editor" }], version: 3, isAdmin: true });
  assert.equal(result.settings.gmailQuery, undefined);
  assert.equal(result.settings.maxEmailThreads, undefined);
  assert.equal(result.settings.syncIntervalSeconds, "20");
  assert.equal(result.scriptEditorUrl, "");

  for (const input of [{ gmailQuery: "in:anywhere" }, { maxEmailThreads: "50" }]) {
    assert.throws(() => context.saveSettings(input), /OWNER_REQUIRED:/);
  }
  for (const name of ["setupSystem", "scanOrderEmails", "migrateLegacySheet", "runAiDiagnosticStep"]) {
    assert.throws(() => context[name]({}), /OWNER_REQUIRED:/, name);
  }
});

test("unauthenticated page requests render only the gate and verified users receive the application", () => {
  const context = harness();
  const rendered = [];
  const output = { setTitle() { return this; }, setXFrameOptionsMode() { return this; }, addMetaTag() { return this; } };
  const template = { evaluate: () => { rendered.push("gate:" + template.appUrl); return output; } };
  Object.assign(context, {
    readAccessContext_: () => null,
    ScriptApp: { getService: () => ({ getUrl: () => "https://script.google.com/macros/s/test/exec" }) },
    HtmlService: { XFrameOptionsMode: { DEFAULT: "default" },
      createTemplateFromFile: (name) => { assert.equal(name, "Access"); return template; },
      createHtmlOutputFromFile: (name) => { rendered.push(name); return output; },
    },
  });
  context.doGet();
  assert.deepEqual(rendered, ["gate:https://script.google.com/macros/s/test/exec"]);
  context.readAccessContext_ = () => ({ email: "allowed@example.com", isAdmin: false });
  context.doGet();
  assert.equal(rendered[1], "Index");
});

test("the release requires a Google login and retains owner execution", async () => {
  const manifest = JSON.parse(await readFile(new URL("appsscript.json", directory), "utf8"));
  assert.deepEqual(manifest.webapp, { executeAs: "USER_DEPLOYING", access: "ANYONE" });
  assert.ok(manifest.oauthScopes.includes("https://www.googleapis.com/auth/script.send_mail"));
  const page = await readFile(new URL("../dist/Access.html", import.meta.url), "utf8");
  assert.ok(page.indexOf('<input id="email"') < page.indexOf('const emailInput ='));
  assert.doesNotMatch(page, /data-inline=|minnanookinomiyaika|APP_ACCESS_/);
});
