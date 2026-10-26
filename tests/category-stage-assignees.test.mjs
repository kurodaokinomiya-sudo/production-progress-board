import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

function harness(stageAssignees = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { hidden: false, dataset: {}, value: "", textContent: "", innerHTML: "" });
    return elements.get(selector);
  };
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL,
    document: { querySelector: element, querySelectorAll: () => [] },
    window: {}, localStorage: { getItem: () => JSON.stringify({ localIntakeParserVersion: 2, jobs: [], intake: [], settings: {} }), setItem() {} },
  });
  const exports = ["state", "configuredStageAssignees", "renderStageEditor", "renderStageAssigneeSettings"].join(", ");
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { ${exports} };`, context);
  context.ui.state.settings = { ...context.ui.state.settings, stageAssignees: JSON.stringify(stageAssignees) };
  return { ui: context.ui, element };
}

function rowMarkup(markup, stageKey) {
  return markup.match(new RegExp(`<div class="stage-edit-row[^>]*data-stage-key="${stageKey}"[\\s\\S]*?<\\/div>\\s*<\\/div>\\s*<\\/div>`, "i"))?.[0] || "";
}

const job = (category, heatAssignee = "") => ({
  id: `job-${category}`, category, product: "品目", shippingStatus: "not_ready", stages: {
    welding: { status: "not_started", assignee: "" },
    base: { status: "not_started", assignee: "" },
    grinding: { status: "not_started", assignee: "" },
    heat: { status: "working", assignee: heatAssignee },
    finish: { status: "not_started", assignee: "" },
  },
});

test("heatSharp inherits heat when absent, respects explicit empty, and defaults to all when neither key exists", () => {
  const inherited = harness({ heat: ["順", "鈴"] }).ui;
  assert.deepEqual(Array.from(inherited.configuredStageAssignees("heatSharp", "鋭匙鉗子")), ["鈴", "順"]);
  assert.deepEqual(Array.from(inherited.configuredStageAssignees("heatSharp")), ["鈴", "順"]);

  const emptySharp = harness({ heat: ["順", "鈴"], heatSharp: [] }).ui;
  assert.deepEqual(Array.from(emptySharp.configuredStageAssignees("heatSharp", "鋭匙鉗子")), []);
  assert.deepEqual(Array.from(emptySharp.configuredStageAssignees("heat", "ケリソンパンチ")), ["鈴", "順"]);

  const defaults = harness().ui;
  const all = Array.from(defaults.configuredStageAssignees("heat"));
  assert.ok(all.length > 0);
  assert.deepEqual(Array.from(defaults.configuredStageAssignees("heatSharp", "鋭匙鉗子")), all);
});

test("heat picker follows job category and retains an assigned hidden person only on that stage", () => {
  const { ui, element } = harness({
    welding: ["豊"], base: ["豊"], grinding: ["豊"],
    heat: ["鈴"], heatSharp: ["幹"], finish: ["豊"],
  });
  ui.renderStageEditor(job("鋭匙鉗子", "保"));
  let markup = element("#process-stage-editor").innerHTML;
  let heat = rowMarkup(markup, "heat");
  assert.match(heat, /data-assignee="幹"/);
  assert.match(heat, /data-assignee="保"[^>]*title="設定の候補外ですが、登録済みの担当者です"/);
  assert.doesNotMatch(rowMarkup(markup, "welding"), /data-assignee="保"/);

  ui.renderStageEditor(job("ケリソンパンチ", "望"));
  markup = element("#process-stage-editor").innerHTML;
  heat = rowMarkup(markup, "heat");
  assert.match(heat, /data-assignee="鈴"/);
  assert.match(heat, /data-assignee="望"[^>]*title="設定の候補外ですが、登録済みの担当者です"/);
  assert.doesNotMatch(heat, /data-assignee="幹"/);
});

test("bulk assignee intersection uses the current category's heat candidates", () => {
  const { ui, element } = harness({
    welding: ["豊", "幹", "鈴"], base: ["豊", "幹", "鈴"], grinding: ["豊", "幹", "鈴"],
    heat: ["豊", "鈴"], heatSharp: ["幹", "鈴"], finish: ["豊", "幹", "鈴"],
  });
  ui.renderStageEditor(job("鋭匙鉗子"));
  assert.deepEqual(Array.from(element("#process-form")._bulkAssignees), ["幹", "鈴"]);
  ui.renderStageEditor(job("ケリソンパンチ"));
  assert.deepEqual(Array.from(element("#process-form")._bulkAssignees), ["豊", "鈴"]);
});

test("settings render six independent stage groups with separate heat legends and keys", () => {
  const { ui, element } = harness({ heat: ["鈴"], heatSharp: ["幹"] });
  ui.renderStageAssigneeSettings();
  const container = element("#stage-assignee-settings");
  assert.equal((container.innerHTML.match(/class="stage-assignee-setting"/g) || []).length, 6);
  assert.match(container.innerHTML, /data-stage-key="heatSharp"[\s\S]*?<legend>頭付け・幅取り<\/legend>/);
  assert.match(container.innerHTML, /data-stage-key="heat"[\s\S]*?<legend>厚みとり<\/legend>/);
  assert.match(container.innerHTML, /data-stage-key="heatSharp"[\s\S]*?value="幹" checked/);
  assert.match(container.innerHTML, /data-stage-key="heat"[\s\S]*?value="鈴" checked/);
  assert.doesNotMatch(container.innerHTML, /頭付け・幅取り／厚みとり/);
});
