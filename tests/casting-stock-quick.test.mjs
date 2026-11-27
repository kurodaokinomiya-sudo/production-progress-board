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

function editRequest(id, order, values = {}) {
  return request("editOrder", id, { orderId: order.id, expectedOrderRevision: order.revision,
    quantity: order.quantity, orderDate: order.date, dueDate: order.dueDate, note: order.note, ...values });
}

function correctionRequest(id, historyRow, quantity) {
  return request("correctQuantity", id, { targetId: historyRow.id, expectedRevision: historyRow.correction.expectedRevision, quantity });
}

function recordedHistory(snapshot) {
  return snapshot.history.map(({ correction, cancellation, cancellationBlocked, ...row }) => row);
}

function cancelRecord(id, historyRow) {
  return request("reverseSelected", id, { targetId: historyRow.id, expectedRevision: historyRow.cancellation.expectedRevision });
}

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
  assert.deepEqual(recordedHistory(current), recordedHistory(previous));
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
  assert.deepEqual(reverseExtra.orders, split.orders.map((order) => ({ ...order, revision: "quick-test-reverse-extra" })));
  assert.equal(stockAt(reverseExtra, "raw"), 45);
  const reverseSplit = ledger.save(request("reverse", "reverse-split", { targetId: receive.opId }));
  assert.deepEqual(reverseSplit.orders, ordered.orders.map((order) => ({
    ...order, revision: order.id === later.opId ? "quick-test-reverse-extra" : "quick-test-reverse-split",
  })));
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
  assert.deepEqual(recordedHistory(ledger.read()), recordedHistory(delivered));
  assert.equal(stockAt(ledger.read(), "processed", "2F"), 22);
  const reopened = ledger.save(request("reverse", "reverse-legacy-receipt", { targetId: receive.opId }));
  assert.equal(stockAt(reopened, "processed", "2F"), 17);
  assert.deepEqual(reopened.orders, [{
    id: order.opId, partId: "body", variant: "raw", quantity: 5, received: 0, remaining: 5,
    revision: "quick-test-reverse-legacy-receipt",
    date: order.date, dueDate: order.dueDate, note: order.note,
  }]);
  const cancel = request("cancelOrder", "new-cancel", { orderId: order.opId });
  assert.deepEqual(ledger.save(cancel).orders, []);
  assert.deepEqual(ledger.save(request("reverse", "undo-cancel", { targetId: cancel.opId })).orders,
    reopened.orders.map((order) => ({ ...order, revision: "quick-test-undo-cancel" })));
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

test("order edits keep the same order and stock, reject stale edits and restore the recorded values on undo", () => {
  const ledger = historyFor();
  const open = ledger.save(request("order", "edit-target", { quantity: 10, note: "発注時の備考", dueDate: "2026-12-05" })).orders[0];
  const edit = editRequest("planned-edit", open, { quantity: 8, orderDate: "2026-11-26", dueDate: "2026-12-08", note: "数量と日程の変更" });
  const updated = ledger.save(edit);
  assert.equal(stockAt(updated, "raw"), 33);
  assert.deepEqual(updated.orders[0], { ...open, quantity: 8, remaining: 8, date: edit.orderDate,
    dueDate: edit.dueDate, note: edit.note, revision: edit.opId });
  assert.deepEqual(updated.history[0].previousOrder, { quantity: 10, date: open.date, dueDate: open.dueDate, note: open.note });
  assert.deepEqual(ledger.save(edit), updated);
  assert.throws(() => ledger.save(editRequest("stale-edit", open, { quantity: 9 })), /CASTING_STOCK_ORDER_CHANGED:/);
  assert.throws(() => ledger.save(request("cancelOrder", "stale-cancel", { orderId: open.id, expectedOrderRevision: open.revision })), /CASTING_STOCK_ORDER_CHANGED:/);
  assert.throws(() => ledger.save(editRequest("invalid-schedule", updated.orders[0], { dueDate: "2026-11-25" })), /発注日以降/);
  const undo = request("reverse", "undo-planned-edit", { targetId: edit.opId });
  const restored = ledger.save(undo);
  assert.deepEqual(restored.orders[0], { ...open, revision: undo.opId });
  assert.equal(stockAt(restored, "raw"), 33);
  assert.deepEqual(ledger.read(), restored);
});

test("confirmed excess increases stock by the actual quantity and remains linked to a single order", () => {
  const ledger = historyFor();
  const open = ledger.save(request("order", "overshoot-target", { quantity: 10 })).orders[0];
  const partial = ledger.save(request("receive", "before-overshoot", { quantity: 4, expectedOrderRemainder: 10,
    expectedOrders: [{ id: open.id, revision: open.revision }] }));
  const order = partial.orders[0];
  assert.equal(order.remaining, 6);
  assert.equal(order.received, 4);
  const extra = request("receive", "confirmed-excess", { quantity: 9, orderId: order.id, expectedOrderRemainder: 6,
    expectedOrders: [{ id: order.id, revision: order.revision }], confirmOverReceipt: true });
  const delivered = ledger.save(extra);
  assert.equal(stockAt(delivered, "raw"), 46);
  assert.deepEqual(delivered.orders, []);
  assert.deepEqual(delivered.completedOrders[0], { ...order, remaining: 0, received: 13, revision: extra.opId });
  assert.equal(delivered.history[0].excessQuantity, 3);
  assert.deepEqual(delivered.history[0].orderAllocations, [{ orderId: order.id, quantity: 6 }]);
  assert.deepEqual(ledger.save(extra), delivered);

  const edit = editRequest("completed-order-edit", delivered.completedOrders[0], { quantity: 13, dueDate: "", note: "発注票を確認" });
  const edited = ledger.save(edit);
  assert.equal(stockAt(edited, "raw"), 46);
  assert.equal(edited.completedOrders[0].quantity, 13);
  assert.equal(edited.completedOrders[0].received, 13);
  ledger.save(request("reverse", "undo-completed-edit", { targetId: edit.opId }));
  const undoReceipt = request("reverse", "undo-confirmed-excess", { targetId: extra.opId });
  const undone = ledger.save(undoReceipt);
  assert.deepEqual(undone.orders[0], { ...order, revision: undoReceipt.opId });
  assert.equal(stockAt(undone, "raw"), 37);
  assert.equal(undone.history[0].excessQuantity, 3);
  assert.deepEqual(ledger.read(), undone);
});

test("receiving detects an order edit with the same total and allocates a reviewed excess across pending orders only", () => {
  const ledger = historyFor();
  ledger.save(request("order", "receipt-later", { quantity: 2, date: "2026-11-25" }));
  const ordered = ledger.save(request("order", "receipt-earlier", { quantity: 3, date: "2026-11-23" }));
  const oldReview = ordered.orders.map(({ id, revision }) => ({ id, revision }));
  const edited = ledger.save(editRequest("order-note-only", ordered.orders[0], { note: "数量は同じ" }));
  const receive = request("receive", "confirmed-multiple-excess", { quantity: 7, expectedOrderRemainder: 5, confirmOverReceipt: true });
  assert.throws(() => ledger.save({ ...receive, expectedOrders: oldReview }), /CASTING_STOCK_ORDER_CHANGED:/);
  const delivered = ledger.save({ ...receive, expectedOrders: edited.orders.map(({ id, revision }) => ({ id, revision })).reverse() });
  assert.deepEqual(delivered.history[0].orderAllocations, [
    { orderId: "quick-test-receipt-earlier", quantity: 3 }, { orderId: "quick-test-receipt-later", quantity: 2 },
  ]);
  assert.equal(delivered.history[0].excessQuantity, 2);
  assert.equal(stockAt(delivered, "raw"), 40);
  assert.deepEqual(delivered.completedOrders.map(({ received }) => received), [2, 3]);
});

test("a confirmed shortage closes an order with the actual receipt and undo restores its prior balance", () => {
  const ledger = historyFor();
  const initial = ledger.save(request("order", "shortage-target", { quantity: 12 })).orders[0];
  const partial = ledger.save(request("receive", "prior-partial-receipt", { quantity: 3, completeOrder: "true" })).orders[0];
  const closing = request("receive", "complete-with-shortage", {
    quantity: 5, expectedOrderRemainder: 9, expectedOrders: [{ id: initial.id, revision: partial.revision }], completeOrder: true,
  });
  const completed = ledger.save(closing);
  assert.equal(stockAt(completed, "raw"), 41);
  assert.deepEqual(completed.orders, []);
  assert.deepEqual(completed.completedOrders, [{
    ...partial, received: 8, remaining: 0, revision: closing.opId, shortClosed: true,
  }]);
  assert.equal(completed.history[0].closedRemainder, 4);
  assert.deepEqual(completed.history[0].orderAllocations, [{ orderId: initial.id, quantity: 5 }]);
  assert.equal(ledger.events.at(-1).request.completeOrder, true);
  assert.equal(ledger.events.at(-1).request.type, "receiveAndComplete");
  assert.deepEqual(ledger.save(closing), completed);
  assert.equal(ledger.events.length, 3);

  const edit = editRequest("edit-short-closed-order", completed.completedOrders[0], { quantity: 15, note: "発注書を確認" });
  const edited = ledger.save(edit);
  assert.deepEqual(edited.orders, []);
  assert.deepEqual(edited.completedOrders, [{
    ...completed.completedOrders[0], quantity: 15, note: edit.note, revision: edit.opId,
  }]);
  assert.equal(stockAt(edited, "raw"), 41);
  const undoEdit = request("reverse", "undo-edit-short-closed", { targetId: edit.opId });
  assert.deepEqual(ledger.save(undoEdit).completedOrders, [{ ...completed.completedOrders[0], revision: undoEdit.opId }]);

  const undoReceipt = request("reverse", "undo-short-closure", { targetId: closing.opId });
  const reopened = ledger.save(undoReceipt);
  assert.deepEqual(reopened.orders, [{ ...partial, revision: undoReceipt.opId }]);
  assert.deepEqual(reopened.completedOrders, []);
  assert.equal(stockAt(reopened, "raw"), 36);
  assert.equal(reopened.history[0].closedRemainder, 4);
  assert.deepEqual(reopened.history[0].orderAllocations, [{ orderId: initial.id, quantity: 5 }]);
  assert.deepEqual(ledger.read(), reopened);
});

test("shortage closure requires a reviewed single order and rejects changed or non-short balances", () => {
  const ledger = historyFor();
  ledger.save(request("order", "shortage-first-order", { quantity: 5 }));
  const opened = ledger.save(request("order", "shortage-second-order", { quantity: 9 }));
  const [target, other] = opened.orders;
  const closing = request("receive", "close-one-of-two-orders", {
    orderId: target.id, quantity: 2, expectedOrderRemainder: 5,
    expectedOrders: [{ id: target.id, revision: target.revision }], completeOrder: true,
  });
  const changed = /CASTING_STOCK_ORDER_CHANGED:/;
  assert.throws(() => ledger.save({ ...closing, orderId: undefined, expectedOrderRemainder: 14,
    expectedOrders: opened.orders.map(({ id, revision }) => ({ id, revision })) }), changed);
  assert.throws(() => ledger.save({ ...closing, expectedOrders: undefined }), changed);
  assert.throws(() => ledger.save({ ...closing, expectedOrderRemainder: undefined }), changed);
  assert.throws(() => ledger.save({ ...closing, quantity: 5 }), /発注残より少なく/);
  assert.throws(() => ledger.save({ ...closing, quantity: 6, confirmOverReceipt: true }), /発注残より少なく/);
  assert.deepEqual(ledger.read(), opened);
  assert.equal(ledger.events.length, 2);

  const edited = ledger.save(editRequest("note-update-before-shortage", target, { note: "入荷予定を確認" }));
  assert.throws(() => ledger.save(closing), changed);
  assert.equal(stockAt(ledger.read(), "raw"), 33);
  const completed = ledger.save({ ...closing, expectedOrders: [{ id: target.id, revision: edited.orders[0].revision }] });
  assert.deepEqual(completed.orders, [other]);
  assert.deepEqual(completed.completedOrders, [{
    ...edited.orders[0], received: 2, remaining: 0, revision: closing.opId, shortClosed: true,
  }]);
  assert.equal(stockAt(completed, "raw"), 35);
  assert.equal(completed.history[0].closedRemainder, 3);
});

test("corrects an earlier use in place, keeps newer records active, and retries the same correction once", () => {
  const ledger = historyFor();
  const use = request("use", "earlier-use", { quantity: 10 });
  const before = ledger.save(use);
  const stale = correctionRequest("stale-use-correction", before.history[0], 12);
  const later = request("process", "later-process", { quantity: 5 });
  const after = ledger.save(later);
  assert.throws(() => ledger.save(stale), /CASTING_STOCK_RECORD_CHANGED:/);
  const record = after.history.find(row => row.id === use.opId);
  const correction = correctionRequest("correct-use", record, 12);
  ledger.save(request("use", "another-part", { partId: "lever", quantity: 2 }));
  assert.deepEqual(CastingStock.previewQuantityCorrection(record, 12), {
    stockChanges: [{ variant: "processed", location: "2F", before: 12, after: 10 }], orderChanges: [], laterCountPreserved: false,
  });
  assert.throws(() => ledger.save({ ...correction, quantity: 40 }), /訂正後の在庫が不足/);
  assert.throws(() => ledger.save({ ...correction, quantity: 0 }), /1以上/);
  const corrected = ledger.save(correction);
  assert.equal(stockAt(corrected, "processed", "2F"), 10);
  assert.equal(stockAt(corrected, "raw"), 28);
  assert.deepEqual(ledger.save(correction), corrected);
  assert.throws(() => ledger.save({ ...correction, quantity: 11 }), /異なる内容/);
  assert.equal(ledger.events.length, 4);
  assert.deepEqual(ledger.events[0].request.quantity, 10);
  assert.equal(corrected.history[0].type, "correctQuantity");
  assert.deepEqual([corrected.history[0].previousQuantity, corrected.history[0].quantity], [10, 12]);
  assert.equal(corrected.history[0].canReverse, false);
  assert.equal(corrected.history.find(row => row.id === later.opId).canReverse, true);
  const correctedRecord = corrected.history.find(row => row.id === use.opId);
  assert.equal(correctedRecord.correctedQuantity, 12);
  assert.deepEqual(correctedRecord.changes, record.changes);
  const correctedAgain = ledger.save(correctionRequest("correct-use-again", correctedRecord, 11));
  assert.equal(correctedAgain.history[0].previousQuantity, 12);
  assert.equal(stockAt(correctedAgain, "processed", "2F"), 11);
  const undoneLater = ledger.save(request("reverse", "undo-later-process", { targetId: later.opId }));
  assert.equal(stockAt(undoneLater, "processed", "2F"), 6);
  const undoneUse = ledger.save(request("reverse", "undo-corrected-use", { targetId: use.opId }));
  assert.equal(stockAt(undoneUse, "processed", "2F"), 17);
  assert.equal(undoneUse.history[0].quantity, 11);
  assert.equal(undoneUse.history.find(row => row.id === use.opId).correction, undefined);
  assert.deepEqual(ledger.read(), undoneUse);
});

test("a later physical count anchors only the inventory it measured", () => {
  const ledger = historyFor();
  const process = request("process", "colored-to-correct", { toVariant: "colored", quantity: 10 });
  ledger.save(process);
  const count = request("count", "actual-colored-count", { variant: "colored", expectedQuantity: 14, quantity: 14 });
  const counted = ledger.save(count);
  const original = counted.history.find(row => row.id === process.opId);
  assert.deepEqual(CastingStock.previewQuantityCorrection(original, 12), {
    stockChanges: [{ variant: "raw", location: "1F", before: 23, after: 21 }], orderChanges: [], laterCountPreserved: true,
  });
  const corrected = ledger.save(correctionRequest("correct-colored", original, 12));
  assert.equal(stockAt(corrected, "raw"), 21);
  assert.equal(stockAt(corrected, "colored", "2F"), 14);
  const countedAgain = ledger.save(correctionRequest("correct-actual-count", corrected.history.find(row => row.id === count.opId), 0));
  assert.equal(stockAt(countedAgain, "colored", "2F"), 0);
  const undoneCount = ledger.save(request("reverse", "undo-actual-count", { targetId: count.opId }));
  assert.equal(stockAt(undoneCount, "colored", "2F"), 16);
  const undoneProcess = ledger.save(request("reverse", "undo-original-process", { targetId: process.opId }));
  assert.equal(stockAt(undoneProcess, "raw"), 33);
  assert.equal(stockAt(undoneProcess, "colored", "2F"), 4);
  assert.deepEqual(ledger.read(), undoneProcess);
});

test("a legacy count absorbs corrections only for its old location before consolidation", () => {
  const legacy = historyFor(seed);
  const receive = request("receive", "old-receipt-location", { variant: "processed", location: "保土田", quantity: 5 });
  legacy.save(receive);
  legacy.save(request("count", "old-other-location-count", { variant: "processed", location: "2F", expectedQuantity: 5, quantity: 10 }));
  const count = request("count", "old-same-location-count", { variant: "processed", location: "保土田", expectedQuantity: 13, quantity: 15 });
  legacy.save(count);
  const ledger = historyFor({ ...seed, fixedStorageFrom: legacy.events.length }, legacy.events);
  const original = ledger.read().history.find(row => row.id === receive.opId);
  const corrected = ledger.save(correctionRequest("correct-old-location", original, 6));
  assert.equal(stockAt(corrected, "processed", "2F"), 29);
  assert.equal(corrected.history[0].laterCountPreserved, true);
  const undoneCount = ledger.save(request("reverse", "undo-old-count", { targetId: count.opId }));
  assert.equal(stockAt(undoneCount, "processed", "2F"), 28);
  const correctedAgain = ledger.save(correctionRequest("correct-other-location", undoneCount.history.find(row => row.id === receive.opId), 7));
  assert.equal(stockAt(correctedAgain, "processed", "2F"), 29);
  assert.equal(correctedAgain.history[0].laterCountPreserved, undefined);
  assert.deepEqual(ledger.read(), correctedAgain);
});

test("a receipt correction uses the original order slots and preserves later receipts and order edits", () => {
  const ledger = historyFor();
  const unplanned = request("receive", "unplanned-to-correct", { quantity: 2 });
  ledger.save(unplanned);
  const first = request("order", "first-original-slot", { quantity: 5 });
  const second = request("order", "second-original-slot", { quantity: 10 });
  ledger.save(first);
  ledger.save(second);
  const receipt = request("receive", "allocated-to-correct", { quantity: 5 });
  ledger.save(receipt);
  const third = request("order", "later-order-not-a-slot", { quantity: 20 });
  ledger.save(third);
  const latest = ledger.save(request("receive", "later-linked", { orderId: second.opId, quantity: 4 }));
  ledger.save(editRequest("later-order-edit", latest.orders.find(order => order.id === second.opId), {
    quantity: 12, orderDate: "2026-11-26", note: "確認済み",
  }));
  const original = ledger.read().history.find(row => row.id === receipt.opId);
  const correction = correctionRequest("correct-allocated-receipt", original, 12);
  assert.deepEqual(CastingStock.previewQuantityCorrection(original, 12).orderChanges, [{
    orderId: second.opId, date: "2026-11-26", receivedBefore: 4, receivedAfter: 11, remainingBefore: 8, remainingAfter: 1,
  }]);
  const corrected = ledger.save(correction);
  assert.equal(stockAt(corrected, "raw"), 51);
  assert.deepEqual(corrected.orders.map(({ id, received, remaining, note }) => ({ id, received, remaining, note })), [
    { id: second.opId, received: 11, remaining: 1, note: "確認済み" },
    { id: third.opId, received: 0, remaining: 20, note: "" },
  ]);
  assert.equal(corrected.completedOrders[0].id, first.opId);
  const unplannedEdited = ledger.save(correctionRequest("correct-unplanned", corrected.history.find(row => row.id === unplanned.opId), 3));
  assert.equal(stockAt(unplannedEdited, "raw"), 52);
  assert.deepEqual(unplannedEdited.orders, corrected.orders);
  const reduced = ledger.save(correctionRequest("reduce-original-receipt", unplannedEdited.history.find(row => row.id === receipt.opId), 3));
  assert.equal(stockAt(reduced, "raw"), 43);
  assert.deepEqual(reduced.orders.map(({ received, remaining }) => [received, remaining]), [[3, 2], [4, 8], [0, 20]]);
  assert.deepEqual(ledger.read(), reduced);
});

test("corrected quantities keep an explicit short closure and undo reopens the actual remainder", () => {
  const ledger = historyFor();
  const ordered = ledger.save(request("order", "order-for-correction", { quantity: 12 })).orders[0];
  const partial = request("receive", "earlier-partial-to-change", { quantity: 3 });
  const awaiting = ledger.save(partial).orders[0];
  const closing = request("receive", "short-closing-to-change", {
    orderId: ordered.id, quantity: 5, expectedOrderRemainder: 9,
    expectedOrders: [{ id: ordered.id, revision: awaiting.revision }], completeOrder: true,
  });
  const closed = ledger.save(closing);
  const partialEdited = ledger.save(correctionRequest("correct-earlier-partial", closed.history.find(row => row.id === partial.opId), 4));
  const closingEdited = ledger.save(correctionRequest("correct-closing-receipt", partialEdited.history.find(row => row.id === closing.opId), 6));
  const correctedRecord = closingEdited.history.find(row => row.id === closing.opId);
  assert.equal(correctedRecord.undoOrderRemainder, 8);
  assert.equal(correctedRecord.undoOrderReceived, 6);
  assert.deepEqual(closingEdited.orders, []);
  assert.deepEqual(closingEdited.completedOrders.map(({ received, shortClosed }) => [received, shortClosed]), [[10, true]]);
  const undone = ledger.save(request("reverse", "undo-corrected-closure", { targetId: closing.opId }));
  assert.deepEqual(undone.orders.map(({ received, remaining }) => [received, remaining]), [[4, 8]]);
  assert.equal(stockAt(undone, "raw"), 37);
  assert.equal(undone.history[0].closedRemainder, 2);
  assert.deepEqual(ledger.read(), undone);
});

test("row notes are shared by revision and leave quantities and reversals available", () => {
  const ledger = historyFor();
  const used = ledger.save(request("use", "use-before-note", { quantity: 2 }));
  const correction = correctionRequest("correct-from-before-note", used.history[0], 3);
  const firstNote = request("setNote", "normal-note", { variant: "", expectedNoteRevision: "", note: "次回確認\n入荷時に確認" });
  const noted = ledger.save(firstNote);
  assert.deepEqual(noted.stock, used.stock);
  assert.deepEqual(noted.orders, used.orders);
  assert.equal(noted.history[0].canReverse, false);
  assert.equal(noted.history[1].canReverse, true);
  assert.deepEqual(ledger.save(firstNote), noted);
  const colorNote = request("setNote", "colored-note", { variant: "colored", expectedNoteRevision: "", note: "色しっぽの備考" });
  const withColor = ledger.save(colorNote);
  assert.deepEqual(withColor.notes, [firstNote, colorNote].map(({ opId, partId, variant, note }) => ({ partId, variant, note, revision: opId })));
  assert.throws(() => ledger.save(request("setNote", "stale-note", { variant: "", expectedNoteRevision: "", note: "共有メモ" })), /CASTING_STOCK_NOTE_CHANGED:/);
  assert.throws(() => ledger.save({ ...colorNote, partId: "lever", opId: "invalid-color-note" }), /加工区分を確認/);
  assert.throws(() => ledger.save({ ...colorNote, note: "あ".repeat(501), opId: "oversized-note" }), /500文字/);
  assert.deepEqual(ledger.read(), withColor);
  const corrected = ledger.save(correction);
  assert.equal(stockAt(corrected, "processed", "2F"), 14);
  const clear = request("setNote", "clear-normal-note", { variant: "", expectedNoteRevision: firstNote.opId, note: "" });
  const cleared = ledger.save(clear);
  assert.deepEqual(cleared.notes, [{ ...withColor.notes[0], note: "", revision: clear.opId }, withColor.notes[1]]);
  assert.deepEqual(ledger.read(), cleared);
});

const taLeverId = "legacy--5jUghc0ifJkDHKDawwaH7TodaDPNgDqKytiya8t474";
const taLeverSeed = {
  ...seed, fixedStorageFrom: 0,
  items: [{ id: taLeverId, name: "TAレバー", variants: [{ id: "single", label: "区分なし", threshold: 21 }] }],
  stock: [["1F", 45], ["2F", 4], ["保土田", 2]].map(([location, quantity]) => ({
    partId: taLeverId, variant: "single", location, quantity,
  })),
};
const taRequest = (type, id, values = {}) => request(type, id, { partId: taLeverId, ...values });
const taStock = (snapshot) => [stockAt(snapshot, "raw", "1F", taLeverId), stockAt(snapshot, "processed", "2F", taLeverId)];

test("TA lever keeps its recorded floors and supports processing, use, and reversal on the same item", () => {
  const ledger = historyFor(taLeverSeed);
  const notes = ledger.save(taRequest("setNote", "ta-row-note", { variant: "", note: "確認する", expectedNoteRevision: "" })).notes;
  assert.deepEqual(taStock(ledger.read()), [45, 6]);
  assert.deepEqual(ledger.read().items[0].variants.map(({ id, threshold }) => [id, threshold]), [["raw", 21], ["processed", null]]);
  const process = taRequest("process", "ta-process", { quantity: 7 });
  const processed = ledger.save(process);
  assert.deepEqual(taStock(processed), [38, 13]);
  assert.deepEqual(ledger.save(process), processed);
  const use = taRequest("use", "ta-use-processed", { quantity: 2 });
  assert.deepEqual(taStock(ledger.save(use)), [38, 11]);
  assert.deepEqual(taStock(ledger.save(taRequest("reverse", "undo-ta-use", { targetId: use.opId }))), [38, 13]);
  const restored = ledger.save(taRequest("reverse", "undo-ta-processing", { targetId: process.opId }));
  assert.deepEqual(taStock(restored), [45, 6]);
  assert.deepEqual(restored.notes, notes);
  assert.deepEqual(ledger.read(), restored);
});

test("TA lever replays older single-bucket use and receipts and retains their corrections and retry IDs", () => {
  const order = taRequest("order", "old-ta-order", { variant: "single", quantity: 20 });
  const receipt = taRequest("receive", "old-ta-receipt", { variant: "single", quantity: 6, orderId: order.opId,
    expectedOrderRemainder: 20, expectedOrders: [{ id: order.opId, revision: order.opId }] });
  const oldUse = taRequest("use", "old-ta-use", { variant: "single", quantity: 5 });
  const events = [order, receipt, oldUse].map(request => ({ ...metadata, request }));
  const ledger = historyFor(taLeverSeed, events);
  const previous = ledger.read();
  assert.deepEqual(taStock(previous), [52, 0]);
  assert.deepEqual(previous.orders.map(({ id, variant, received, remaining }) => [id, variant, received, remaining]), [[order.opId, "raw", 6, 14]]);
  assert.equal(previous.history[0].changes[0].variant, "single");
  assert.deepEqual(ledger.save({ ...oldUse, variant: undefined }), previous);
  assert.throws(() => ledger.save({ ...oldUse, opId: "stale-ta-use" }), /加工区分が更新/);
  assert.equal(ledger.events.length, 3);
  const delivered = ledger.save(taRequest("receive", "new-ta-receipt", { quantity: 2, orderId: order.opId }));
  assert.deepEqual(delivered.orders.map(({ received, remaining }) => [received, remaining]), [[8, 12]]);
  const count = taRequest("count", "new-ta-raw-count", { variant: "raw", expectedQuantity: 54, quantity: 52 });
  const counted = ledger.save(count);
  const corrected = ledger.save(correctionRequest("correct-old-ta-use", counted.history.find(row => row.id === oldUse.opId), 4));
  assert.equal(corrected.history[0].laterCountPreserved, true);
  assert.deepEqual(taStock(corrected), [52, 0]);
  const restored = ledger.save(taRequest("reverse", "undo-ta-count", { targetId: count.opId }));
  assert.deepEqual(taStock(restored), [55, 0]);
  assert.deepEqual(ledger.read(), restored);
});

test("an older corrected movement can be cancelled once while newer work stays active", () => {
  const ledger = historyFor();
  const use = request("use", "cancel-old-use", { quantity: 10 });
  ledger.save(use);
  const newer = request("process", "keep-newer-process", { quantity: 5 });
  const processed = ledger.save(newer);
  const old = processed.history.find(row => row.id === use.opId);
  const staleCancel = cancelRecord("stale-old-cancel", old);
  const corrected = ledger.save(correctionRequest("correct-before-cancel", old, 12));
  assert.throws(() => ledger.save(staleCancel), /CASTING_STOCK_RECORD_CHANGED/);
  const target = corrected.history.find(row => row.id === use.opId);
  assert.equal(target.canReverse, false);
  assert.deepEqual(target.cancellation.stockChanges, [{ variant: "processed", location: "2F", before: 10, after: 22 }]);
  const undo = cancelRecord("selected-old-use", target);
  const saved = ledger.save(undo);
  assert.equal(stockAt(saved, "processed", "2F"), 22);
  assert.equal(stockAt(saved, "raw"), 28);
  assert.equal(saved.history[0].type, "reverse");
  assert.equal(saved.history[0].quantity, 12);
  assert.equal(saved.history.find(row => row.id === use.opId).reversed, true);
  assert.equal(saved.history.find(row => row.id === newer.opId).reversed, false);
  assert.deepEqual(ledger.save(undo), saved);
  assert.equal(ledger.events.length, 4);
  assert.deepEqual(ledger.read(), saved);
});

test("a cancellation previews shortages and preserves a later physical count when safe", () => {
  const ledger = historyFor();
  const process = request("process", "old-colored-processed", { toVariant: "colored", quantity: 10 });
  ledger.save(process);
  const consumed = ledger.save(request("use", "colored-consumed", { variant: "colored", quantity: 12 }));
  const unavailable = consumed.history.find(row => row.id === process.opId);
  assert.match(unavailable.cancellationBlocked, /取り消し後の在庫が不足/);
  const attempt = request("reverseSelected", "shortage-cancellation", { targetId: process.opId, expectedRevision: consumed.history[0].id });
  assert.throws(() => ledger.save(attempt), /取り消し後の在庫が不足/);
  assert.deepEqual(ledger.read(), consumed);

  const count = request("count", "later-colored-count", { variant: "colored", expectedQuantity: 2, quantity: 5 });
  const counted = ledger.save(count);
  const entry = counted.history.find(row => row.id === process.opId);
  assert.equal(entry.cancellation.laterCountPreserved, true);
  assert.deepEqual(entry.cancellation.stockChanges, [{ variant: "raw", location: "1F", before: 23, after: 33 }]);
  const restored = ledger.save(cancelRecord("cancel-before-count", entry));
  assert.equal(stockAt(restored, "raw"), 33);
  assert.equal(stockAt(restored, "colored", "2F"), 5);
  assert.match(restored.history.find(row => row.id === count.opId).cancellationBlocked, /在庫が不足/);
  assert.deepEqual(ledger.read(), restored);
});

test("cancelling a past count keeps a later count and its future reversal correct", () => {
  const ledger = historyFor();
  const earlier = request("count", "undo-earlier-count", { variant: "raw", expectedQuantity: 33, quantity: 28 });
  ledger.save(earlier);
  ledger.save(request("sell", "keep-later-sale", { quantity: 2 }));
  const newer = request("count", "keep-later-count", { variant: "raw", expectedQuantity: 26, quantity: 30 });
  const result = ledger.save(newer);
  const cancelled = ledger.save(cancelRecord("drop-older-count", result.history.find(row => row.id === earlier.opId)));
  assert.equal(stockAt(cancelled, "raw"), 30);
  assert.equal(cancelled.history[0].laterCountPreserved, true);
  const restored = ledger.save(cancelRecord("later-count-undo", cancelled.history.find(row => row.id === newer.opId)));
  assert.equal(stockAt(restored, "raw"), 31);
  assert.deepEqual(ledger.read(), restored);
});

test("cancelling an older receipt respects later short completion, and cancelling that closure restores the remainder", () => {
  const ledger = historyFor();
  const order = ledger.save(request("order", "order-for-selected-undo", { quantity: 12 })).orders[0];
  const earlier = request("receive", "early-receipt-selected-undo", { quantity: 3, orderId: order.id });
  const partial = ledger.save(earlier).orders[0];
  const closing = request("receive", "closing-receipt-selected-undo", {
    quantity: 5, expectedOrderRemainder: 9, expectedOrders: [{ id: order.id, revision: partial.revision }], completeOrder: true,
  });
  ledger.save(closing);
  const later = ledger.save(request("sell", "sale-after-closure", { quantity: 1 }));
  assert.match(later.history.find(row => row.id === order.id).cancellationBlocked, /関連する入庫/);
  const oldReceipt = later.history.find(row => row.id === earlier.opId);
  assert.deepEqual(oldReceipt.cancellation.orderChanges.map(({ receivedBefore, receivedAfter, remainingAfter }) => [receivedBefore, receivedAfter, remainingAfter]), [[8, 5, 0]]);
  const cancelled = ledger.save(cancelRecord("cancel-earlier-receipt", oldReceipt));
  assert.equal(cancelled.completedOrders[0].received, 5);
  assert.equal(cancelled.completedOrders[0].shortClosed, true);
  const reopened = ledger.save(cancelRecord("cancel-older-closing", cancelled.history.find(row => row.id === closing.opId)));
  assert.equal(stockAt(reopened, "raw"), 32);
  assert.deepEqual(reopened.orders.map(({ received, remaining }) => [received, remaining]), [[0, 12]]);
  assert.deepEqual(ledger.read(), reopened);
});

test("cancelling an older edit preserves newer order terms and the original terms remain recoverable", () => {
  const ledger = historyFor();
  const purchase = ledger.save(request("order", "order-terms-for-cancel", { quantity: 10, note: "当初" })).orders[0];
  const earlier = editRequest("order-edit-older", purchase, { quantity: 15, note: "変更1" });
  const firstTerms = ledger.save(earlier).orders[0];
  const later = editRequest("order-edit-later", firstTerms, { quantity: 18, note: "変更2" });
  const edited = ledger.save(later);
  const undoOlder = ledger.save(cancelRecord("cancel-older-order-terms", edited.history.find(row => row.id === earlier.opId)));
  assert.deepEqual(undoOlder.orders, edited.orders);
  const restored = ledger.save(cancelRecord("cancel-later-order-terms", undoOlder.history.find(row => row.id === later.opId)));
  assert.deepEqual(restored.orders.map(({ quantity, note }) => [quantity, note]), [[10, "当初"]]);
  assert.deepEqual(ledger.read(), restored);
});
