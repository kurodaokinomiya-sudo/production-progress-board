import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

function harness() {
  const elements = new Map();
  const storage = new Map([["production-board-demo-v2", JSON.stringify({ jobs: [], settings: {}, intake: [], localIntakeParserVersion: 999 })]]);
  for (const id of ["completed-year", "completed-month"]) {
    const element = { id, value: "", innerHTML: "" };
    elements.set(`#${id}`, element);
  }
  const context = vm.createContext({
    Date, Intl, Math, Number, Object, RegExp, String, Array, Set, Map, JSON, URL,
    document: { querySelector: (selector) => elements.get(selector) || null, querySelectorAll: () => [] },
    window: {}, localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  });
  vm.runInContext(`${source.slice(0, source.indexOf("async function init()"))}\nglobalThis.ui = { state, todayIso, shipmentDateKey, shipmentDateLabel, completedPeriodLabel, matchesCompletedPeriod, renderCompletedPeriods, setCompletedPeriodFromControls, filteredJobs, orderTableHeader, orderTableRows };`, context);
  context.renderCompletedWorkspace = () => context.ui.renderCompletedPeriods();
  context.announce = () => {};
  context.ui.state.mode = "demo";
  context.ui.state.access = { role: "owner", canEdit: true, canWork: true };
  return { ui: context.ui, elements };
}

const shipped = (id, overrides = {}) => ({
  id, shippingStatus: "shipped", archived: false, completedAt: "2025-01-01T00:30:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z", stages: {}, ...overrides,
});

test("completed period matching uses Japan shipment date across year and month boundaries", () => {
  const { ui } = harness();
  const job = shipped("boundary", { completedAt: "2024-12-31T15:30:00.000Z" }); // 2025-01-01 00:30 in Japan.
  assert.equal(ui.shipmentDateKey(job), "2025-01-01");
  assert.equal(ui.shipmentDateLabel(job), "2025/01/01");
  assert.match(ui.shipmentDateLabel(job, true), /2025\/01\/01.*00:30/);
  assert.equal(ui.matchesCompletedPeriod(job, "2025"), true);
  assert.equal(ui.matchesCompletedPeriod(job, "2025-01"), true);
  assert.equal(ui.matchesCompletedPeriod(job, "2024-12"), false);
  assert.equal(ui.matchesCompletedPeriod(job, "current"), ui.todayIso().startsWith("2025-01"));
  assert.equal(ui.matchesCompletedPeriod(job, "all"), true);
  const february = shipped("month-boundary", { completedAt: "2025-01-31T15:00:00.000Z" });
  assert.equal(ui.shipmentDateKey(february), "2025-02-01");
  assert.equal(ui.matchesCompletedPeriod(february, "2025-02"), true);
  assert.equal(ui.matchesCompletedPeriod(february, "2025-01"), false);
});

test("older shipment date controls period and label even when updatedAt is newer", () => {
  const { ui } = harness();
  const job = shipped("old", { completedAt: "2022-06-10T03:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" });
  assert.equal(ui.matchesCompletedPeriod(job, "2022-06"), true);
  assert.equal(ui.matchesCompletedPeriod(job, "2026-10"), false);
  assert.match(ui.shipmentDateLabel(job), /2022/);
});

test("missing or invalid shipment timestamps are undated and never use updatedAt", () => {
  const { ui } = harness();
  for (const completedAt of ["", "not-a-date"]) {
    const job = shipped("undated", { completedAt, updatedAt: "2026-10-15T00:00:00.000Z" });
    ui.state.jobs = [job];
    assert.equal(ui.shipmentDateKey(job), "");
    assert.equal(ui.shipmentDateLabel(job), "未記録");
    assert.equal(ui.matchesCompletedPeriod(job, "undated"), true);
    assert.equal(ui.matchesCompletedPeriod(job, "all"), true);
    assert.equal(ui.matchesCompletedPeriod(job, "2026-10"), false);
    ui.state.filters.completed.period = "2026-10";
    assert.equal(ui.filteredJobs("completed").length, 0);
    ui.state.filters.completed.period = "undated";
    assert.equal(ui.filteredJobs("completed").length, 1);
  }
});

test("year and month selectors stay compact across many years and retain the selected month", () => {
  const { ui, elements } = harness();
  ui.state.jobs = Array.from({ length: 8 }, (_, index) => shipped(`historic-${index}`, { completedAt: `${2018 + index}-04-01T00:00:00.000Z` }));
  ui.state.filters.completed.period = "2021-04";
  ui.renderCompletedPeriods();
  const year = elements.get("#completed-year"), month = elements.get("#completed-month");
  assert.equal(year.value, "2021");
  assert.equal(month.value, "04");
  assert.equal(month.disabled, false);
  assert.match(year.innerHTML, /value="2021">2021年/);
  assert.equal((year.innerHTML.match(/value="2021"/g) || []).length, 1);
  assert.doesNotMatch(year.innerHTML, /<optgroup|value="2021-/);
  assert.equal((month.innerHTML.match(/<option /g) || []).length, 13);
  assert.match(month.innerHTML, /value="01">1月/);
  assert.match(month.innerHTML, /value="12">12月/);
});

test("independent year and month changes filter shipments and reset month for all years", () => {
  const { ui, elements } = harness();
  ui.state.jobs = [
    shipped("april", { completedAt: "2021-04-01T00:00:00Z" }),
    shipped("may", { completedAt: "2021-05-01T00:00:00Z" }),
    shipped("next-year", { completedAt: "2022-04-01T00:00:00Z" }),
    shipped("undated", { completedAt: "" }),
  ];
  const year = elements.get("#completed-year"), month = elements.get("#completed-month");
  year.value = "2021";
  month.value = "all";
  ui.setCompletedPeriodFromControls();
  assert.equal(ui.state.filters.completed.period, "2021");
  assert.equal(ui.filteredJobs("completed").length, 2);
  month.value = "04";
  ui.setCompletedPeriodFromControls();
  assert.equal(ui.state.filters.completed.period, "2021-04");
  assert.equal(ui.filteredJobs("completed")[0].id, "april");
  year.value = "2022";
  ui.setCompletedPeriodFromControls();
  assert.equal(ui.state.filters.completed.period, "2022-04");
  assert.equal(ui.filteredJobs("completed")[0].id, "next-year");
  year.value = "all";
  ui.setCompletedPeriodFromControls();
  assert.equal(ui.state.filters.completed.period, "all");
  assert.equal(ui.filteredJobs("completed").length, 4);
  assert.equal(month.value, "all");
  assert.equal(month.disabled, true);
  year.value = "undated";
  ui.setCompletedPeriodFromControls();
  assert.equal(ui.filteredJobs("completed")[0].id, "undated");
  assert.equal(month.disabled, true);
});

test("current-month shortcut synchronizes both selectors and an absent selected year is retained", () => {
  const { ui, elements } = harness();
  ui.state.filters.completed.period = "current";
  ui.renderCompletedPeriods();
  assert.equal(elements.get("#completed-year").value, ui.todayIso().slice(0, 4));
  assert.equal(elements.get("#completed-month").value, ui.todayIso().slice(5, 7));
  ui.state.filters.completed.period = "2001";
  ui.renderCompletedPeriods();
  assert.match(elements.get("#completed-year").innerHTML, /value="2001">2001年/);
  assert.equal(elements.get("#completed-month").value, "all");
  assert.equal(elements.get("#completed-month").disabled, false);
});

test("finished list date column appears in full and compact rows, but not progress-only view", () => {
  const { ui } = harness();
  const job = shipped("visible");
  for (const compact of [false, true]) {
    const header = ui.orderTableHeader({ completed: true, ledger: true, compact });
    const row = ui.orderTableRows([job], { completed: true, ledger: true, compact });
    assert.match(header, /出荷日/);
    assert.match(row, /class="cell-completed-date"/);
    assert.match(row, /<time datetime="2025-01-01T00:30:00\.000Z">/);
  }
  assert.doesNotMatch(ui.orderTableHeader({ completed: true, ledger: true, progressOnly: true }), /出荷日/);
  assert.doesNotMatch(ui.orderTableRows([job], { completed: true, ledger: true, progressOnly: true }), /cell-completed-date/);
  assert.match(ui.orderTableRows([job], { completed: true, ledger: true, progressOnly: true }), /class="ledger-shipped-date"[^>]*>出荷 2025\/01\/01<\/small>/);
});

test("finished note details use escaped view-order markup for readers and workers", () => {
  const { ui } = harness();
  const job = shipped("detail", { note: '<script>alert("x")</script>' });
  for (const role of ["viewer", "worker"]) {
    ui.state.access = { role, canEdit: false, canWork: role === "worker" };
    const row = ui.orderTableRows([job], { completed: true, ledger: true });
    assert.match(row, /data-action="view-order" data-order-id="detail"/);
    assert.match(row, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(row, /data-action="edit-order"/);
  }
});
