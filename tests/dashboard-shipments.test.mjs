import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const storage = new Map();
const context = vm.createContext({
  Date, Intl, URL,
  window: {},
  document: { querySelector: () => null, querySelectorAll: () => [] },
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
});
vm.runInContext(source.slice(0, source.indexOf("async function init()")), context);
const { dashboardShipments } = context;
const shipped = (completedAt, quantity, fields = {}) => ({ completedAt, quantity, shippingStatus: "shipped", ...fields });

test("the six shipment months span years, include empty months, and use Japan dates through today", () => {
  const rows = Array.from(dashboardShipments([
    shipped("2025-07-31T14:59:59Z", 123),
    shipped("2025-07-31T15:00:00Z", 3),
    shipped("2025-12-31T14:59:59Z", 7),
    shipped("2025-12-31T15:00:00Z", "11"),
    shipped("2026-01-04T14:59:59Z", 13),
    shipped("2026-01-04T15:00:00Z", 123),
  ], "2026-01-04"), row => [row.key, row.label, row.count, row.quantity]);
  assert.deepEqual(rows, [
    ["2025-08", "8月", 1, 3], ["2025-09", "9月", 0, 0], ["2025-10", "10月", 0, 0],
    ["2025-11", "11月", 0, 0], ["2025-12", "12月", 1, 7], ["2026-01", "1月", 2, 24],
  ]);
});

test("counts completed jobs including fulfilled stock orders and retains unknown quantities", () => {
  const date = "2026-02-05";
  const rows = dashboardShipments([
    shipped(date, 9, { completionKind: "stock_fulfillment" }),
    shipped(date, ""), shipped(date, 0),
    shipped(date, 100, { archived: true }), shipped(date, 100, { shippingStatus: "waiting" }),
    shipped("", 100, { updatedAt: date }), shipped("invalid", 100, { updatedAt: date }),
  ], date);
  assert.deepEqual({ ...rows.at(-1) }, { key: "2026-02", label: "2月", count: 3, quantity: 9, unknownQuantity: 1 });
  assert.equal(rows.reduce((sum, row) => sum + row.count, 0), 3);
});
