/* Shared by Apps Script and the browser's local inventory. */
globalThis.CastingStock = (function () {
  "use strict";

  const LOCATIONS = Object.freeze(["1F", "2F", "保土田"]);
  const TA_LEVER_PART_ID = "legacy--5jUghc0ifJkDHKDawwaH7TodaDPNgDqKytiya8t474";
  const VARIANTS = ["raw", "processed", "colored", "single", "unclassified"];
  const STOCK_ACTIONS = ["use", "sell", "receive", "process", "classify", "transfer", "count"];
  const ACTIONS = [...STOCK_ACTIONS, "order", "editOrder", "cancelOrder", "reverse", "reverseSelected", "threshold", "correctQuantity", "setNote"];
  const HISTORY_LIMIT = 150;

  function fail(message) {
    throw new Error("CASTING_STOCK_INVALID: " + message);
  }

  function orderChanged() {
    throw new Error("CASTING_STOCK_ORDER_CHANGED: 最新の発注状況を確認してから記録してください。");
  }

  function recordChanged() {
    throw new Error("CASTING_STOCK_RECORD_CHANGED: この品目の記録が更新されました。最新の内容を確認してください。");
  }

  function requiredText(value, label) {
    if (typeof value !== "string" || !value.trim()) fail(label + "を指定してください。");
    return value.trim();
  }

  function quantity(value, allowZero = false, label = "数量") {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      fail(label + (allowZero ? "は0以上の整数" : "は1以上の整数") + "を入力してください。");
    }
    return value;
  }

  function date(value, label) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) {
      fail(label + "を正しい日付で入力してください。");
    }
    const parsed = new Date(value + "T00:00:00.000Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      fail(label + "を正しい日付で入力してください。");
    }
    return value;
  }

  function location(value) {
    if (!LOCATIONS.includes(value)) fail("保管場所を選択してください。");
    return value;
  }

  function operationId(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) fail("記録IDが正しくありません。画面を更新してください。");
    return value;
  }

  function dueDateFor(value, orderDate) {
    const dueDate = value ? date(value, "入荷予定日") : "";
    if (dueDate && dueDate < orderDate) fail("入荷予定日は発注日以降にしてください。");
    return dueDate;
  }

  function normalizeExpectedOrders(values) {
    if (!Array.isArray(values)) fail("確認時の発注情報を確認してください。");
    const orders = values.map(order => ({ id: operationId(order?.id), revision: operationId(order?.revision) }));
    if (new Set(orders.map(order => order.id)).size !== orders.length) fail("確認時の発注情報が重複しています。");
    return orders.sort((left, right) => left.id.localeCompare(right.id));
  }

  function unprocessedVariant(state, partId) {
    const item = state.items.get(partId);
    if (!item) fail("品目を確認してください。");
    return item.variants.some(variant => variant.id === "single") ? "single" : "raw";
  }

  function fixedLocation(variant) {
    return ["raw", "single"].includes(variant) ? "1F" : "2F";
  }

  function fixedRequestVariant(state, partId, input, legacyTaLever) {
    const unprocessed = legacyTaLever ? "single" : unprocessedVariant(state, partId);
    if (input.type === "use") {
      const allowed = unprocessed === "single" ? ["single"] : ["processed", "colored"];
      const variant = input.variant ?? allowed[0];
      if (!allowed.includes(variant)) fail("使用する加工済または未加工のまま使う品目を確認してください。");
      return variant;
    }
    if (["process", "order", "receive", "sell"].includes(input.type)) {
      const variant = input.type === "process" ? "raw" : unprocessed;
      if (input.variant != null && input.variant !== variant) fail("未加工の在庫を指定してください。画面を更新してから入力してください。");
      return variant;
    }
    const variant = requiredText(input.variant ?? (unprocessed === "single" ? "single" : ""), "加工区分");
    if (variant === "unclassified") fail("未加工または加工済の在庫を指定してください。");
    return variant;
  }

  function normalizeRequest(input, fixedState, legacyTaLever = false) {
    if (input?.type === "receiveAndComplete") input = { ...input, type: "receive", completeOrder: true };
    if (!input || !ACTIONS.includes(input.type)) fail("作業内容を選択してください。");
    const request = {
      opId: operationId(input.opId),
      type: input.type,
      date: date(input.date, "作業日"),
      note: typeof input.note === "string" ? input.note.trim() : "",
    };
    if (["reverse", "reverseSelected", "correctQuantity"].includes(input.type)) {
      request.targetId = operationId(input.targetId);
      if (input.type === "correctQuantity") request.quantity = quantity(input.quantity, true);
      if (input.type !== "reverse") request.expectedRevision = operationId(input.expectedRevision);
      return request;
    }
    if (input.type === "cancelOrder") {
      request.orderId = operationId(input.orderId);
      if (input.expectedOrderRevision !== undefined) request.expectedOrderRevision = operationId(input.expectedOrderRevision);
      return request;
    }
    if (input.type === "editOrder") {
      request.orderId = operationId(input.orderId);
      request.expectedOrderRevision = operationId(input.expectedOrderRevision);
      request.quantity = quantity(input.quantity, false, "発注数");
      request.orderDate = date(input.orderDate, "発注日");
      request.dueDate = dueDateFor(input.dueDate, request.orderDate);
      return request;
    }

    request.partId = requiredText(input.partId, "品目");
    if (input.type === "setNote") {
      if (input.variant !== "" && input.variant !== "colored") fail("備考を書く行を確認してください。");
      if (typeof input.note !== "string" || request.note.length > 500) fail("備考は500文字以内で入力してください。");
      request.variant = input.variant;
      request.expectedNoteRevision = input.expectedNoteRevision === "" ? "" : operationId(input.expectedNoteRevision);
      return request;
    }
    if (fixedState && ["classify", "transfer"].includes(input.type)) fail("在庫の区分は固定です。画面を更新してから在庫調整を行ってください。");
    request.variant = fixedState ? fixedRequestVariant(fixedState, request.partId, input, legacyTaLever) : requiredText(input.variant, "加工区分");
    if (input.type === "threshold") {
      request.threshold = input.threshold === null ? null : quantity(input.threshold, true, "発注点");
      return request;
    }

    request.quantity = quantity(input.quantity, input.type === "count");
    if ((input.type === "order" || input.type === "receive") && input.expectedOrderRemainder !== undefined) {
      request.expectedOrderRemainder = quantity(input.expectedOrderRemainder, true, "確認時の発注残");
    }
    if (input.type === "order") {
      request.dueDate = dueDateFor(input.dueDate, request.date);
      return request;
    }

    request.location = fixedState ? fixedLocation(request.variant) : location(input.location);
    if (input.type === "process" || input.type === "classify") {
      request.toVariant = requiredText(input.toVariant ?? (fixedState ? "processed" : undefined), "振り分け先の加工区分");
    }
    if (input.type === "process" || input.type === "transfer") request.toLocation = fixedState ? "2F" : location(input.toLocation);
    if (input.type === "receive") {
      if (input.orderId) request.orderId = operationId(input.orderId);
      if (input.expectedOrders !== undefined) request.expectedOrders = normalizeExpectedOrders(input.expectedOrders);
      if (input.confirmOverReceipt === true) request.confirmOverReceipt = true;
      if (input.completeOrder === true) request.completeOrder = true;
    }
    if (input.type === "count") request.expectedQuantity = quantity(input.expectedQuantity, true, "棚卸前の数量");
    return request;
  }

  function stockVariant(partId, variant) {
    return partId === TA_LEVER_PART_ID && variant === "single" ? "raw" : variant;
  }

  function stockKey(partId, variant, place) {
    return JSON.stringify([partId, stockVariant(partId, variant), place]);
  }

  function getPartVariant(state, partId, variantId) {
    const variant = state.items.get(partId)?.variants.find(entry => entry.id === stockVariant(partId, variantId));
    if (!variant) fail("品目または加工区分を確認してください。");
    return variant;
  }

  function initialState(seed, splitTaOpeningByLocation) {
    if (!seed || !Array.isArray(seed.items) || !seed.items.length || !Array.isArray(seed.stock) || !Number.isFinite(Date.parse(seed.initializedAt))) {
      fail("開始時の在庫データを確認してください。");
    }
    const state = { items: new Map(), stock: new Map(), orders: new Map(), notes: new Map(),
      activeByPart: new Map(), partRevisions: new Map(), history: new Map() };
    for (const item of seed.items) {
      const id = requiredText(item?.id, "品目ID");
      if (state.items.has(id) || !Array.isArray(item.variants) || !item.variants.length) fail("開始時の品目データを確認してください。");
      const variants = new Map();
      for (const variant of item.variants) {
        if (!VARIANTS.includes(variant?.id) || variants.has(variant.id)) fail("開始時の加工区分を確認してください。");
        variants.set(variant.id, {
          id: variant.id,
          label: requiredText(variant.label, "加工区分名"),
          threshold: variant.threshold === null ? null : quantity(variant.threshold, true, "発注点"),
        });
      }
      const previousTaVariant = id === TA_LEVER_PART_ID && variants.get("single");
      if (previousTaVariant) {
        if (variants.has("raw") || variants.has("processed")) fail("TAレバーの開始時の加工区分を確認してください。");
        // Keep the old single bucket readable for historical operations.
        variants.delete("single");
        variants.set("raw", { id: "raw", label: "未加工", threshold: previousTaVariant.threshold });
        variants.set("processed", { id: "processed", label: "加工済", threshold: null });
      }
      state.items.set(id, { ...item, id, name: requiredText(item.name, "品目名"), variants: [...variants.values()] });
      state.activeByPart.set(id, []);
    }
    for (const balance of seed.stock) {
      if (!balance) fail("開始時の在庫データを確認してください。");
      const place = location(balance.location);
      const variant = splitTaOpeningByLocation && isLegacyTaLever(balance) && place !== "1F"
        ? "processed" : stockVariant(balance.partId, balance.variant);
      getPartVariant(state, balance.partId, variant);
      const key = stockKey(balance.partId, variant, place);
      if (state.stock.has(key)) fail("開始時の在庫に同じ品目と保管場所が重複しています。");
      state.stock.set(key, { ...balance, variant, location: place,
        quantity: quantity(balance.quantity, true, "開始時の在庫数") });
    }
    if (seed.openingOrders !== undefined && !Array.isArray(seed.openingOrders)) fail("開始時の発注データを確認してください。");
    for (const order of seed.openingOrders || []) {
      const input = normalizeRequest({ ...order, type: "order", opId: order?.id });
      addOrder(state, { ...input, id: input.opId });
    }
    return state;
  }

  function fixedBalance(state, partId, variant, place) {
    variant = stockVariant(partId, variant);
    if (variant === "unclassified") {
      getPartVariant(state, partId, "raw");
      getPartVariant(state, partId, "processed");
      variant = place === "1F" ? "raw" : "processed";
    }
    return { variant, location: fixedLocation(variant) };
  }

  function enableFixedStorage(state) {
    const stock = new Map();
    for (const row of state.stock.values()) {
      const { variant, location: place } = fixedBalance(state, row.partId, row.variant, row.location);
      const key = stockKey(row.partId, variant, place);
      const quantity = (stock.get(key)?.quantity ?? 0) + row.quantity;
      if (!Number.isSafeInteger(quantity)) fail("在庫数が上限を超えています。数量を確認してください。");
      stock.set(key, { ...row, variant, location: place, quantity });
    }
    state.stock = stock;
    // An older cancellation or receipt can be reversed after the transition.
    for (const order of state.orders.values()) {
      order.variant = unprocessedVariant(state, order.partId);
      getPartVariant(state, order.partId, order.variant);
    }
    state.fixedStorage = true;
  }

  function changeStock(state, row, variant, place, delta) {
    const key = stockKey(row.partId, variant, place);
    const before = state.stock.get(key)?.quantity ?? 0;
    const after = before + delta;
    if (after < 0) fail(state.fixedStorage ? "在庫が不足しています。加工区分と数量を確認してください。" : "選択した保管場所の在庫が不足しています。加工区分と数量を確認してください。");
    if (!Number.isSafeInteger(after)) fail("在庫数が上限を超えています。数量を確認してください。");
    state.stock.set(key, { partId: row.partId, variant: stockVariant(row.partId, variant), location: place, quantity: after });
    row.changes.push({ variant, location: place, before, after });
  }

  function addOrder(state, row) {
    getPartVariant(state, row.partId, row.variant);
    if (row.variant === "unclassified") fail("発注する品目の加工区分を選択してください。");
    if (state.orders.has(row.id)) fail("鋳物在庫の発注IDが重複しています。");
    state.orders.set(row.id, {
      id: row.id, partId: row.partId, variant: stockVariant(row.partId, row.variant), quantity: row.quantity,
      received: 0, remaining: row.quantity, date: row.date, dueDate: row.dueDate,
      note: row.note, revision: row.id, cancelled: false,
    });
  }

  function findOrder(state, id, expectedRevision) {
    const order = state.orders.get(id);
    if (expectedRevision !== undefined && order?.revision !== expectedRevision) orderChanged();
    return order;
  }

  function openOrder(state, id, expectedRevision) {
    const order = findOrder(state, id, expectedRevision);
    if (!order || order.cancelled || order.remaining === 0) fail("入荷待ちの発注が見つかりません。画面を更新してください。");
    return order;
  }

  function updateOrderBalance(order, revision) {
    order.remaining = order.shortClosed ? 0 : Math.max(0, order.quantity - order.received);
    order.revision = revision;
  }

  function recordOrderReceipt(order, amount, revision) {
    const received = order.received + amount;
    if (!Number.isSafeInteger(received) || received < 0) fail("発注の実入庫数を確認してください。");
    order.received = received;
    updateOrderBalance(order, revision);
  }

  function changeOrderDetails(order, row, details) {
    row.previousOrder = { quantity: order.quantity, date: order.date, dueDate: order.dueDate, note: order.note };
    Object.assign(order, details);
    updateOrderBalance(order, row.id);
  }

  function editOrder(state, row) {
    const order = findOrder(state, row.orderId, row.expectedOrderRevision);
    if (!order || order.cancelled) fail("変更できる発注が見つかりません。画面を更新してください。");
    Object.assign(row, { partId: order.partId, variant: order.variant });
    changeOrderDetails(order, row, { quantity: row.quantity, date: row.orderDate, dueDate: row.dueDate, note: row.note });
  }

  function pendingOrderMatches(order, row) {
    return order && order.partId === row.partId && order.variant === stockVariant(row.partId, row.variant) && !order.cancelled && order.remaining > 0;
  }

  function pendingOrdersFor(state, row) {
    const orders = row.orderId ? [state.orders.get(row.orderId)] : state.orders.values();
    return Array.from(orders).filter(order => pendingOrderMatches(order, row));
  }

  function reviewedOrderRemainder(row, orders) {
    const remainder = orders.reduce((sum, order) => sum + order.remaining, 0);
    const expected = row.expectedOrderRemainder;
    if (expected !== undefined &&
        (remainder !== expected || (row.type === "order" && expected !== 0) || (row.orderId && expected === 0))) {
      orderChanged();
    }
    if (row.expectedOrders !== undefined) {
      const revisions = new Map(row.expectedOrders.map(({ id, revision }) => [id, revision]));
      if (revisions.size !== orders.length || orders.some(order => revisions.get(order.id) !== order.revision)) orderChanged();
    }
    return remainder;
  }

  function processMovement(state, row) {
    if (row.type === "process") {
      if (row.variant !== "raw" || !["processed", "colored"].includes(row.toVariant)) fail("未加工から加工済への振替を指定してください。");
      getPartVariant(state, row.partId, row.toVariant);
    }
    if (row.type === "classify") {
      if (row.variant !== "unclassified" || row.toVariant === "unclassified") fail("区分未確認の在庫と振り分け先を指定してください。");
      getPartVariant(state, row.partId, row.toVariant);
      row.toLocation = row.location;
    }
    if (row.type === "transfer") {
      if (row.location === row.toLocation) fail("現在と異なる保管場所を選択してください。");
      row.toVariant = row.variant;
    }
    changeStock(state, row, row.variant, row.location, -row.quantity);
    changeStock(state, row, row.toVariant, row.toLocation, row.quantity);
  }

  function receiveStock(state, row) {
    if (row.variant === "unclassified") fail("入庫する品目の加工区分を選択してください。");
    const pending = pendingOrdersFor(state, row);
    const remainder = reviewedOrderRemainder(row, pending);
    const order = row.orderId && openOrder(state, row.orderId);
    if (order && !pendingOrderMatches(order, row)) fail("発注した品目と加工区分を確認してください。");
    if (row.completeOrder) {
      if (pending.length !== 1 || row.expectedOrderRemainder === undefined || row.expectedOrders?.length !== 1) orderChanged();
      if (row.quantity >= remainder) fail("不足のまま完了するには、入庫数を発注残より少なくしてください。");
      row.closedRemainder = remainder - row.quantity;
    }
    const reviewed = row.expectedOrderRemainder !== undefined || row.expectedOrders !== undefined;
    if ((order || reviewed) && remainder > 0 && row.quantity > remainder && !row.confirmOverReceipt) {
      fail("入庫数が発注残を超えています。入庫する数量を確認してください。");
    }
    changeStock(state, row, row.variant, row.location, row.quantity);
    const matching = state.fixedStorage || order || row.completeOrder
      ? pending.sort((left, right) => left.date.localeCompare(right.date))
      : [];
    // Keep the original allocation choices so a later correction cannot be attached to a new order.
    const receiptSlots = matching.map(purchase => ({
      orderId: purchase.id,
      capacity: purchase.remaining,
      trackExcess: matching.length === 1 && (row.confirmOverReceipt === true || row.quantity <= purchase.remaining),
    }));
    const allocations = [];
    const receipts = [];
    let unallocated = row.quantity;
    for (const purchase of matching) {
      if (!unallocated) break;
      const allocated = Math.min(purchase.remaining, unallocated);
      const received = row.confirmOverReceipt && matching.length === 1 ? row.quantity : allocated;
      if (row.completeOrder) purchase.shortClosed = true;
      recordOrderReceipt(purchase, received, row.id);
      unallocated -= allocated;
      allocations.push({ orderId: purchase.id, quantity: allocated });
      receipts.push({ orderId: purchase.id, quantity: received });
    }
    if (row.confirmOverReceipt && matching.length && unallocated > 0) row.excessQuantity = unallocated;
    if (state.fixedStorage || row.confirmOverReceipt || row.completeOrder) row.orderAllocations = allocations;
    return { receipts, receiptSlots };
  }

  function stockBucket(state, partId, change, fixed = state.fixedStorage) {
    return fixed ? fixedBalance(state, partId, change.variant, change.location)
      : { variant: stockVariant(partId, change.variant), location: change.location };
  }

  function addStockEffect(effects, partId, { variant, location: place }, delta) {
    const key = stockKey(partId, variant, place);
    const sum = (effects.get(key)?.delta ?? 0) + delta;
    if (!Number.isSafeInteger(sum)) fail("在庫の増減数が上限を超えています。数量を確認してください。");
    effects.set(key, { variant, location: place, delta: sum });
  }

  function stockCorrectionContext(state, recorded, counts) {
    const { row, index } = recorded;
    const effects = new Map();
    const components = row.changes.map(change => {
      const factor = row.type === "count" ? 1 : Math.sign(change.after - change.before);
      const absorbingCount = counts.find(count => {
        if (count.index <= index) return false;
        const bucket = stockBucket(state, row.partId, change, count.fixedStorage);
        const measured = stockBucket(state, row.partId, count.row, count.fixedStorage);
        return measured.variant === bucket.variant && measured.location === bucket.location;
      });
      if (!absorbingCount) addStockEffect(effects, row.partId, stockBucket(state, row.partId, change), factor);
      return { change, factor, absorbingCount };
    });
    const stock = [...effects.entries()].filter(([, effect]) => effect.delta !== 0).map(([key, effect]) => ({
      variant: effect.variant, location: effect.location, factor: effect.delta, before: state.stock.get(key)?.quantity ?? 0,
    }));
    return { components, stock, laterCountPreserved: components.some(component => component.absorbingCount) };
  }

  function activeCounts(state, partId) {
    return state.activeByPart.get(partId).filter(row => row.type === "count").map(row => state.history.get(row.id));
  }

  function quantityCorrectionContext(state, recorded, counts) {
    const { row } = recorded;
    const { components, stock, laterCountPreserved } = stockCorrectionContext(state, recorded, counts);
    const orders = (recorded.receiptSlots || []).map(slot => {
      const order = state.orders.get(slot.orderId);
      const applied = recorded.receipts.find(receipt => receipt.orderId === order.id)?.quantity ?? 0;
      return { ...slot, applied, date: order.date, quantity: order.quantity, received: order.received,
        remaining: order.cancelled ? 0 : order.remaining, closed: Boolean(order.cancelled || order.shortClosed) };
    });
    return { components, correction: { quantity: recorded.correctedQuantity ?? row.quantity,
      expectedRevision: state.partRevisions.get(row.partId), stock, orders, laterCountPreserved } };
  }

  function correctionPlan(entry, newQuantity) {
    if (!entry?.correction) fail("この記録は数量を訂正できません。履歴を確認してください。");
    const amount = quantity(newQuantity, entry.type === "count");
    const { correction } = entry;
    const difference = amount - correction.quantity;
    const stockChanges = stockChangesForDifference(correction.stock, difference, "訂正");

    const allocations = [];
    const receipts = [];
    const orderChanges = [];
    let unallocated = amount;
    for (const order of correction.orders) {
      const allocated = Math.min(unallocated, order.capacity);
      const received = order.trackExcess ? unallocated : allocated;
      unallocated -= allocated;
      if (allocated) allocations.push({ orderId: order.orderId, quantity: allocated });
      if (received) receipts.push({ orderId: order.orderId, quantity: received });
      if (received === order.applied) continue;
      const after = order.received + (received - order.applied);
      if (!Number.isSafeInteger(after) || after < 0) fail("発注の実入庫数を確認してください。");
      orderChanges.push({ orderId: order.orderId, date: order.date, receivedBefore: order.received, receivedAfter: after,
        remainingBefore: order.remaining, remainingAfter: order.closed ? 0 : Math.max(0, order.quantity - after) });
    }
    return { stockChanges, orderChanges, allocations, receipts, difference, laterCountPreserved: correction.laterCountPreserved };
  }

  function stockChangesForDifference(stock, difference, operation) {
    return stock.map(({ variant, location: place, factor, before }) => {
      const after = before + factor * difference;
      if (after < 0) fail(operation + "後の在庫が不足します。現在庫を確認してください。");
      if (!Number.isSafeInteger(after)) fail("在庫数が上限を超えています。数量を確認してください。");
      return { variant, location: place, before, after };
    }).filter(change => change.before !== change.after);
  }

  function previewQuantityCorrection(entry, newQuantity) {
    const { stockChanges, orderChanges, laterCountPreserved } = correctionPlan(entry, newQuantity);
    return { stockChanges, orderChanges, laterCountPreserved };
  }

  function addStockCorrection(recorded, bucket, delta) {
    if (!recorded.stockCorrections) recorded.stockCorrections = new Map();
    addStockEffect(recorded.stockCorrections, recorded.row.partId, bucket, delta);
  }

  function applyStockCorrection(state, row, components, stockChanges, difference, recorded) {
    for (const { variant, location: place, before, after } of stockChanges) {
      changeStock(state, row, variant, place, after - before);
    }
    for (const { change, factor, absorbingCount } of components) {
      const delta = factor * difference;
      if (recorded) addStockCorrection(recorded, change, delta);
      // A later physical count fixes that balance. Undoing it exposes the effective earlier balance.
      if (absorbingCount) addStockCorrection(absorbingCount, absorbingCount.row, -delta);
    }
  }

  function correctQuantity(state, row) {
    const recorded = state.history.get(row.targetId);
    const target = recorded?.row;
    if (!target || target.reversed || !STOCK_ACTIONS.includes(target.type) ||
        state.partRevisions.get(target.partId) !== row.expectedRevision) recordChanged();
    const { correction, components } = quantityCorrectionContext(state, recorded, activeCounts(state, target.partId));
    const plan = correctionPlan({ type: target.type, correction }, row.quantity);
    if (plan.difference === 0) fail("変更する数量を入力してください。");
    Object.assign(row, { partId: target.partId, variant: target.variant, location: target.location, toVariant: target.toVariant,
      targetType: target.type, targetDate: target.date, previousQuantity: correction.quantity });
    applyStockCorrection(state, row, components, plan.stockChanges, plan.difference, recorded);
    if (target.type === "receive") {
      for (const order of plan.orderChanges) {
        recordOrderReceipt(state.orders.get(order.orderId), order.receivedAfter - order.receivedBefore, row.id);
      }
      recorded.receipts = plan.receipts;
      recorded.correctedAllocations = plan.allocations;
      if (plan.orderChanges.length) row.orderChanges = plan.orderChanges;
    }
    if (plan.laterCountPreserved) row.laterCountPreserved = true;
    recorded.correctedQuantity = row.quantity;
  }

  function setStockNote(state, row) {
    if (!state.items.has(row.partId)) fail("品目を確認してください。");
    if (row.variant) getPartVariant(state, row.partId, row.variant);
    const key = JSON.stringify([row.partId, row.variant]);
    const current = state.notes.get(key);
    if ((current?.revision ?? "") !== row.expectedNoteRevision) {
      throw new Error("CASTING_STOCK_NOTE_CHANGED: この備考が更新されました。最新の内容を確認してください。");
    }
    if ((current?.note ?? "") === row.note) fail("変更する備考を入力してください。");
    state.notes.set(key, { partId: row.partId, variant: row.variant, note: row.note, revision: row.id });
  }

  function reverseStockChanges(state, row, recorded) {
    const balances = new Map();
    for (const change of recorded.row.changes) {
      addStockEffect(balances, row.partId, stockBucket(state, row.partId, change), change.before - change.after);
    }
    for (const effect of recorded.stockCorrections?.values() || []) {
      addStockEffect(balances, row.partId, stockBucket(state, row.partId, effect), -effect.delta);
    }
    for (const { variant, location: place, delta } of balances.values()) {
      if (delta) changeStock(state, row, variant, place, delta);
    }
  }

  function nextActiveRecord(state, recorded, matches) {
    for (const row of state.activeByPart.get(recorded.row.partId)) {
      const candidate = state.history.get(row.id);
      if (candidate.index > recorded.index && matches(candidate)) return candidate;
    }
    return null;
  }

  function cancellationOrderChange(order, receivedAfter, remainingAfter) {
    return { orderId: order.id, date: order.date, receivedBefore: order.received, receivedAfter,
      remainingBefore: order.cancelled ? 0 : order.remaining, remainingAfter };
  }

  function cancellationPlan(state, recorded, counts) {
    const target = recorded.row;
    const plan = { stockChanges: [], orderChanges: [], laterCountPreserved: false, components: [], difference: 0 };
    if (STOCK_ACTIONS.includes(target.type)) {
      if (target.openingWasUnconfirmed && nextActiveRecord(state, recorded, later => STOCK_ACTIONS.includes(later.row.type))) {
        fail("初回登録の後に在庫操作があります。関連する記録を先に確認してください。");
      }
      const { stock, components, laterCountPreserved } = stockCorrectionContext(state, recorded, counts);
      let difference = -(recorded.correctedQuantity ?? target.quantity);
      if (target.type === "count") {
        const change = target.changes[0];
        const adjustments = [...(recorded.stockCorrections?.values() || [])].reduce((sum, effect) => sum + effect.delta, 0);
        difference = change.before - change.after - adjustments;
      }
      if (!Number.isSafeInteger(difference)) fail("在庫の増減数が上限を超えています。数量を確認してください。");
      Object.assign(plan, { components, difference, stockChanges: stockChangesForDifference(stock, difference, "取り消し"), laterCountPreserved });
    }
    if (target.type === "receive") {
      for (const receipt of recorded.receipts) {
        const order = state.orders.get(receipt.orderId);
        const received = order.received - receipt.quantity;
        const remaining = order.cancelled || (order.shortClosed && !target.completeOrder) ? 0 : Math.max(0, order.quantity - received);
        plan.orderChanges.push(cancellationOrderChange(order, received, remaining));
      }
    }
    if (target.type === "order") {
      const order = state.orders.get(target.id);
      const dependent = nextActiveRecord(state, recorded, later => later.row.orderId === target.id ||
        later.receiptSlots?.some(slot => slot.orderId === target.id));
      if (!order || order.received || order.cancelled || dependent) {
        fail("この発注に関連する入庫・発注変更・残数の取消を確認してください。");
      }
      plan.orderChanges.push(cancellationOrderChange(order, 0, 0));
    }
    if (target.type === "cancelOrder") {
      const order = state.orders.get(target.orderId);
      plan.orderChanges.push(cancellationOrderChange(order, order.received, order.remaining));
    }
    if (target.type === "editOrder") {
      plan.nextChange = nextActiveRecord(state, recorded, later => later.row.type === "editOrder" && later.row.orderId === target.orderId);
      if (!plan.nextChange) {
        const order = state.orders.get(target.orderId);
        const restored = recorded.restoredOrder ?? target.previousOrder;
        const remaining = order.cancelled || order.shortClosed ? 0 : Math.max(0, restored.quantity - order.received);
        plan.orderChanges.push(cancellationOrderChange(order, order.received, remaining));
      }
    }
    if (target.type === "threshold") {
      const variant = stockVariant(target.partId, target.variant);
      plan.nextChange = nextActiveRecord(state, recorded, later => later.row.type === "threshold" && stockVariant(target.partId, later.row.variant) === variant);
    }
    return plan;
  }

  function reverseRecord(state, row, selected = false) {
    const recorded = state.history.get(row.targetId);
    const target = recorded?.row;
    const active = target && state.activeByPart.get(target.partId);
    let plan;
    if (selected) {
      if (!active?.includes(target) || state.partRevisions.get(target.partId) !== row.expectedRevision) recordChanged();
      plan = cancellationPlan(state, recorded, activeCounts(state, target.partId));
    } else if (!active || active[active.length - 1] !== target) {
      fail("その記録を取り消せません。同じ品目の新しい記録から確認してください。");
    }
    row.partId = target.partId;
    row.variant = target.variant;
    row.location = target.location;
    row.quantity = recorded.correctedQuantity ?? target.quantity;
    row.orderId = target.orderId;
    row.targetType = target.type;
    if (target.type === "order") {
      const order = openOrder(state, target.id);
      if (order.received) fail("発注を取り消す前に、ひも付いた入庫を取り消してください。");
      state.orders.delete(target.id);
      row.orderId = target.id;
    }
    if (target.type === "cancelOrder") {
      const order = state.orders.get(target.orderId);
      order.cancelled = false;
      order.revision = row.id;
      row.quantity = order.remaining;
    }
    if (target.type === "editOrder") {
      const restored = recorded.restoredOrder ?? target.previousOrder;
      if (plan?.nextChange) {
        plan.nextChange.restoredOrder = restored;
      } else {
        changeOrderDetails(state.orders.get(target.orderId), row, restored);
        Object.assign(row, { quantity: restored.quantity, orderDate: restored.date, dueDate: restored.dueDate, note: restored.note });
      }
    }
    if (target.type === "receive") {
      for (const { orderId, quantity } of recorded.receipts) {
        const order = state.orders.get(orderId);
        if (target.completeOrder) delete order.shortClosed;
        recordOrderReceipt(order, -quantity, row.id);
        if (target.completeOrder && order.remaining > quantity) row.closedRemainder = order.remaining - quantity;
      }
      if (state.fixedStorage || target.confirmOverReceipt || target.completeOrder) {
        row.orderAllocations = recorded.correctedAllocations || target.orderAllocations || recorded.receipts;
      }
      const excess = recorded.correctedAllocations
        ? row.quantity - recorded.correctedAllocations.reduce((sum, allocation) => sum + allocation.quantity, 0)
        : target.excessQuantity;
      if (excess > 0 && recorded.receiptSlots.length) row.excessQuantity = excess;
    }
    if (target.type === "threshold") {
      const restored = recorded.restoredThreshold === undefined ? target.previousThreshold : recorded.restoredThreshold;
      if (plan?.nextChange) plan.nextChange.restoredThreshold = restored;
      else {
        getPartVariant(state, target.partId, target.variant).threshold = restored;
        row.threshold = restored;
      }
    }
    if (target.openingWasUnconfirmed) state.items.get(target.partId).openingUnconfirmed = true;
    if (plan) {
      applyStockCorrection(state, row, plan.components, plan.stockChanges, plan.difference);
      row.targetDate = target.date;
      if (plan.orderChanges.length) row.orderChanges = plan.orderChanges;
      if (plan.laterCountPreserved) row.laterCountPreserved = true;
    } else {
      reverseStockChanges(state, row, recorded);
    }
    target.reversed = true;
    active.splice(active.indexOf(target), 1);
  }

  function isLegacyTaLever(request) {
    return request?.partId === TA_LEVER_PART_ID && request.variant === "single";
  }

  function record(state, event) {
    if (!event || !Number.isFinite(Date.parse(event.createdAt)) || typeof event.actor !== "string") fail("鋳物在庫の記録日時または操作者を確認してください。");
    const input = normalizeRequest(event.request, state.fixedStorage ? state : undefined, isLegacyTaLever(event.request));
    if (state.history.has(input.opId) || state.orders.has(input.opId)) fail("鋳物在庫の記録IDが重複しています。");
    const row = { ...input, id: input.opId, createdAt: event.createdAt, actor: event.actor, changes: [], reversed: false };
    delete row.opId;
    let receipt;

    if (row.type === "reverseSelected") {
      row.type = "reverse";
      reverseRecord(state, row, true);
    } else if (row.type === "reverse") {
      reverseRecord(state, row);
    } else if (row.type === "correctQuantity") {
      correctQuantity(state, row);
    } else if (row.type === "setNote") {
      setStockNote(state, row);
    } else if (row.type === "cancelOrder") {
      const order = openOrder(state, row.orderId, row.expectedOrderRevision);
      Object.assign(row, { partId: order.partId, variant: order.variant, quantity: order.remaining });
      order.cancelled = true;
      order.revision = row.id;
    } else if (row.type === "editOrder") {
      editOrder(state, row);
    } else {
      const variant = getPartVariant(state, row.partId, row.variant);
      const item = state.items.get(row.partId);
      if (item.openingUnconfirmed && STOCK_ACTIONS.includes(row.type) && row.type !== "count") {
        fail("最初に棚卸で現在庫を登録してください。");
      }
      switch (row.type) {
        case "use":
        case "sell":
          if (row.type === "sell" && !["raw", "single"].includes(row.variant)) fail("販売は未加工または加工区分のない品目から記録してください。");
          changeStock(state, row, row.variant, row.location, -row.quantity);
          break;
        case "receive":
          receipt = receiveStock(state, row);
          break;
        case "process":
        case "classify":
        case "transfer":
          processMovement(state, row);
          break;
        case "order":
          if (row.expectedOrderRemainder !== undefined) reviewedOrderRemainder(row, pendingOrdersFor(state, row));
          addOrder(state, row);
          break;
        case "threshold":
          if (row.variant === "unclassified") fail("発注点を設定する加工区分を選択してください。");
          row.previousThreshold = variant.threshold;
          variant.threshold = row.threshold;
          break;
        case "count": {
          const before = state.stock.get(stockKey(row.partId, row.variant, row.location))?.quantity ?? 0;
          if (before !== row.expectedQuantity) fail("別の端末でこの在庫が更新されました。画面を更新してから棚卸してください。");
          changeStock(state, row, row.variant, row.location, row.quantity - before);
          if (item.openingUnconfirmed) {
            row.openingWasUnconfirmed = true;
            item.openingUnconfirmed = false;
          }
          break;
        }
      }
    }
    if (!["reverse", "correctQuantity", "setNote"].includes(row.type)) state.activeByPart.get(row.partId).push(row);
    if (row.type !== "setNote") state.partRevisions.set(row.partId, row.id);
    state.history.set(row.id, { row, input, fixedStorage: Boolean(state.fixedStorage), index: state.history.size, ...receipt });
  }

  function replay(seed, events) {
    const boundary = seed?.fixedStorageFrom;
    if (!Array.isArray(events) || (boundary !== undefined &&
      (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > events.length))) {
      fail("在庫の保管場所を統合した時点を確認してください。");
    }
    // Use the recorded floors when no legacy TA operation has changed the single balance.
    const splitTaOpeningByLocation = !events.some(event => isLegacyTaLever(event?.request) &&
      (STOCK_ACTIONS.includes(event.request.type) || event.request.type === "receiveAndComplete"));
    const state = initialState(seed, splitTaOpeningByLocation);
    for (let index = 0; index < events.length; index += 1) {
      if (index === boundary) enableFixedStorage(state);
      record(state, events[index]);
    }
    if (boundary === events.length) enableFixedStorage(state);
    return state;
  }

  function historyRows(state, partId) {
    const history = [];
    const countsByPart = new Map();
    for (const recorded of [...state.history.values()].reverse()) {
      const { row, correctedQuantity } = recorded;
      if (partId !== undefined && row.partId !== partId) continue;
      const active = state.activeByPart.get(row.partId);
      const canReverse = active[active.length - 1] === row;
      if (partId === undefined && history.length >= HISTORY_LIMIT && !canReverse) continue;
      const entry = { ...row, canReverse };
      if (correctedQuantity !== undefined) entry.correctedQuantity = correctedQuantity;
      if (!row.reversed && STOCK_ACTIONS.includes(row.type)) {
        if (!countsByPart.has(row.partId)) countsByPart.set(row.partId, activeCounts(state, row.partId));
        entry.correction = quantityCorrectionContext(state, recorded, countsByPart.get(row.partId)).correction;
        if (canReverse && row.completeOrder) {
          const receipt = recorded.receipts[0];
          const order = state.orders.get(receipt.orderId);
          entry.undoOrderReceived = correctedQuantity ?? row.quantity;
          entry.undoOrderRemainder = Math.max(0, order.quantity - (order.received - receipt.quantity));
        }
      }
      if (!row.reversed && !["reverse", "correctQuantity", "setNote"].includes(row.type)) {
        try {
          const { stockChanges, orderChanges, laterCountPreserved } = cancellationPlan(state, recorded, countsByPart.get(row.partId));
          entry.cancellation = { expectedRevision: state.partRevisions.get(row.partId), stockChanges, orderChanges, laterCountPreserved };
        } catch (error) {
          const prefix = "CASTING_STOCK_INVALID: ";
          if (!error.message.startsWith(prefix)) throw error;
          entry.cancellationBlocked = error.message.slice(prefix.length);
        }
      }
      history.push(entry);
    }
    return history;
  }

  function snapshot(seed, state) {
    const stock = [...state.stock.values()];
    let inventoryTotal = 0;
    for (const balance of stock) inventoryTotal += balance.quantity;
    if (!Number.isSafeInteger(inventoryTotal)) fail("在庫合計が上限を超えています。数量を確認してください。");

    const orders = [];
    const completedOrders = [];
    for (const { cancelled, ...order } of state.orders.values()) {
      if (cancelled) continue;
      (order.remaining > 0 ? orders : completedOrders).push(order);
    }
    const result = {
      initialized: true,
      initializedAt: seed.initializedAt,
      sourceUrl: seed.sourceUrl,
      items: [...state.items.values()],
      stock,
      orders,
      completedOrders,
      notes: [...state.notes.values()],
      history: historyRows(state),
      revision: state.history.size + (state.fixedStorage ? 2 : 1),
    };
    if (state.fixedStorage) result.fixedStorage = true;
    return result;
  }

  function project(seed, events) {
    return snapshot(seed, replay(seed, events));
  }

  function historyForPart(seed, events, partId) {
    const id = requiredText(partId, "品目");
    return historyRows(replay(seed, events), id);
  }

  function apply(seed, events, input, metadata) {
    const state = replay(seed, events);
    const existing = state.history.get(input?.opId);
    if (!existing && isLegacyTaLever(input)) fail("TAレバーの加工区分が更新されました。画面を更新してから入力してください。");
    const fixed = existing ? existing.fixedStorage : state.fixedStorage;
    const request = normalizeRequest(input, fixed ? state : undefined, isLegacyTaLever(existing?.input));
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(request)) fail("同じ記録IDで異なる内容を保存できません。画面を更新してから入力してください。");
      return { event: null, snapshot: snapshot(seed, state) };
    }
    // A receipt without an order ID allocates against the orders at its position in the ledger.
    // A distinct stored type makes older deployments reject unfamiliar completion records.
    const storedRequest = request.completeOrder ? { ...request, type: "receiveAndComplete" } : request;
    const event = { request: storedRequest, createdAt: metadata.createdAt, actor: metadata.actor || "" };
    record(state, event);
    return { event, snapshot: snapshot(seed, state) };
  }

  return Object.freeze({ LOCATIONS, project, apply, historyForPart, previewQuantityCorrection });
})();
