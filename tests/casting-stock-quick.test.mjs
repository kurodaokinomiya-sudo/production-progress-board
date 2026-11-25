import assert from "node:assert/strict";
import test from "node:test";

import "../src/casting-stock.js";

const CastingStock = globalThis.CastingStock;
const metadata = { createdAt: "2026-11-25T03:00:00.000Z", actor: "worker@example.com" };
const seed = {
  initializedAt: metadata.createdAt,
  sourceUrl: "https://example.com/legacy-stock",
  items: [
    { id: "body", name: "コットマン", variants: [
      { id: "raw", label: "未加工", threshold: 5 },
      { id: "processed", label: "加工済（通常）", threshold: 3 },
      { id: "colored", label: "加工済（色しっぽ）", threshold: 2 },
      { id: "unclassified", label: "区分未確認", threshold: null },
    ] },
    { id: "lever", name: "レバー", variants: [
      { id: "single", label: "区分なし", threshold: null },
    ] },
  ],
  stock: [
    { partId: "body", variant: "raw", location: "1F", quantity: 30 },
    { partId: "body", variant: "raw", location: "保土田", quantity: 2 },
    { partId: "body", variant: "processed", location: "1F", quantity: 2 },
    { partId: "body", variant: "processed", location: "2F", quantity: 5 },
    { partId: "body", variant: "processed", location: "保土田", quantity: 8 },
    { partId: "body", variant: "colored", location: "保土田", quantity: 4 },
    { partId: "body", variant: "unclassified", location: "1F", quantity: 1 },
    { partId: "body", variant: "unclassified", location: "保土田", quantity: 2 },
    { partId: "lever", variant: "single", location: "1F", quantity: 3 },
    { partId: "lever", variant: "single", location: "2F", quantity: 6 },
    { partId: "lever", variant: "single", location: "保土田", quantity: 2 },
  ],
};

const request = (type, id, values = {}) => ({
  opId: "quick-test-" + id,
  type,
  partId: "body",
  date: "2026-11-25",
  quantity: 1,
  ...values,
});

function historyFor(initial = { ...seed, fixedStorageFrom: 0 }, existing = []) {
  const events = [...existing];
  return {
    events,
    save(input) {
      const { event, snapshot } = CastingStock.apply(initial, events, input, metadata);
      if (event) events.push(event);
      return snapshot;
    },
    read() { return CastingStock.project(initial, events); },
  };
}

function stockAt(snapshot, variant, location = "1F", partId = "body") {
  return snapshot.stock.find(row => row.partId === partId && row.variant === variant && row.location === location)?.quantity ?? 0;
}

test("fixed storage consolidates both floors and the outside location by phase", () => {
  const previous = CastingStock.project(seed, []);
  const current = historyFor().read();
  assert.equal(current.fixedStorage, true);
  assert.equal(current.revision, previous.revision + 1);
  assert.deepEqual(current.history, previous.history);
  assert.deepEqual(current.items, previous.items);
  assert.equal(current.sourceUrl, previous.sourceUrl);
  assert.equal(stockAt(current, "raw"), 33);
  assert.equal(stockAt(current, "processed", "2F"), 17);
  assert.equal(stockAt(current, "colored", "2F"), 4);
  assert.equal(stockAt(current, "single", "1F", "lever"), 11);
  assert.equal(current.stock.length, 4);
  assert.equal(current.stock.reduce((sum, row) => sum + row.quantity, 0),
    previous.stock.reduce((sum, row) => sum + row.quantity, 0));
  for (const boundary of [null, "0", -1, 1, 1.5, Infinity]) {
    assert.throws(() => CastingStock.project({ ...seed, fixedStorageFrom: boundary }, []), /統合した時点/);
  }
});

test("quick entries derive fixed places and enforce the selected work's valid phases", () => {
  const ledger = historyFor();
  let current = ledger.save(request("process", "colored-processing", { quantity: 3, toVariant: "colored", location: "保土田", toLocation: "1F" }));
  assert.equal(stockAt(current, "raw"), 30);
  assert.equal(stockAt(current, "colored", "2F"), 7);
  assert.deepEqual(current.history[0].changes, [
    { variant: "raw", location: "1F", before: 33, after: 30 },
    { variant: "colored", location: "2F", before: 4, after: 7 },
  ]);
  current = ledger.save(request("use", "regular-use", { quantity: 2 }));
  assert.equal(stockAt(current, "processed", "2F"), 15);
  current = ledger.save(request("use", "colored-use", { variant: "colored", quantity: 2 }));
  assert.equal(stockAt(current, "colored", "2F"), 5);
  current = ledger.save(request("use", "as-is-use", { partId: "lever", quantity: 3 }));
  assert.equal(stockAt(current, "single", "1F", "lever"), 8);
  current = ledger.save(request("count", "as-is-count", { partId: "lever", quantity: 6, expectedQuantity: 8 }));
  assert.equal(stockAt(current, "single", "1F", "lever"), 6);
  current = ledger.save(request("count", "body-count", { variant: "processed", quantity: 12, expectedQuantity: 15 }));
  assert.equal(stockAt(current, "processed", "2F"), 12);
  current = ledger.save(request("sell", "body-sale", { quantity: 1 }));
  assert.equal(stockAt(current, "raw"), 29);
  assert.throws(() => ledger.save(request("use", "forged-phase", { variant: "raw" })), /使用する加工済/);
  assert.throws(() => ledger.save(request("order", "forged-order", { variant: "processed" })), /未加工の在庫/);
  assert.throws(() => ledger.save(request("receive", "forged-receive", { variant: "processed" })), /未加工の在庫/);
  assert.throws(() => ledger.save(request("process", "bad-destination", { toVariant: "raw" })), /未加工から加工済/);
  assert.throws(() => ledger.save(request("process", "as-is-process", { partId: "lever" })), /品目または加工区分/);
  assert.throws(() => ledger.save(request("use", "too-many", { quantity: 13 })), /在庫が不足/);
  assert.throws(() => ledger.save(request("count", "stale-count", { variant: "processed", expectedQuantity: 15 })), /別の端末/);
  for (const type of ["classify", "transfer"]) {
    assert.throws(() => ledger.save(request(type, "removed-" + type)), /区分は固定/);
  }
  assert.deepEqual(ledger.read(), current);
});

test("migration preserves earlier history and reverses its changes in consolidated storage", () => {
  const legacy = historyFor(seed);
  const classify = request("classify", "legacy-classification", {
    variant: "unclassified", location: "1F", toVariant: "processed",
  });
  const transfer = request("transfer", "legacy-transfer", {
    variant: "processed", location: "2F", toLocation: "保土田", quantity: 3,
  });
  legacy.save(classify);
  const previous = legacy.save(transfer);
  const ledger = historyFor({ ...seed, fixedStorageFrom: legacy.events.length }, legacy.events);
  const current = ledger.read();
  assert.deepEqual(current.history, previous.history);
  assert.equal(stockAt(current, "raw"), 32);
  assert.equal(stockAt(current, "processed", "2F"), 18);
  assert.deepEqual(ledger.save(transfer), current);
  assert.equal(ledger.events.length, 2);
  assert.throws(() => ledger.save({ ...transfer, quantity: 2 }), /異なる内容/);
  const transferReversed = ledger.save(request("reverse", "reverse-transfer", { targetId: transfer.opId }));
  assert.deepEqual(transferReversed.history[0].changes, []);
  assert.deepEqual(transferReversed.stock, current.stock);
  const restored = ledger.save(request("reverse", "reverse-classification", { targetId: classify.opId }));
  assert.equal(stockAt(restored, "raw"), 33);
  assert.equal(stockAt(restored, "processed", "2F"), 17);
  assert.deepEqual(ledger.read(), restored);
});

test("receipts apply to outstanding orders in date and insertion order and reverse precisely", () => {
  const ledger = historyFor();
  const later = request("order", "later", { quantity: 10, date: "2026-11-10" });
  const earlier = request("order", "earlier", { quantity: 8, date: "2026-11-05" });
  const tied = request("order", "same-date", { quantity: 6, date: earlier.date });
  ledger.save(later);
  ledger.save(earlier);
  const ordered = ledger.save(tied);
  assert.equal(stockAt(ordered, "raw"), 33);

  const receive = request("receive", "fifo-receive", { quantity: 12 });
  const split = ledger.save(receive);
  assert.equal(stockAt(split, "raw"), 45);
  assert.deepEqual(split.history[0].orderAllocations, [
    { orderId: earlier.opId, quantity: 8 },
    { orderId: tied.opId, quantity: 4 },
  ]);
  assert.deepEqual(split.orders.map(({ id, remaining }) => [id, remaining]), [[later.opId, 10], [tied.opId, 2]]);
  assert.throws(() => ledger.save(request("receive", "too-much-for-link", { orderId: tied.opId, quantity: 3 })), /発注残を超えています/);
  const extra = request("receive", "extra-receive", { quantity: 20 });
  const delivered = ledger.save(extra);
  assert.equal(stockAt(delivered, "raw"), 65);
  assert.deepEqual(delivered.orders, []);
  assert.deepEqual(delivered.history[0].orderAllocations, [
    { orderId: tied.opId, quantity: 2 },
    { orderId: later.opId, quantity: 10 },
  ]);
  assert.deepEqual(ledger.save(receive), delivered);
  assert.equal(ledger.events.length, 5);
  const reverseExtra = ledger.save(request("reverse", "reverse-extra", { targetId: extra.opId }));
  assert.deepEqual(reverseExtra.orders, split.orders);
  assert.equal(stockAt(reverseExtra, "raw"), 45);
  const reverseSplit = ledger.save(request("reverse", "reverse-split", { targetId: receive.opId }));
  assert.deepEqual(reverseSplit.orders, ordered.orders);
  assert.equal(stockAt(reverseSplit, "raw"), 33);
  assert.deepEqual(ledger.read(), reverseSplit);

  const linked = ledger.save(request("receive", "direct-receive", { quantity: 3, orderId: later.opId }));
  assert.deepEqual(linked.history[0].orderAllocations, [{ orderId: later.opId, quantity: 3 }]);
  assert.equal(linked.orders.find(order => order.id === earlier.opId).remaining, earlier.quantity);
});

test("legacy purchase and linked receipt keep their history and reopen work in raw storage", () => {
  const legacy = historyFor(seed);
  const order = request("order", "old-processed-order", { variant: "processed", quantity: 5, dueDate: "2026-12-01", note: "以前の発注" });
  const receive = request("receive", "old-processed-receipt", { variant: "processed", quantity: 5, location: "保土田", orderId: order.opId });
  legacy.save(order);
  const delivered = legacy.save(receive);
  const ledger = historyFor({ ...seed, fixedStorageFrom: legacy.events.length }, legacy.events);
  assert.deepEqual(ledger.read().history, delivered.history);
  assert.equal(stockAt(ledger.read(), "processed", "2F"), 22);
  const reopened = ledger.save(request("reverse", "reverse-legacy-receipt", { targetId: receive.opId }));
  assert.equal(stockAt(reopened, "processed", "2F"), 17);
  assert.deepEqual(reopened.orders, [{
    id: order.opId, partId: "body", variant: "raw", quantity: 5, remaining: 5,
    date: order.date, dueDate: order.dueDate, note: order.note,
  }]);
  const cancel = request("cancelOrder", "new-cancel", { orderId: order.opId });
  assert.deepEqual(ledger.save(cancel).orders, []);
  assert.deepEqual(ledger.save(request("reverse", "undo-cancel", { targetId: cancel.opId })).orders, reopened.orders);
  const fixedReceipt = ledger.save(request("receive", "new-raw-receipt", { quantity: 5 }));
  assert.equal(stockAt(fixedReceipt, "raw"), 38);
  assert.equal(stockAt(fixedReceipt, "processed", "2F"), 17);
  assert.deepEqual(fixedReceipt.orders, []);
});

test("a quick order requires an empty order remainder and can be retried after saving", () => {
  const ledger = historyFor();
  const changed = /CASTING_STOCK_ORDER_CHANGED:/;
  const lever = request("order", "lever-order", { partId: "lever", quantity: 3, expectedOrderRemainder: 0 });
  ledger.save(lever);
  const order = request("order", "reviewed-order", { quantity: 10, expectedOrderRemainder: 0 });
  const ordered = ledger.save(order);
  assert.deepEqual(ledger.save(order), ordered);
  assert.equal(ledger.events.length, 2);
  assert.throws(() => ledger.save(request("order", "concurrent-order", { expectedOrderRemainder: 0 })), changed);
  assert.throws(() => ledger.save(request("order", "invalid-order-review", { expectedOrderRemainder: 10 })), changed);
  assert.deepEqual(ledger.read(), ordered);

  const delivered = ledger.save(request("receive", "reviewed-final-receipt", { quantity: 10, expectedOrderRemainder: 10 }));
  assert.equal(stockAt(delivered, "raw"), 43);
  assert.deepEqual(delivered.orders.map(row => row.id), [lever.opId]);
  assert.throws(() => ledger.save(request("receive", "stale-closed-receipt", { expectedOrderRemainder: 10 })), changed);
  const nextOrder = request("order", "reopened-order-action", { expectedOrderRemainder: 0 });
  ledger.save(nextOrder);
  ledger.save(request("cancelOrder", "cancel-reviewed-order", { orderId: nextOrder.opId }));
  assert.equal(ledger.save(request("order", "order-after-cancellation", { expectedOrderRemainder: 0 })).orders.length, 2);
});

test("reviewed receipts reject stale and excessive amounts without changing stock or orders", () => {
  const ledger = historyFor();
  const changed = /CASTING_STOCK_ORDER_CHANGED:/;
  const unlinked = ledger.save(request("receive", "detail-unlinked", { quantity: 2, expectedOrderRemainder: 0 }));
  assert.equal(stockAt(unlinked, "raw"), 35);
  assert.deepEqual(unlinked.history[0].orderAllocations, []);
  const first = request("order", "reviewed-first-order", { quantity: 8, expectedOrderRemainder: 0 });
  const second = request("order", "intentional-additional-order", { quantity: 7 });
  ledger.save(first);
  const ordered = ledger.save(second);
  assert.throws(() => ledger.save(request("receive", "stale-unplanned-receipt", { expectedOrderRemainder: 0 })), /CASTING_STOCK_ORDER_CHANGED:/);
  assert.throws(() => ledger.save(request("receive", "excessive-review", { quantity: 16, expectedOrderRemainder: 15 })),
    /CASTING_STOCK_INVALID: 入庫数が発注残を超えています/);
  assert.deepEqual(ledger.read(), ordered);
  assert.equal(ledger.events.length, 3);

  const partialReceipt = request("receive", "reviewed-partial", { quantity: 9, expectedOrderRemainder: 15 });
  const partial = ledger.save(partialReceipt);
  assert.equal(stockAt(partial, "raw"), 44);
  assert.deepEqual(partial.history[0].orderAllocations, [
    { orderId: first.opId, quantity: 8 },
    { orderId: second.opId, quantity: 1 },
  ]);
  assert.equal(partial.orders[0].remaining, 6);
  assert.deepEqual(ledger.save(partialReceipt), partial);
  assert.throws(() => ledger.save({ ...partialReceipt, expectedOrderRemainder: 6 }), /異なる内容/);
  assert.throws(() => ledger.save(request("receive", "stale-review", { expectedOrderRemainder: 15 })), changed);

  const third = request("order", "additional-order-while-receiving", { quantity: 9 });
  ledger.save(third);
  const linked = request("receive", "reviewed-linked-receipt", { orderId: second.opId, quantity: 6, expectedOrderRemainder: 6 });
  const received = ledger.save(linked);
  assert.deepEqual(received.history[0].orderAllocations, [{ orderId: second.opId, quantity: 6 }]);
  assert.equal(received.orders[0].remaining, 9);
  assert.throws(() => ledger.save(request("receive", "stale-exact-order", { orderId: second.opId, expectedOrderRemainder: 6 })), changed);
  assert.throws(() => ledger.save(request("receive", "stale-aggregate", { expectedOrderRemainder: 15 })), changed);
  assert.deepEqual(ledger.save(linked), received);
  assert.equal(ledger.events.length, 6);
  const restored = ledger.save(request("reverse", "reverse-reviewed-receipt", { targetId: linked.opId }));
  assert.equal(stockAt(restored, "raw"), 44);
  assert.deepEqual(restored.orders.map(row => [row.id, row.remaining]), [[second.opId, 6], [third.opId, 9]]);
  assert.deepEqual(ledger.read(), restored);
});
