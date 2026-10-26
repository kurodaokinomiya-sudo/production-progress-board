import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const context = vm.createContext({
  Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL,
  window: {},
  localStorage: { getItem() { return JSON.stringify({ localIntakeParserVersion: 2, jobs: [], intake: [], settings: {} }); }, setItem() {} },
});
vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { stageForJob, stageFilterLabel, ledgerJobGroups, orderTableHeader, currentStage, state };`, context);
const { stageForJob, stageFilterLabel, ledgerJobGroups, orderTableHeader, currentStage } = context.ui;

test("ledger groups keep category order, preserve each input order, and retain unknown categories", () => {
  const jobs = [
    { id: "k1", category: "ケリソンパンチ" },
    { id: "s1", category: "鋭匙鉗子" },
    { id: "k2", category: "ケリソンパンチ" },
    { id: "unknown", category: "特注品" },
    { id: "blank", category: "" },
  ];
  const groups = JSON.parse(JSON.stringify(ledgerJobGroups(jobs)));
  assert.deepEqual(groups.map(([name]) => name), ["ケリソンパンチ", "鋭匙鉗子", "その他"]);
  assert.deepEqual(groups[0][1].map(({ id }) => id), ["k1", "k2"]);
  assert.deepEqual(groups[1][1].map(({ id }) => id), ["s1"]);
  assert.deepEqual(groups[2][1].map(({ id }) => id), ["unknown", "blank"]);
});

test("heat stage display name varies by category while saved key and values remain heat", () => {
  const heat = { key: "heat", label: "厚みとり", short: "厚" };
  const sharp = stageForJob(heat, { category: "鋭匙鉗子" });
  const kerrison = stageForJob(heat, { category: "ケリソンパンチ" });
  assert.equal(sharp.label, "頭付け・幅取り");
  assert.equal(sharp.key, "heat");
  assert.equal(kerrison.label, "厚みとり");
  assert.equal(stageFilterLabel(heat), "頭付け・幅取り／厚みとり");
  assert.equal(orderTableHeader({ category: "鋭匙鉗子" }).includes("頭付け・幅取り"), true);
  assert.equal(orderTableHeader({ category: "ケリソンパンチ" }).includes("厚みとり"), true);

  const job = { category: "鋭匙鉗子", stages: { welding: { status: "done" }, base: { status: "done" }, grinding: { status: "done" }, heat: { status: "working", assignee: "鈴" } } };
  const current = currentStage(job);
  assert.equal(current.key, "heat");
  assert.equal(current.label, "頭付け・幅取り");
  assert.equal(job.stages.heat.status, "working");
});
