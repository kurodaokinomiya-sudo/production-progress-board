import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const stageKeys = ["welding", "base", "grinding", "heat", "finish"];

function metrics(jobs) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ["2026-12-31T15:05:00Z"])); }
  }
  const context = vm.createContext({ window: { google: { script: { run: {} } } }, Date: FixedDate, jobs });
  return structuredClone(vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\ndashboardMetrics(jobs);`, context));
}

function atStage(key) {
  return Object.fromEntries(stageKeys.map((stage, index) => [
    stage, { status: index < stageKeys.indexOf(key) ? "done" : "not_started" },
  ]));
}

test("dashboard counts every active job once using the current stage and ledger quantities", () => {
  const returned = { sentQuantity: 4, returnedQuantity: 4 };
  const ready = { quantity: 4, stages: { finish: { status: "done" } }, polishing: returned };
  const result = metrics([
    { category: "ケリソンパンチ", stages: atStage("heat"), quantity: "6" },
    { category: "鋭匙鉗子", stages: atStage("heat"), quantity: 0 },
    { quantity: null },
    { quantity: 4, stages: atStage("finish"), polishing: returned },
    { ...ready, polishing: { sentQuantity: 4, returnedQuantity: 2 } },
    { ...ready, shippingStatus: "waiting" },
    { ...ready, shippingStatus: "shipped" },
    { ...ready, archived: true },
  ]);
  assert.deepEqual(result.active, { count: 5, quantity: 14, unknownQuantity: 1 });
  assert.deepEqual(result.shipping, { count: 1, quantity: 4, unknownQuantity: 0 });
  assert.deepEqual(result.pending, { count: 6, quantity: 18, unknownQuantity: 1 });
  assert.deepEqual(result.stages.map(({ key, count }) => [key, count]),
    [["welding", 1], ["base", 0], ["grinding", 0], ["heat", 2], ["finish", 1], ["polishing", 1]]);
  assert.equal(result.stages.find((stage) => stage.key === "welding").unknownQuantity, 1);
  assert.equal(result.stages.find((stage) => stage.key === "heat").quantity, 6);
});

test("deadline buckets use the Japanese business date and include ready jobs, unknown dates and both week boundaries", () => {
  const dueDates = ["2026-12-31", "2027-01-01", "2027-01-02", "2027-01-08", "2027-01-09", "", "2027-02-30"];
  const jobs = dueDates.map((dueDate) => ({ dueDate, quantity: 3 }));
  jobs.push({
    dueDate: "2027-01-01", quantity: 1, stages: { finish: { status: "done" } },
    polishing: { sentQuantity: 1, returnedQuantity: 1 },
  });
  const { deadlines } = metrics(jobs);
  assert.deepEqual(deadlines.map(({ key, count, quantity }) => [key, count, quantity]), [
    ["overdue", 1, 3], ["today", 2, 4], ["week", 2, 6], ["later", 1, 3], ["undated", 2, 6],
  ]);
});

test("empty dashboard retains the same ordered chart series with zero totals", () => {
  const { active, shipping, pending, stages, deadlines } = metrics([]);
  for (const total of [active, shipping, pending, ...stages, ...deadlines]) {
    assert.equal(total.count, 0);
    assert.equal(total.quantity, 0);
    assert.equal(total.unknownQuantity, 0);
  }
  assert.equal(stages.length, 6);
  assert.equal(deadlines.length, 5);
});
