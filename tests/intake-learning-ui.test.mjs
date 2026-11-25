import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [appSource, duplicateSource, learningSource, html] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/intake-duplicates.js", import.meta.url), "utf8"),
  readFile(new URL("../src/intake-learning.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.html", import.meta.url), "utf8"),
]);

function parsed(overrides = {}) {
  return {
    customer: "松井", product: "慈大式 彫骨器（強弯・上向） CK021", productCode: "CK021", category: "", quantity: 10,
    dueDate: "2026-08-26", serialNo: "26-1790-1", specLength: "", specShape: "強弯・上向", bladeWidth: "", note: "",
    _parseWarnings: ["数量の後ろの日付を納期、末尾の名称を得意先として読み取りました。原文と確認してください。"],
    ...overrides,
  };
}

function harness(document = { querySelector() { return null; }, querySelectorAll() { return []; } }) {
  const storage = new Map([["production-board-demo-v2", JSON.stringify({ jobs: [], intake: [], settings: {}, logs: [], localIntakeParserVersion: 2 })]]);
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL, crypto: webcrypto,
    structuredClone, window: {}, document,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    navigator: {}, setTimeout, clearTimeout,
    fetch: async (_path, options) => ({ ok: true, json: async () => ({
      engineVersion: 2, text: "fixture only", results: [{ parsed: parsed(), itemNumber: 1 }],
    }) }),
  });
  vm.runInContext(`${learningSource}\n${duplicateSource}\n${appSource.slice(0, appSource.indexOf("async function init()"))}
    globalThis.ui = { state, api, MockApi, intakeLearningFeedback, bulkIntakeDrafts, openBulkIntake, editBulkIntakeField, approveBulkIntake, updateIntakeLearningOptions, handleSelectedFile, uploadImage };`, context);
  context.delay = async () => {};
  return { api: context.ui.api, ui: context.ui, context };
}

test("single-item approval learns only opted-in final stable corrections and text import reapplies them", async () => {
  const { api, ui } = harness();
  const data = api.read();
  const item = { id: "I-1", sourceType: "text", sourceRef: "paste:I-1", status: "pending", parsed: parsed(), originalText: "fixture only" };
  data.intake.push(item);
  api.write(data);

  const job = await api.approveIntake({
    intakeId: item.id,
    order: parsed({ category: "鋭匙鉗子", specLength: "18cm", note: "共通注意" }),
    learnProduct: true,
    learnNote: true,
  });
  assert.match(job.importLearningNotice, /次回の取り込みに覚えました/);
  const rules = (await api.getIntakeLearningRules()).rules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].target.category, "鋭匙鉗子");
  assert.equal(rules[0].target.specLength, "18cm");
  assert.equal(rules[0].note, "共通注意");
  for (const key of ["quantity", "dueDate", "serialNo", "customer", "stages"]) assert.equal(Object.hasOwn(rules[0].target, key), false);

  const reimported = await api.createIntakeFromText({ name: "再取込", text: "fixture only" });
  const learned = reimported.items[0].parsed;
  assert.equal(learned.category, "鋭匙鉗子", JSON.stringify({ rules, learned }));
  assert.equal(learned.specLength, "18cm");
  assert.equal(learned.quantity, 10);
  assert.equal(learned.customer, "松井");
  assert.equal(learned.dueDate, "2026-08-26");
  assert.equal(learned._learning.status, "applied");
  assert.match(learned._learning.message, /共有済み/);
  const feedback = ui.intakeLearningFeedback(reimported.items[0]);
  assert.match(feedback, /数量の後ろの日付を納期/);
  assert.match(feedback, /大分類/);
  assert.match(feedback, /全長/);

  const forgotten = await api.forgetIntakeLearningRule({ key: rules[0].key, intakeId: rules[0].intakeId });
  assert.deepEqual(JSON.parse(JSON.stringify(forgotten.rules)), []);
  await assert.rejects(api.forgetIntakeLearningRule({ key: rules[0].key, intakeId: rules[0].intakeId }), /既に解除/);
});

test("unchecked product learning creates no rule even if note learning is requested", async () => {
  const { api } = harness();
  const data = api.read();
  const item = { id: "I-2", sourceType: "text", sourceRef: "paste:I-2", status: "pending", parsed: parsed({ product: "固有製品 99" }) };
  data.intake.push(item);
  api.write(data);
  await api.approveIntake({ intakeId: item.id, order: parsed({ product: "固有製品 99", category: "鋭匙鉗子", note: "共有メモ" }), learnProduct: false, learnNote: true });
  assert.deepEqual(JSON.parse(JSON.stringify((await api.getIntakeLearningRules()).rules)), []);
});

test("intake screens expose default opt-in, explicit note opt-in, provenance, and rule management", () => {
  assert.match(html, /name="learnProduct" checked/);
  assert.match(html, /id="bulk-intake-learn-product" checked/);
  assert.match(html, /name="learnNote"/);
  assert.match(html, /id="bulk-intake-learn-note" disabled/);
  assert.match(html, /id="intake-learning-feedback"/);
  assert.match(html, /data-action="open-intake-learning"/);
  assert.match(html, /id="intake-learning-dialog"/);
  assert.match(html, /src="intake-learning.js" defer data-inline="intake-learning"/);
});

function intakeDocument() {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      dataset: {}, querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, scrollIntoView() {},
    });
    return elements.get(selector);
  }
  const document = { querySelector: element, querySelectorAll: () => [] };
  return { document, element };
}

test("reopening bulk intake preserves learning choices and saves corrected product specifications", async () => {
  const { document, element } = intakeDocument();
  const { api, context, ui } = harness(document);
  const { state, bulkIntakeDrafts } = ui;
  state.access = { role: "editor" };
  Object.assign(context, {
    renderBulkIntake() {}, updateBulkIntakeSelection() {}, renderAll() {}, switchView() {}, announce() {},
    openDialog(dialog) { dialog.open = true; }, closeDialog(dialog) { dialog.open = false; },
  });
  function add(id, options) {
    const item = { id, status: "pending", sourceType: "text", sourceRef: id,
      parsed: parsed({ serialNo: id, product: "ケリソンパンチ18cm上向2mm", category: "ケリソンパンチ",
        specLength: "", specShape: "上向", bladeWidth: "2mm", ...options }) };
    const data = api.read();
    data.intake.push(item);
    api.write(data);
    state.intake.push(item);
  }
  const learn = element("#bulk-intake-learn-product");
  const note = element("#bulk-intake-learn-note");
  add("INTAKE-A", { _learning: { fields: ["specShape"] } });
  ui.openBulkIntake();
  const draft = bulkIntakeDrafts.get("INTAKE-A");
  ui.editBulkIntakeField(draft, "specLength", "22cm");
  ui.editBulkIntakeField(draft, "product", "鋭匙鉗子21cm下向4mm");
  learn.checked = false;
  ui.updateIntakeLearningOptions();
  context.closeDialog(element("#bulk-intake-dialog"));
  ui.openBulkIntake();
  assert.equal(learn.checked, false);
  assert.equal(note.disabled, true);
  await ui.approveBulkIntake({ preventDefault() {} });
  const [job] = api.read().jobs;
  assert.equal(job.product, "鋭匙鉗子21cm下向4mm");
  assert.equal(job.category, "鋭匙鉗子");
  assert.equal(job.bladeWidth, "4mm");
  assert.equal(job.specLength, "22cm");
  assert.equal(job.specShape, "上向");
  assert.equal((await api.getIntakeLearningRules()).rules.length, 0);
  add("INTAKE-B", { productCode: "OTHER-2" });
  ui.openBulkIntake();
  assert.equal(learn.checked, true);
  assert.equal(note.checked, false);
  note.checked = true;
  context.closeDialog(element("#bulk-intake-dialog"));
  ui.openBulkIntake();
  assert.equal(note.checked, true);
});

test("a delayed PDF read preserves the next selection, reports failures on the right file, and can retry", async () => {
  const { document, element } = intakeDocument();
  const { context, ui } = harness(document);
  ui.state.access = { role: "editor" };
  const calls = [];
  const notices = [];
  const views = [];
  let resolveRead, rejectRead;
  Object.assign(context, {
    createIntakeFromSelectedFile(file) {
      calls.push(file.name);
      return new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
    },
    refreshIntakeAfterImport: async () => {},
    switchView: view => views.push(view), showToast: message => notices.push(message),
    announce: message => notices.push(message), closeDialog(dialog) { dialog.open = false; },
  });
  const dialog = element("#import-dialog");
  const button = element("[data-action='upload-image']");
  const first = { name: "注文A.pdf", type: "application/pdf", size: 1000 };
  const next = { ...first, name: "注文B.pdf" };
  dialog.open = true;
  ui.handleSelectedFile(first);
  const pending = ui.uploadImage(button);
  ui.handleSelectedFile(next);
  assert.equal(button.disabled, true);
  await ui.uploadImage(button);
  assert.deepEqual(calls, [first.name]);
  resolveRead({ added: 2 });
  await pending;
  assert.equal(ui.state.selectedFile, next);
  assert.equal(button.disabled, false);
  assert.equal(dialog.open, true);
  assert.deepEqual(views, []);
  assert.match(notices[0], /注文A\.pdf.*2件/);
  const failed = ui.uploadImage(button);
  rejectRead(new Error("一時的な読取失敗"));
  await failed;
  assert.match(element("#file-import-error").textContent, /注文B\.pdf.*一時的な読取失敗/);
  assert.equal(ui.state.selectedFile, next);
  assert.equal(button.disabled, false);
  const retry = ui.uploadImage(button);
  resolveRead({ added: 0 });
  await retry;
  assert.deepEqual(calls, [first.name, next.name, next.name]);
  assert.match(notices.at(-1), /注文B\.pdf.*0件/);
  assert.deepEqual(views, ["intake"]);
  assert.equal(ui.state.selectedFile, null);
  assert.equal(element("#image-input").value, "");
  assert.equal(button.disabled, true);
});
