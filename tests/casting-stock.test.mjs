import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import "../src/casting-stock.js";

const CastingStock = globalThis.CastingStock;
const metadata = { createdAt: "2026-11-25T03:00:00.000Z", actor: "editor@example.com" };
const source = {
  sourceUrl: "https://docs.google.com/spreadsheets/d/test-source/edit",
  sourceRevision: "source-revision-1",
  items: [
    { id: "sample", name: "鋳物A", variants: [
      { id: "raw", label: "未加工", threshold: 10 },
      { id: "processed", label: "加工済", threshold: 3 },
      { id: "colored", label: "色付き（加工済）", threshold: 2 },
      { id: "unclassified", label: "区分未確認", threshold: null },
    ] },
    { id: "new-sample", name: "鋳物B", openingUnconfirmed: true, variants: [{ id: "single", label: "未加工のまま使用", threshold: null }] },
  ],
  stock: [
    { partId: "sample", variant: "raw", location: "1F", quantity: 10 },
    { partId: "sample", variant: "unclassified", location: "1F", quantity: 8 },
  ],
};
const seed = { ...source, initializedAt: metadata.createdAt };
const operation = (type, id, options = {}) => ({ opId: `event-${id}-fixture`, type, date: "2026-11-25", partId: "sample", variant: "raw", location: "1F", quantity: 1, ...options });
const stockAt = (snapshot, variant, location = "1F", partId = "sample") => snapshot.stock.find(row => row.partId === partId && row.variant === variant && row.location === location)?.quantity ?? 0;

function ledger() {
  const events = [];
  return {
    events,
    save(input) {
      const { event, snapshot } = CastingStock.apply(seed, events, input, metadata);
      if (event) events.push(event);
      return snapshot;
    },
    snapshot: () => CastingStock.project(seed, events),
  };
}

test("one classification or processing record applies and reverses both sides", () => {
  const { save, events, snapshot } = ledger();
  const classify = operation("classify", "classify", { variant: "unclassified", toVariant: "raw", quantity: 3 });
  const classified = save(classify);
  assert.equal(stockAt(classified, "unclassified"), 5);
  assert.equal(stockAt(classified, "raw"), 13);

  const process = operation("process", "process", { toVariant: "colored", toLocation: "保土田", quantity: 4 });
  const processed = save(process);
  assert.deepEqual(processed.history[0].changes, [
    { variant: "raw", location: "1F", before: 13, after: 9 },
    { variant: "colored", location: "保土田", before: 0, after: 4 },
  ]);
  assert.equal(events.length, 2);
  assert.equal(processed.history[1].canReverse, false);
  assert.throws(() => save(operation("reverse", "early", { targetId: classify.opId })), /新しい記録/);
  assert.throws(() => save(operation("process", "too-many", { toVariant: "processed", toLocation: "2F", quantity: 10 })), /在庫が不足/);
  assert.throws(() => save(operation("sell", "processed-sale", { variant: "colored", location: "保土田" })), /販売は未加工/);
  assert.equal(events.length, 2);
  assert.deepEqual(snapshot(), processed);

  const restored = save(operation("reverse", "reverse-process", { targetId: process.opId }));
  assert.equal(stockAt(restored, "raw"), 13);
  assert.equal(stockAt(restored, "colored", "保土田"), 0);
  assert.equal(restored.history[1].reversed, true);
  assert.equal(restored.history[2].canReverse, true);
  const initial = save(operation("reverse", "reverse-classify", { targetId: classify.opId }));
  assert.equal(stockAt(initial, "raw"), 10);
  assert.equal(stockAt(initial, "unclassified"), 8);
});

test("receipts preserve outstanding quantities and retries do not add units", () => {
  const { save, events } = ledger();
  const order = operation("order", "open-order", { quantity: 20, dueDate: "2026-12-01" });
  const opened = save(order);
  assert.equal(opened.orders[0].remaining, 20);
  assert.equal(stockAt(opened, "raw"), 10);
  const receive = operation("receive", "first-receipt", { quantity: 12, orderId: order.opId });
  const partial = save(receive);
  assert.equal(stockAt(partial, "raw"), 22);
  assert.equal(partial.orders[0].remaining, 8);
  assert.deepEqual(save(receive), partial);
  assert.throws(() => save({ ...receive, quantity: 13 }), /異なる内容/);
  assert.throws(() => save(operation("receive", "wrong-phase", { variant: "processed", orderId: order.opId })), /発注した品目/);
  assert.throws(() => save(operation("receive", "extra", { quantity: 9, orderId: order.opId })), /発注残を超え/);
  assert.equal(events.length, 2);

  const finish = save(operation("receive", "final-receipt", { quantity: 8, orderId: order.opId }));
  assert.equal(finish.orders.length, 0);
  assert.equal(stockAt(finish, "raw"), 30);
  assert.deepEqual(save(receive), finish);
  assert.equal(events.length, 3);
});

test("cancellation and receipt reversals restore the exact order remainder", () => {
  const { save } = ledger();
  const order = operation("order", "create-order", { quantity: 10 });
  const receive = operation("receive", "receive", { quantity: 4, orderId: order.opId });
  const cancel = operation("cancelOrder", "cancel-order", { orderId: order.opId });
  save(order);
  save(receive);
  assert.throws(() => save(operation("reverse", "early-order-reverse", { targetId: order.opId })), /取り消せません/);
  const cancelled = save(cancel);
  assert.deepEqual(cancelled.orders, []);
  assert.equal(stockAt(cancelled, "raw"), 14);
  const cancelledReversed = save(operation("reverse", "restore-order", { targetId: cancel.opId }));
  assert.equal(cancelledReversed.orders[0].remaining, 6);
  assert.equal(stockAt(cancelledReversed, "raw"), 14);
  const receiptReversed = save(operation("reverse", "reverse-receipt", { targetId: receive.opId }));
  assert.equal(receiptReversed.orders[0].remaining, 10);
  assert.equal(stockAt(receiptReversed, "raw"), 10);
  assert.deepEqual(save(operation("reverse", "reverse-order", { targetId: order.opId })).orders, []);
});

test("confirmed opening orders carry full outstanding units and no physical stock", () => {
  const order = { id: "legacy-order-fixture", partId: "sample", variant: "raw", quantity: 20, date: "2026-11-01", dueDate: "2026-12-15", note: "現行表から採用" };
  const openingSeed = { ...seed, openingOrders: [order] };
  const events = [];
  const save = input => {
    const { event, snapshot } = CastingStock.apply(openingSeed, events, input, metadata);
    if (event) events.push(event);
    return snapshot;
  };
  const opened = CastingStock.project(openingSeed, events);
  assert.deepEqual(opened.orders, [{ ...order, remaining: 20 }]);
  assert.deepEqual(opened.history, []);
  assert.deepEqual(opened.stock, seed.stock);
  assert.throws(() => save(operation("use", "id-conflict", { opId: order.id })), /記録IDが重複/);
  assert.throws(() => save(operation("reverse", "reverse-opening", { targetId: order.id })), /取り消せません/);

  const receipt = operation("receive", "opening-receipt", { orderId: order.id, quantity: 8 });
  const received = save(receipt);
  assert.equal(received.orders[0].remaining, 12);
  assert.equal(stockAt(received, "raw"), 18);
  const cancel = operation("cancelOrder", "opening-cancel", { orderId: order.id });
  assert.deepEqual(save(cancel).orders, []);
  const reopened = save(operation("reverse", "reopen-opening-order", { targetId: cancel.opId }));
  assert.equal(reopened.orders[0].remaining, 12);
  const reversed = save(operation("reverse", "reverse-opening-receipt", { targetId: receipt.opId }));
  assert.deepEqual(reversed.orders, opened.orders);
  assert.equal(stockAt(reversed, "raw"), 10);

  assert.throws(() => CastingStock.project({ ...seed, openingOrders: [order, order] }, []), /発注IDが重複/);
  assert.throws(() => CastingStock.project({ ...seed, openingOrders: [{ ...order, variant: "unclassified" }] }, []), /発注する品目の加工区分/);
});

test("stocktake requires the reviewed balance and confirms zero for unseen items", () => {
  const { save, snapshot } = ledger();
  const otherPart = { partId: "new-sample", variant: "single" };
  assert.equal(snapshot().items[1].openingUnconfirmed, true);
  assert.throws(() => save(operation("receive", "before-count", otherPart)), /最初に棚卸/);
  const count = operation("count", "first-count", { ...otherPart, quantity: 0, expectedQuantity: 0 });
  const confirmed = save(count);
  assert.equal(confirmed.items[1].openingUnconfirmed, false);
  assert.equal(stockAt(confirmed, "single", "1F", "new-sample"), 0);
  save(operation("receive", "after-count", { ...otherPart, quantity: 4 }));
  assert.throws(() => save(operation("count", "stale-count", { ...otherPart, quantity: 3, expectedQuantity: 0 })), /別の端末/);
  assert.equal(stockAt(snapshot(), "single", "1F", "new-sample"), 4);
  save(operation("reverse", "reverse-new-receipt", { targetId: "event-after-count-fixture" }));
  assert.equal(save(operation("reverse", "unconfirm", { targetId: count.opId })).items[1].openingUnconfirmed, true);
});

test("moves, threshold changes and quantity and date validation are enforced on replay", () => {
  const { save, events } = ledger();
  const moved = save(operation("transfer", "move", { toLocation: "2F", quantity: 4 }));
  assert.equal(stockAt(moved, "raw"), 6);
  assert.equal(stockAt(moved, "raw", "2F"), 4);
  assert.throws(() => save(operation("transfer", "same-place", { toLocation: "1F" })), /異なる保管場所/);
  const threshold = operation("threshold", "clear-threshold", { threshold: null });
  assert.equal(save(threshold).items[0].variants[0].threshold, null);
  assert.equal(save(operation("reverse", "restore-threshold", { targetId: threshold.opId })).items[0].variants[0].threshold, 10);
  assert.throws(() => save(operation("use", "invalid-date", { date: "2026-02-29" })), /正しい日付/);
  for (const quantity of [true, "2", NaN, -1, 0, 1.5]) {
    assert.throws(() => save(operation("use", "invalid-quantity", { quantity })), /1以上の整数/);
  }
  assert.throws(() => CastingStock.project(seed, [...events, events[0]]), /記録IDが重複/);
  assert.throws(() => CastingStock.project({ ...seed, stock: [{ ...seed.stock[0], quantity: -1 }] }, []), /開始時の在庫数/);
});

const serviceSource = (await Promise.all([
  "../src/casting-stock.js", "../apps-script/CastingStock.gs",
].map(path => readFile(new URL(path, import.meta.url), "utf8")))).join("\n");

function serviceHarness() {
  const grid = [];
  const control = { role: "owner", locked: false, sourceReads: 0, sourceRevision: source.sourceRevision };
  const sheet = {
    getLastRow: () => grid.length,
    getRange: (row, column, height, width) => ({
      getValues: () => grid.slice(),
      setValues(rows) {
        assert.equal(control.locked, true);
        assert.deepEqual([row, column, height, width], [2, 1, 1, 2]);
        assert.equal(rows.length, 1);
        grid[1] = rows[0];
      },
    }),
    appendRow(row) { assert.equal(control.locked, true); grid.push(row); },
  };
  const context = vm.createContext({
    requireWorkerAccess_() {
      if (!["owner", "admin", "editor", "worker"].includes(control.role)) throw new Error("WORKER_REQUIRED");
      return { email: `${control.role}@example.com` };
    },
    requireOwnerAccess_() { if (control.role !== "owner") throw new Error("OWNER_REQUIRED"); },
    getSpreadsheet_() { return { getSheetByName: () => grid.length ? sheet : null }; },
    ensureSheet_(spreadsheet, name, headers) {
      assert.equal(name, "工程管理_鋳物在庫");
      assert.equal(control.locked, true);
      if (!grid.length) grid.push(headers);
      return sheet;
    },
    withDocumentLock_(callback) {
      control.locked = true;
      if (control.roleOnLock) control.role = control.roleOnLock;
      try { return callback(); } finally { control.locked = false; }
    },
    SpreadsheetApp: { flush() { assert.equal(control.locked, true); } },
    readCastingInventorySource_() {
      control.sourceReads += 1;
      return { ...source, stock: source.stock.filter((row) => row.variant !== "unclassified"), sourceRevision: control.sourceRevision };
    },
  });
  vm.runInContext(serviceSource, context);
  return { context, control, grid };
}

test("read-through preview and owner-only start detect a changed source and write once", () => {
  const { context, control, grid } = serviceHarness();
  control.role = "worker";
  const preview = context.getCastingInventory();
  assert.equal(preview.initialized, false);
  assert.equal(preview.fixedStorage, true);
  assert.equal(grid.length, 0);
  assert.throws(() => context.saveCastingInventoryChange(operation("use", "before-start")), /NOT_STARTED/);
  assert.throws(() => context.startCastingInventory(preview), /OWNER_REQUIRED/);
  control.role = "editor";
  assert.throws(() => context.startCastingInventory(preview), /OWNER_REQUIRED/);
  control.role = "owner";
  control.sourceRevision = "new-revision";
  assert.throws(() => context.startCastingInventory(preview), /SOURCE_CHANGED/);
  assert.equal(grid.length, 0);
  const initialized = context.startCastingInventory({ sourceRevision: control.sourceRevision });
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.fixedStorage, true);
  assert.equal(context.startCastingInventory(preview).initialized, true);
  assert.equal(grid.length, 2);
  assert.equal(grid[1][0], "開始（1・2階）");
  assert.equal(control.sourceReads, 3);
  assert.equal(context.getCastingInventory().revision, initialized.revision);
  assert.equal(control.sourceReads, 3);
});

test("workers can record casting operations, lose access on downgrade, and can safely retry", () => {
  const { context, control, grid } = serviceHarness();
  const initial = context.startCastingInventory({ sourceRevision: control.sourceRevision });
  control.role = "worker";
  control.roleOnLock = "viewer";
  const move = { opId: "locked-process-fixture", type: "process", partId: "sample", toVariant: "processed", quantity: 2, date: "2026-11-25" };
  assert.throws(() => context.saveCastingInventoryChange(move), /WORKER_REQUIRED/);
  assert.throws(() => context.getCastingInventory(), /WORKER_REQUIRED/);
  assert.equal(grid.length, 2);
  control.role = "worker";
  delete control.roleOnLock;
  const saved = context.saveCastingInventoryChange(move);
  assert.equal(saved.revision, initial.revision + 1);
  assert.equal(stockAt(saved, "raw"), 8);
  assert.equal(stockAt(saved, "processed", "2F"), 2);
  assert.equal(context.getCastingInventory().history[0].actor, "worker@example.com");
  assert.equal(context.saveCastingInventoryChange(move).revision, saved.revision);
  assert.equal(grid.length, 3);
  grid[2][1] = "broken";
  assert.throws(() => context.getCastingInventory(), /3行目/);
});

test("a worker read enables fixed storage once and combines the original opening amounts", () => {
  const { context, control, grid } = serviceHarness();
  context.startCastingInventory({ sourceRevision: control.sourceRevision });
  const previous = {
    ...seed,
    stock: [...seed.stock,
      { partId: "sample", variant: "unclassified", location: "2F", quantity: 3 },
      { partId: "sample", variant: "unclassified", location: "保土田", quantity: 4 },
    ],
  };
  const original = JSON.stringify(previous);
  grid[1] = ["開始", original];
  control.role = "worker";
  control.roleOnLock = "viewer";
  assert.throws(() => context.getCastingInventory(), /WORKER_REQUIRED/);
  assert.equal(grid[1][0], "開始");
  assert.equal(grid[1][1], original);
  delete control.roleOnLock;
  control.role = "worker";
  const mapped = context.getCastingInventory();
  assert.equal(mapped.fixedStorage, true);
  assert.equal(stockAt(mapped, "raw"), 18);
  assert.equal(stockAt(mapped, "processed", "2F"), 7);
  assert.equal(stockAt(mapped, "processed", "保土田"), 0);
  assert.equal(stockAt(mapped, "unclassified"), 0);
  assert.equal(mapped.history.length, 0);
  assert.equal(grid.length, 2);
  assert.equal(grid[1][0], "開始（1・2階）");
  assert.deepEqual(JSON.parse(grid[1][1]), { ...previous, fixedStorageFrom: 0 });
  assert.deepEqual(context.getCastingInventory(), mapped);
});

test("fixed storage preserves existing operation rows and projects their actual remaining stock", () => {
  const { context, control, grid } = serviceHarness();
  context.startCastingInventory({ sourceRevision: control.sourceRevision });
  const original = JSON.stringify(seed);
  grid[1] = ["開始", original];
  const { event } = CastingStock.apply(seed, [], operation("use", "legacy-use", { variant: "unclassified" }), metadata);
  const row = ["op:" + event.request.opId, JSON.stringify(event)];
  grid.push(row);
  control.role = "worker";
  const snapshot = context.getCastingInventory();
  assert.equal(stockAt(snapshot, "raw"), 17);
  assert.equal(stockAt(snapshot, "unclassified"), 0);
  assert.equal(snapshot.history[0].id, event.request.opId);
  assert.equal(snapshot.history[0].changes[0].variant, "unclassified");
  assert.deepEqual(JSON.parse(grid[1][1]), { ...seed, fixedStorageFrom: 1 });
  assert.equal(grid[1][0], "開始（1・2階）");
  assert.deepEqual(grid[2], row);
});
