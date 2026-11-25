/* Shared by Apps Script and the browser's local inventory. */
globalThis.CastingStock = (function () {
  "use strict";

  const LOCATIONS = Object.freeze(["1F", "2F", "保土田"]);
  const VARIANTS = ["raw", "processed", "colored", "single", "unclassified"];
  const STOCK_ACTIONS = ["use", "sell", "receive", "process", "classify", "transfer", "count"];
  const ACTIONS = [...STOCK_ACTIONS, "order", "cancelOrder", "reverse", "threshold"];
  const HISTORY_LIMIT = 150;

  function fail(message) {
    throw new Error("CASTING_STOCK_INVALID: " + message);
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

  function unprocessedVariant(state, partId) {
    const item = state.items.get(partId);
    if (!item) fail("品目を確認してください。");
    return item.variants.some(variant => variant.id === "single") ? "single" : "raw";
  }

  function fixedLocation(variant) {
    return ["raw", "single"].includes(variant) ? "1F" : "2F";
  }

  function fixedRequestVariant(state, partId, input) {
    const unprocessed = unprocessedVariant(state, partId);
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

  function normalizeRequest(input, fixedState) {
    if (!input || !ACTIONS.includes(input.type)) fail("作業内容を選択してください。");
    const request = {
      opId: operationId(input.opId),
      type: input.type,
      date: date(input.date, "作業日"),
      note: typeof input.note === "string" ? input.note.trim() : "",
    };
    if (input.type === "reverse") {
      request.targetId = operationId(input.targetId);
      return request;
    }
    if (input.type === "cancelOrder") {
      request.orderId = operationId(input.orderId);
      return request;
    }

    request.partId = requiredText(input.partId, "品目");
    if (fixedState && ["classify", "transfer"].includes(input.type)) fail("在庫の区分は固定です。画面を更新してから在庫調整を行ってください。");
    request.variant = fixedState ? fixedRequestVariant(fixedState, request.partId, input) : requiredText(input.variant, "加工区分");
    if (input.type === "threshold") {
      request.threshold = input.threshold === null ? null : quantity(input.threshold, true, "発注点");
      return request;
    }

    request.quantity = quantity(input.quantity, input.type === "count");
    if ((input.type === "order" || input.type === "receive") && input.expectedOrderRemainder !== undefined) {
      request.expectedOrderRemainder = quantity(input.expectedOrderRemainder, true, "確認時の発注残");
    }
    if (input.type === "order") {
      request.dueDate = input.dueDate ? date(input.dueDate, "入荷予定日") : "";
      if (request.dueDate && request.dueDate < request.date) fail("入荷予定日は発注日以降にしてください。");
      return request;
    }

    request.location = fixedState ? fixedLocation(request.variant) : location(input.location);
    if (input.type === "process" || input.type === "classify") {
      request.toVariant = requiredText(input.toVariant ?? (fixedState ? "processed" : undefined), "振り分け先の加工区分");
    }
    if (input.type === "process" || input.type === "transfer") request.toLocation = fixedState ? "2F" : location(input.toLocation);
    if (input.type === "receive" && input.orderId) request.orderId = operationId(input.orderId);
    if (input.type === "count") request.expectedQuantity = quantity(input.expectedQuantity, true, "棚卸前の数量");
    return request;
  }

  function stockKey(partId, variant, place) {
    return JSON.stringify([partId, variant, place]);
  }

  function getPartVariant(state, partId, variantId) {
    const variant = state.items.get(partId)?.variants.find(entry => entry.id === variantId);
    if (!variant) fail("品目または加工区分を確認してください。");
    return variant;
  }

  function initialState(seed) {
    if (!seed || !Array.isArray(seed.items) || !seed.items.length || !Array.isArray(seed.stock) || !Number.isFinite(Date.parse(seed.initializedAt))) {
      fail("開始時の在庫データを確認してください。");
    }
    const state = { items: new Map(), stock: new Map(), orders: new Map(), activeByPart: new Map(), history: new Map() };
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
      state.items.set(id, { ...item, id, name: requiredText(item.name, "品目名"), variants: [...variants.values()] });
      state.activeByPart.set(id, []);
    }
    for (const balance of seed.stock) {
      if (!balance) fail("開始時の在庫データを確認してください。");
      getPartVariant(state, balance.partId, balance.variant);
      const place = location(balance.location);
      const key = stockKey(balance.partId, balance.variant, place);
      if (state.stock.has(key)) fail("開始時の在庫に同じ品目と保管場所が重複しています。");
      state.stock.set(key, { ...balance, location: place, quantity: quantity(balance.quantity, true, "開始時の在庫数") });
    }
    if (seed.openingOrders !== undefined && !Array.isArray(seed.openingOrders)) fail("開始時の発注データを確認してください。");
    for (const order of seed.openingOrders || []) {
      const input = normalizeRequest({ ...order, type: "order", opId: order?.id });
      addOrder(state, { ...input, id: input.opId });
    }
    return state;
  }

  function fixedBalance(state, partId, variant, place) {
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
    state.stock.set(key, { partId: row.partId, variant, location: place, quantity: after });
    row.changes.push({ variant, location: place, before, after });
  }

  function addOrder(state, row) {
    getPartVariant(state, row.partId, row.variant);
    if (row.variant === "unclassified") fail("発注する品目の加工区分を選択してください。");
    if (state.orders.has(row.id)) fail("鋳物在庫の発注IDが重複しています。");
    state.orders.set(row.id, { id: row.id, partId: row.partId, variant: row.variant, quantity: row.quantity, remaining: row.quantity, date: row.date, dueDate: row.dueDate, note: row.note, cancelled: false });
  }

  function openOrder(state, id) {
    const order = state.orders.get(id);
    if (!order || order.cancelled || order.remaining === 0) fail("入荷待ちの発注が見つかりません。画面を更新してください。");
    return order;
  }

  function pendingOrderMatches(order, row) {
    return order && order.partId === row.partId && order.variant === row.variant && !order.cancelled && order.remaining > 0;
  }

  function checkReviewedOrderRemainder(state, row) {
    const expected = row.expectedOrderRemainder;
    if (expected === undefined) return;
    const orders = row.orderId ? [state.orders.get(row.orderId)] : state.orders.values();
    let remainder = 0;
    for (const order of orders) {
      if (pendingOrderMatches(order, row)) remainder += order.remaining;
    }
    const receiving = row.type === "receive";
    if (remainder !== expected || (!receiving && expected !== 0) || (row.orderId && expected === 0)) {
      throw new Error("CASTING_STOCK_ORDER_CHANGED: 最新の発注残を確認してから記録してください。");
    }
    if (receiving && remainder > 0 && row.quantity > remainder) fail("入庫数が発注残を超えています。入庫する数量を確認してください。");
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
    const order = row.orderId && openOrder(state, row.orderId);
    if (order && (order.partId !== row.partId || order.variant !== row.variant)) fail("発注した品目と加工区分を確認してください。");
    if (order && order.remaining < row.quantity) fail("入庫数が発注残を超えています。発注分と追加分を分けて記録してください。");
    changeStock(state, row, row.variant, row.location, row.quantity);
    if (state.fixedStorage) {
      const matching = order ? [order] : [...state.orders.values()]
        .filter(item => pendingOrderMatches(item, row))
        .sort((left, right) => left.date.localeCompare(right.date));
      row.orderAllocations = [];
      let unallocated = row.quantity;
      for (const purchase of matching) {
        if (!unallocated) break;
        const allocated = Math.min(purchase.remaining, unallocated);
        purchase.remaining -= allocated;
        unallocated -= allocated;
        row.orderAllocations.push({ orderId: purchase.id, quantity: allocated });
      }
    } else if (order) order.remaining -= row.quantity;
  }

  function reverseStockChanges(state, row, changes) {
    if (!state.fixedStorage) {
      for (const change of changes) changeStock(state, row, change.variant, change.location, change.before - change.after);
      return;
    }
    const balances = new Map();
    for (const change of changes) {
      const { variant, location: place } = fixedBalance(state, row.partId, change.variant, change.location);
      const key = stockKey(row.partId, variant, place);
      const delta = (balances.get(key)?.delta ?? 0) + (change.before - change.after);
      balances.set(key, { variant, place, delta });
    }
    for (const { variant, place, delta } of balances.values()) {
      if (delta) changeStock(state, row, variant, place, delta);
    }
  }

  function reverseRecord(state, row) {
    const target = state.history.get(row.targetId)?.row;
    const active = target && state.activeByPart.get(target.partId);
    if (!active || active[active.length - 1] !== target) fail("その記録を取り消せません。同じ品目の新しい記録から確認してください。");
    row.partId = target.partId;
    row.variant = target.variant;
    row.location = target.location;
    row.quantity = target.quantity;
    row.orderId = target.orderId;
    row.targetType = target.type;
    if (target.type === "order") {
      const order = openOrder(state, target.id);
      if (order.remaining !== order.quantity) fail("発注を取り消す前に、ひも付いた入庫を取り消してください。");
      state.orders.delete(target.id);
      row.orderId = target.id;
    }
    if (target.type === "cancelOrder") state.orders.get(target.orderId).cancelled = false;
    if (target.type === "receive") {
      const allocations = target.orderAllocations || (target.orderId ? [{ orderId: target.orderId, quantity: target.quantity }] : []);
      for (const allocation of allocations) state.orders.get(allocation.orderId).remaining += allocation.quantity;
      if (state.fixedStorage) row.orderAllocations = allocations;
    }
    if (target.type === "threshold") {
      getPartVariant(state, target.partId, target.variant).threshold = target.previousThreshold;
      row.threshold = target.previousThreshold;
    }
    if (target.openingWasUnconfirmed) state.items.get(target.partId).openingUnconfirmed = true;
    reverseStockChanges(state, row, target.changes);
    target.reversed = true;
    active.pop();
  }

  function record(state, event) {
    if (!event || !Number.isFinite(Date.parse(event.createdAt)) || typeof event.actor !== "string") fail("鋳物在庫の記録日時または操作者を確認してください。");
    const input = normalizeRequest(event.request, state.fixedStorage ? state : undefined);
    if (state.history.has(input.opId) || state.orders.has(input.opId)) fail("鋳物在庫の記録IDが重複しています。");
    const row = { ...input, id: input.opId, createdAt: event.createdAt, actor: event.actor, changes: [], reversed: false };
    delete row.opId;

    if (row.type === "reverse") {
      reverseRecord(state, row);
    } else if (row.type === "cancelOrder") {
      const order = openOrder(state, row.orderId);
      Object.assign(row, { partId: order.partId, variant: order.variant, quantity: order.remaining });
      order.cancelled = true;
    } else {
      const variant = getPartVariant(state, row.partId, row.variant);
      const item = state.items.get(row.partId);
      if (item.openingUnconfirmed && STOCK_ACTIONS.includes(row.type) && row.type !== "count") {
        fail("最初に棚卸で現在庫を登録してください。");
      }
      checkReviewedOrderRemainder(state, row);
      switch (row.type) {
        case "use":
        case "sell":
          if (row.type === "sell" && !["raw", "single"].includes(row.variant)) fail("販売は未加工または加工区分のない品目から記録してください。");
          changeStock(state, row, row.variant, row.location, -row.quantity);
          break;
        case "receive":
          receiveStock(state, row);
          break;
        case "process":
        case "classify":
        case "transfer":
          processMovement(state, row);
          break;
        case "order":
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
    if (row.type !== "reverse") state.activeByPart.get(row.partId).push(row);
    state.history.set(row.id, { row, input, fixedStorage: state.fixedStorage });
  }

  function replay(seed, events) {
    const state = initialState(seed);
    const boundary = seed.fixedStorageFrom;
    if (!Array.isArray(events) || (boundary !== undefined &&
      (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > events.length))) {
      fail("在庫の保管場所を統合した時点を確認してください。");
    }
    for (let index = 0; index < events.length; index += 1) {
      if (index === boundary) enableFixedStorage(state);
      record(state, events[index]);
    }
    if (boundary === events.length) enableFixedStorage(state);
    return state;
  }

  function snapshot(seed, state) {
    const stock = [...state.stock.values()];
    let inventoryTotal = 0;
    for (const balance of stock) inventoryTotal += balance.quantity;
    if (!Number.isSafeInteger(inventoryTotal)) fail("在庫合計が上限を超えています。数量を確認してください。");

    const history = [];
    for (const { row } of [...state.history.values()].reverse()) {
      const active = state.activeByPart.get(row.partId);
      const canReverse = active[active.length - 1] === row;
      if (history.length < HISTORY_LIMIT || canReverse) history.push({ ...row, canReverse });
    }
    const orders = [...state.orders.values()].filter(order => !order.cancelled && order.remaining > 0).map(({ cancelled, ...order }) => order);
    const result = {
      initialized: true,
      initializedAt: seed.initializedAt,
      sourceUrl: seed.sourceUrl,
      items: [...state.items.values()],
      stock,
      orders,
      history,
      revision: state.history.size + (state.fixedStorage ? 2 : 1),
    };
    if (state.fixedStorage) result.fixedStorage = true;
    return result;
  }

  function project(seed, events) {
    return snapshot(seed, replay(seed, events));
  }

  function apply(seed, events, input, metadata) {
    const state = replay(seed, events);
    const existing = state.history.get(input?.opId);
    const fixed = existing ? existing.fixedStorage : state.fixedStorage;
    const request = normalizeRequest(input, fixed ? state : undefined);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(request)) fail("同じ記録IDで異なる内容を保存できません。画面を更新してから入力してください。");
      return { event: null, snapshot: snapshot(seed, state) };
    }
    // A receipt without an order ID allocates against the orders at its position in the ledger.
    const event = { request, createdAt: metadata.createdAt, actor: metadata.actor || "" };
    record(state, event);
    return { event, snapshot: snapshot(seed, state) };
  }

  return Object.freeze({ LOCATIONS, project, apply });
})();
