/* Finished Tezoe stock rules shared by Apps Script and the browser API. */
var FinishedStock = (function () {
  "use strict";
  var MAX_QUANTITY = 1000000;
  var CATALOG = [
    { id: "26001", code: "26001", name: "Tezoe スタンツェ 直上", family: "スタンツェ", shape: "直・上向", bladeWidth: "赤" },
    { id: "26002", code: "26002", name: "Tezoe スタンツェ 直下", family: "スタンツェ", shape: "直・下向", bladeWidth: "青" },
    { id: "26011", code: "26011", name: "Tezoe スタンツェ 弱弯上", family: "スタンツェ", shape: "弱弯・上向", bladeWidth: "赤" },
    { id: "26012", code: "26012", name: "Tezoe スタンツェ 弱弯下", family: "スタンツェ", shape: "弱弯・下向", bladeWidth: "青" },
    { id: "26021", code: "26021", name: "Tezoe スタンツェ 強弯上", family: "スタンツェ", shape: "強弯・上向", bladeWidth: "赤" },
    { id: "26022", code: "26022", name: "Tezoe スタンツェ 強弯下", family: "スタンツェ", shape: "強弯・下向", bladeWidth: "青" },
    { id: "35002", code: "35002", name: "Tezoe ケリソン 直上35°", family: "ケリソン", shape: "直・上向35°", bladeWidth: "紫" }
  ];
  function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function fail(message) { throw new Error("FINISHED_STOCK_INVALID: " + message); }
  function safeInteger(value, min, max, label) {
    if (typeof value === "boolean" || value === "" || value === null || value === undefined) fail((label || "数量") + "は整数で入力してください。");
    var n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) fail((label || "数量") + "は" + min + "〜" + max + "の整数で入力してください。");
    return n;
  }
  function normalizePlannedQuantity(value, total) {
    if (value === undefined || value === null || value === "") value = 0;
    var totalNumber = total === "" || total === null || total === undefined ? 0 : Number(total);
    if (typeof total === "boolean" || !isFinite(totalNumber) || totalNumber < 0) fail("製造総数量を確認してください。");
    var quantity = safeInteger(value, 0, MAX_QUANTITY, "在庫予定数量");
    if (quantity > 0 && (!Number.isSafeInteger(totalNumber) || totalNumber > MAX_QUANTITY)) fail("製造総数量を整数で確認してください。");
    if (quantity > totalNumber) fail("在庫予定数量は製造総数量以下にしてください。");
    return quantity;
  }
  function catalog() { return clone(CATALOG); }
  function productFor(job) {
    job = job || {};
    var code = text(job.productCode).normalize("NFKC").toUpperCase();
    var product = text(job.product).normalize("NFKC");
    if (!/tezoe/i.test(product)) return null;
    var matches = CATALOG.filter(function (item) { return item.code === code; });
    if (matches.length !== 1) fail("Tezoe在庫は登録済みの製品番号を指定してください。");
    var entry = matches[0];
    var embedded = product.match(/(?:^|[^A-Z0-9])(260\d{2}|35002)(?=$|[^A-Z0-9])/gi) || [];
    if (embedded.some(function (raw) { return raw.match(/(260\d{2}|35002)/i)[1].toUpperCase() !== entry.code; })) fail("Tezoeの製品番号と品名が一致しません。");
    if (entry.family === "ケリソン" && !/ケリソン|kerrison/i.test(product) || entry.family === "スタンツェ" && /ケリソン|kerrison/i.test(product)) fail("製品番号とTezoe製品名の種類が一致しません。");
    var spec = (text(job.specShape) + " " + product).normalize("NFKC").toLowerCase();
    var expected = entry.code === "26011" || entry.code === "26012" ? /弱[弯湾彎曲]/ : entry.code === "26021" || entry.code === "26022" ? /強[弯湾彎曲]/ : /直/;
    var curveKinds = [/直/, /弱[弯湾彎曲]/, /強[弯湾彎曲]/].filter(function (pattern) { return pattern.test(spec); }).length;
    var directionUp = /上向|直\s*上/.test(spec), directionDown = /下向|直\s*下/.test(spec);
    var directional = directionUp ? "up" : directionDown ? "down" : "";
    if (directionUp && directionDown) fail("製品番号と刃向きが一致しません。");
    var expectedDirection = /(?:26001|26011|26021|35002)/.test(entry.code) ? "up" : "down";
    var hasShape = /(?:直|弱[弯湾彎曲]|強[弯湾彎曲])/.test(spec);
    if (hasShape && (!expected.test(spec) || curveKinds > 1)) fail("製品番号と型が一致しません。");
    if (directional && directional !== expectedDirection) fail("製品番号と刃向きが一致しません。");
    var angles = spec.match(/(\d+)\s*°/g) || [];
    if (entry.code === "35002" && angles.some(function (angle) { return angle.replace(/\s|°/g, "") !== "35"; })) fail("製品番号と角度が一致しません。");
    var width = text(job.bladeWidth).normalize("NFKC");
    if (width && entry.bladeWidth && width.indexOf(entry.bladeWidth) < 0) fail("製品番号と刃幅表示が一致しません。");
    return entry;
  }
  function planned(job) {
    var raw = normalizePlannedQuantity(job && job.stockPlannedQuantity, job && job.quantity);
    var total = Number(job && job.quantity);
    if (FinishedStockOrders.isStockOnly(job) && /tezoe/i.test(text(job && job.product)) && Number.isSafeInteger(total) && total >= 0 && total <= MAX_QUANTITY) return total;
    return raw;
  }
  function hashStable(value) {
    if (Array.isArray(value)) return "[" + value.map(function (item) { return hashStable(item === undefined ? null : item); }).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).filter(function (key) { return value[key] !== undefined; }).sort().map(function (key) { return JSON.stringify(key) + ":" + hashStable(value[key]); }).join(",") + "}";
    return JSON.stringify(value);
  }
  function hash(value) {
    var input = unescape(encodeURIComponent(hashStable(value))), words = [], length = input.length * 8, primes = [], candidate = 2, index, j;
    while (primes.length < 64) { var prime = true; for (j = 2; j * j <= candidate; j += 1) if (candidate % j === 0) { prime = false; break; } if (prime) primes.push(candidate); candidate += 1; }
    var h = primes.slice(0, 8).map(function (p) { return (Math.sqrt(p) % 1 * 4294967296) | 0; });
    var constants = primes.map(function (p) { return (Math.pow(p, 1 / 3) % 1 * 4294967296) | 0; });
    input += "\x80"; while (input.length % 64 !== 56) input += "\x00";
    for (index = 0; index < input.length; index += 1) words[index >> 2] = (words[index >> 2] || 0) | input.charCodeAt(index) << (24 - index % 4 * 8);
    words.push(Math.floor(length / 4294967296), length | 0);
    function rotr(x, n) { return x >>> n | x << (32 - n); }
    for (index = 0; index < words.length; index += 16) {
      var w = words.slice(index, index + 16), a = h.slice();
      for (j = 0; j < 64; j += 1) {
        if (j >= 16) { var x = w[j - 15], y = w[j - 2]; w[j] = (w[j - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ x >>> 3) + w[j - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ y >>> 10)) | 0; }
        var t1 = (a[7] + (rotr(a[4], 6) ^ rotr(a[4], 11) ^ rotr(a[4], 25)) + (a[4] & a[5] ^ ~a[4] & a[6]) + constants[j] + w[j]) | 0;
        var t2 = ((rotr(a[0], 2) ^ rotr(a[0], 13) ^ rotr(a[0], 22)) + (a[0] & a[1] ^ a[0] & a[2] ^ a[1] & a[2])) | 0;
        a = [(t1 + t2) | 0, a[0], a[1], a[2], (a[3] + t1) | 0, a[4], a[5], a[6]];
      }
      h = h.map(function (value, position) { return (value + a[position]) | 0; });
    }
    return h.map(function (value) { return (value >>> 0).toString(16).padStart(8, "0"); }).join("");
  }
  function isoDate(value, label) {
    var date = text(value), match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var parsed = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (!match || parsed.toISOString().slice(0, 10) !== date) fail((label || "日付") + "を正しく入力してください。");
    return date;
  }
  function producersFrom(value, required) {
    if (value === undefined || value === null) value = [];
    if (typeof value === "string") value = value.split(/[・、,，\n]+/).map(function (name) { return name.trim(); }).filter(Boolean);
    if (!Array.isArray(value) || value.length > 30 || value.some(function (name) { return typeof name !== "string" || text(name).length > 80; })) fail("製造担当者の形式が不正です。");
    var result = Array.from(new Set(value.map(text).filter(Boolean)));
    if (required && !result.length) fail("製造担当者を記録してください。");
    return result;
  }
  function japanToday(value) {
    var date = value ? new Date(value) : new Date();
    if (!isFinite(date.getTime())) fail("操作日時が不正です。");
    return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  function normalizeEvents(events) {
    if (!Array.isArray(events)) fail("在庫履歴の形式が不正です。");
    var byId = Object.create(null), requests = Object.create(null), reversed = Object.create(null), histories = [];
    events.forEach(function (source) {
      var event = clone(source);
      if (!event || !text(event.id) || byId[event.id] || !text(event.requestId) || requests[event.requestId] || !/^[a-f0-9]{64}$/.test(text(event.requestHash)) || !isFinite(Date.parse(event.at)) || ["opening", "receive", "ship", "reverse", "schedule"].indexOf(event.action) < 0) fail("Tezoe在庫履歴が壊れているか重複しています。");
      event.date = isoDate(event.date);
      if (event.action !== "reverse" && event.action !== "schedule") event.quantity = safeInteger(event.quantity, event.action === "opening" ? 0 : 1, MAX_QUANTITY, "数量");
      if (event.action === "schedule") {
        if (!text(event.jobId) || !CATALOG.some(function (product) { return product.id === event.productId; }) || ["split", "together"].indexOf(event.shipmentMode) < 0) fail("出荷予定の履歴が不正です。");
        event.stockQuantity = safeInteger(event.stockQuantity, 0, MAX_QUANTITY, "在庫出荷予定数");
        if (event.orderQuantity !== undefined) event.orderQuantity = safeInteger(event.orderQuantity, 0, MAX_QUANTITY, "注文数量");
        if (event.shipDate) isoDate(event.shipDate, "出荷予定日");
        if (event.completionDate) isoDate(event.completionDate, "完成予定日");
      }
      if (event.action === "opening" || event.action === "receive") {
        if (!CATALOG.some(function (product) { return product.id === event.productId; })) fail("履歴の製品番号が不正です。");
      }
      if (event.action === "reverse") {
        var target = byId[text(event.eventId)];
        if (!target || ["opening", "receive", "ship"].indexOf(target.action) < 0 || reversed[target.id] || event.date < target.date || !text(event.note)) fail("在庫取消の参照または理由が不正です。");
        if (target.action !== "ship" && event.date !== target.date && event.date < target.date) fail("取消日は元の記録日以降にしてください。");
        reversed[target.id] = event;
      }
      byId[event.id] = event; requests[event.requestId] = event; histories.push(event);
    });
    var lots = [], lotById = Object.create(null), activeShipments = [];
    events.forEach(function (event) {
      if (event.action === "opening" || event.action === "receive") {
        if (reversed[event.id]) return;
        var lot = {
          id: event.id, productId: event.productId, lotNo: text(event.lotNo), quantity: event.quantity,
          remainingQuantity: event.quantity, productionDate: text(event.productionDate), producers: Array.isArray(event.producers) ? event.producers.slice() : [],
          stageAssignees: event.stageAssignees || {}, jobId: text(event.jobId), serialNo: text(event.serialNo),
          product: text(event.product), customer: text(event.customer), dueDate: text(event.dueDate), date: event.date, at: event.at, note: text(event.note),
          unknownOrigin: event.action === "opening" && (!event.productionDate || !(event.producers || []).length)
        };
        if (lotById[lot.id]) fail("ロットIDが重複しています。");
        lotById[lot.id] = lot; lots.push(lot);
      }
      if (event.action === "ship" && !reversed[event.id]) activeShipments.push(event);
    });
    activeShipments.forEach(function (event) {
      if (!Array.isArray(event.allocations) || !event.allocations.length) fail("出荷のロット割当がありません。");
      var allocated = 0;
      event.allocations.forEach(function (allocation) {
        var lot = lotById[text(allocation.lotId)], qty = safeInteger(allocation.quantity, 1, MAX_QUANTITY, "出荷数量");
        if (!lot || lot.productId !== event.productId || qty > lot.remainingQuantity || event.date < lot.date || lot.productionDate && event.date < lot.productionDate) fail("在庫履歴の出荷割当が不正です。");
        lot.remainingQuantity -= qty; allocated += qty;
      });
      if (allocated !== event.quantity) fail("出荷数量とロット割当が一致しません。");
    });
    return { events: histories, requests: requests, byId: byId, reversed: reversed, lots: lots, lotById: lotById, activeShipments: activeShipments };
  }
  function polishReady(job) {
    var polishing = job.polishing || {};
    var quantity = Number(job.quantity);
    return Number.isSafeInteger(quantity) && quantity > 0 && polishing.sentQuantity === quantity && polishing.returnedQuantity === quantity;
  }
  function fulfillment(job, events) {
    function quantity(value) {
      if ((typeof value !== "number" && typeof value !== "string") || !text(value)) fail("数量を確認してください。");
      return safeInteger(value, 0, MAX_QUANTITY, "数量");
    }
    try {
      if (!job || !text(job.id) || job.archived || FinishedStockOrders.isStockOnly(job)) return null;
      if (quantity(job.quantity) !== 0 || quantity(job.stockPlannedQuantity) !== 0) return null;
      var product = productFor(job);
      if (!product) return null;
      var polishing = job.polishing || {};
      var sent = polishing.sentQuantity === undefined ? 0 : quantity(polishing.sentQuantity);
      var returned = polishing.returnedQuantity === undefined ? 0 : quantity(polishing.returnedQuantity);
      if (sent !== returned) return null;
      var state = normalizeEvents(events || []), schedule = null, capturedQuantity = null, jobId = text(job.id);
      // Event append order is the sequence used by snapshot's schedule projection.
      state.events.forEach(function (event, index) {
        if (event.action === "schedule" && event.jobId === jobId) { schedule = event; capturedQuantity = events[index].orderQuantity; }
      });
      if (!schedule || schedule.productId !== product.id || quantity(capturedQuantity) <= 0) return null;
      var shipped = 0, date = "", invalidProduct = false;
      state.activeShipments.forEach(function (source) {
        var event = state.byId[source.id];
        if (event.orderJobId !== jobId) return;
        if (event.productId !== product.id) { invalidProduct = true; return; }
        shipped += event.quantity;
        if (event.date > date) date = event.date;
      });
      if (invalidProduct || !date || shipped !== schedule.orderQuantity) return null;
      return { date: date, orderQuantity: schedule.orderQuantity, shippedQuantity: shipped, productId: product.id };
    } catch (error) {
      return null;
    }
  }
  function validateShipmentCompletion(order, job) {
    if (!order) return;
    // Allocation measures stock currently on hand. A saved shipment target
    // remains due even when no lot is available to reserve against it.
    var stockRemaining = Number(order.hasSchedule ? order.stockTargetQuantity : order.allocatedQuantity) || 0;
    if (stockRemaining > 0) throw new Error("在庫からの出荷予定分が残っています。Tezoe製品在庫で実際の出荷を記録するか、出荷予定を調整してください。");
    // Unscheduled legacy orders derive demand from their manufacturing plan;
    // only an explicit order quantity is independent of that plan.
    var orderProduction = Math.max(0, Number(job.quantity || 0) - planned(job));
    if (order.hasSchedule && Number(order.remainingQuantity) > orderProduction) throw new Error("注文数量を満たす製造分が不足しています。製造計画または出荷予定を確認してください。");
  }
  function snapshot(options) {
    options = options || {};
    var jobs = options.jobs || [], state = normalizeEvents(options.events || []), products = catalog(), plans = [];
    var receiptTotals = Object.create(null);
    state.lots.forEach(function (lot) { if (lot.jobId) receiptTotals[lot.jobId] = (receiptTotals[lot.jobId] || 0) + lot.quantity; });
    jobs.forEach(function (job) {
      var quantity = planned(job);
      if (!quantity || job.archived) return;
      var product = productFor(job);
      if (!product) fail("在庫製造計画の製品を確認してください。");
      var received = receiptTotals[job.id] || 0;
      if (received > quantity) fail("実績数量が在庫製造計画を超えています。");
      var producers = Object.keys(job.stages || {}).map(function (key) { return text(job.stages[key] && job.stages[key].assignee); }).filter(Boolean);
      plans.push({ jobId: text(job.id), productId: product.id, product: product.name, customer: text(job.customer), serialNo: text(job.serialNo), dueDate: text(job.dueDate), quantity: quantity - received, plannedQuantity: quantity, receivedQuantity: received, totalQuantity: Number(job.quantity || 0), orderQuantity: Math.max(0, Number(job.quantity || 0) - quantity), finishReady: !!(job.stages && job.stages.finish && job.stages.finish.status === "done" && polishReady(job)), jobVersion: Number(job.version || 0), producers: Array.from(new Set(producers)), stageAssignees: Object.keys(job.stages || {}).reduce(function (out, key) { out[key] = text(job.stages[key] && job.stages[key].assignee); return out; }, {}) });
    });
    var productRows = products.map(function (product) {
      var productLots = state.lots.filter(function (lot) { return lot.productId === product.id; });
      var productPlans = plans.filter(function (plan) { return plan.productId === product.id && plan.quantity > 0; });
      var orderQuantity = jobs.filter(function (job) { return !job.archived && job.shippingStatus !== "shipped"; }).reduce(function (sum, job) {
        if (!/tezoe/i.test(text(job.product))) return sum;
        var identity;
        try { identity = productFor(job); } catch (error) { return sum; }
        return identity && identity.id === product.id ? sum + Math.max(0, Number(job.quantity || 0) - planned(job)) : sum;
      }, 0);
      var stockQuantity = productLots.reduce(function (sum, lot) { return sum + lot.remainingQuantity; }, 0);
      return { id: product.id, code: product.code, name: product.name, stockQuantity: stockQuantity, stockRegistered: state.events.some(function (event) { return event.productId === product.id && (event.action === "opening" || event.action === "receive"); }), orderQuantity: orderQuantity, shortageQuantity: Math.max(0, orderQuantity - stockQuantity), plannedQuantity: productPlans.reduce(function (sum, plan) { return sum + plan.quantity; }, 0), nextDueDate: productPlans.map(function (plan) { return plan.dueDate; }).filter(Boolean).sort()[0] || "" };
    });
    var lots = state.lots.map(function (lot) { return clone(lot); }).sort(function (a, b) { return a.date.localeCompare(b.date) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id); });
    var history = state.events.map(function (event, index) { return Object.assign({}, event, { sequence: index }); }).sort(function (a, b) { return b.sequence - a.sequence; });
    var result = { version: state.events.length, products: productRows, plans: plans, lots: lots, history: history };
    var projection = FinishedStockOrders.project(result, jobs, { productFor: productFor, today: options.today || japanToday(options.at) });
    Object.keys(projection).forEach(function (key) { result[key] = projection[key]; });
    return result;
  }
  function validateJob(job, previous, events) {
    job = job || {};
    var quantity = planned(job), received = 0, state = normalizeEvents(events || []), jobId = text(job.id);
    state.lots.forEach(function (lot) { if (jobId && lot.jobId === jobId) received += lot.quantity; });
    var before = previous ? planned(previous) : 0;
    var oldProduct = previous && before ? productFor(previous) : null;
    var newProduct = quantity ? productFor(job) : null;
    if (quantity && !newProduct) fail("在庫製造計画には対応するTezoe製品番号と品名が必要です。");
    if (received > quantity) fail("在庫として受領済みの数量より在庫予定数量を少なくできません。");
    if (received && (!oldProduct || !newProduct || oldProduct.id !== newProduct.id)) fail("在庫受領済み案件の製品番号は変更できません。");
    if (previous && before && !quantity && received) fail("在庫受領済み案件の在庫計画は削除できません。");
    var shipments = state.activeShipments.filter(function (event) { return jobId && event.orderJobId === jobId; });
    var shipped = shipments.reduce(function (sum, event) { return sum + event.quantity; }, 0);
    var schedules = state.events.filter(function (event) { return jobId && event.action === "schedule" && event.jobId === jobId; });
    var schedule = schedules[schedules.length - 1];
    if (schedule && schedule.orderQuantity > 0) {
      var scheduledIdentity = productFor(job);
      if (!scheduledIdentity || scheduledIdentity.id !== schedule.productId) fail("出荷予定を設定済みの受注の製品は変更できません。注文数量を0にして予定を解除してから変更してください。");
    }
    if (shipped) {
      var identity = productFor(job);
      if (!identity || shipments.some(function (event) { return event.productId !== identity.id; })) fail("在庫から出荷済みの受注の製品は変更できません。");
      if ((schedule && schedule.orderQuantity !== undefined ? schedule.orderQuantity : Number(job.quantity || 0) - quantity) < shipped) fail("注文分を在庫から出荷済みの数量より少なくできません。");
    }
    return quantity;
  }
  function requestContent(action, input) {
    var copy = {};
    Object.keys(input || {}).forEach(function (key) { if (key !== "requestId" && key !== "expectedVersion") copy[key] = input[key]; });
    return { action: action, input: copy };
  }
  function prepareMutation(action, input, options) {
    input = input || {}; options = options || {};
    var validActions = ["opening", "receive", "ship", "reverse", "schedule"];
    if (validActions.indexOf(action) < 0) fail("不明な在庫操作です。");
    var common = ["expectedVersion", "requestId", "note"];
    var extras = action === "opening" ? ["productId", "quantity", "date", "productionDate", "producers", "lotNo"]
      : action === "receive" ? ["jobId", "jobVersion", "quantity", "date", "productionDate", "producers", "lotNo", "productId"]
      : action === "ship" ? ["productId", "quantity", "date", "customer", "orderRef", "purpose", "lotId", "orderJobId", "jobVersion"]
      : action === "schedule" ? ["jobId", "jobVersion", "orderQuantity", "stockQuantity", "shipmentMode", "shipDate", "completionDate"]
      : ["eventId", "date"];
    if (Object.keys(input).some(function (key) { return common.concat(extras).indexOf(key) < 0; })) fail("在庫操作に許可されていない項目があります。");
    var requestId = text(input.requestId);
    if (!requestId || requestId.length > 120) fail("操作IDを指定してください。");
    var state = normalizeEvents(options.events || []), requestHash = hash(requestContent(action, input)), prior = state.requests[requestId];
    if (prior) {
      if (prior.requestHash !== requestHash) fail("同じリクエストIDで異なる内容は保存できません。");
      return { event: null, snapshot: snapshot({ jobs: options.jobs || [], events: options.events || [] }), retry: true };
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== state.events.length) fail("別の端末で在庫が更新されています。画面を更新してください。");
    var note = text(input.note);
    if (note.length > 1000) fail("備考・理由は1000文字以内にしてください。");
    if (action === "opening" && !note) fail("現在庫を記録する理由を入力してください。");
    var today = japanToday(options.at), date = action === "schedule" ? today : isoDate(input.date, "記録日");
    if ((action === "opening" || action === "receive") && date > today) fail("実際の入庫日には今日までの日付を入力してください。");
    if ((action === "ship" || action === "reverse") && date > today) fail("実際の出庫・取消日には今日までの日付を入力してください。");
    var event = { id: text(options.id) || requestId, requestId: requestId, requestHash: requestHash, action: action, date: date, at: text(options.at) || new Date().toISOString(), actor: text(options.actor), note: note };
    if (action === "schedule") {
      var scheduledJob = (options.jobs || []).filter(function (item) { return text(item.id) === text(input.jobId); })[0];
      if (!scheduledJob || scheduledJob.archived || scheduledJob.shippingStatus === "shipped") fail("出荷予定を設定できる受注が見つかりません。");
      if (Number(scheduledJob.version || 0) !== Number(input.jobVersion)) fail("案件が別の端末で更新されています。画面を更新してください。");
      var scheduledProduct = productFor(scheduledJob);
      if (!scheduledProduct) fail("Tezoe製品の受注を選択してください。");
      var ordered = safeInteger(input.orderQuantity, 0, MAX_QUANTITY, "注文数量");
      var shippedAlready = state.activeShipments.filter(function (entry) { return entry.orderJobId === scheduledJob.id; }).reduce(function (sum, entry) { return sum + entry.quantity; }, 0);
      var stockTarget = safeInteger(input.stockQuantity, shippedAlready, ordered, "在庫出荷予定数");
      if (FinishedStockOrders.isStockOnly(scheduledJob) && (ordered > 0 || stockTarget > 0)) fail("在庫用の製造案件に顧客向けの注文数・出荷数は設定できません。");
      if (["split", "together"].indexOf(input.shipmentMode) < 0) fail("出荷方法を選択してください。");
      var shipDate = input.shipDate ? isoDate(input.shipDate, "出荷予定日") : "";
      var completionDate = input.completionDate ? isoDate(input.completionDate, "完成予定日") : "";
      if (input.shipmentMode === "together" && stockTarget < ordered && shipDate && (completionDate || scheduledJob.dueDate) && shipDate < (completionDate || scheduledJob.dueDate)) fail("一緒に出荷する予定日は不足分の完成予定日以降にしてください。");
      event.jobId = scheduledJob.id; event.jobVersion = scheduledJob.version; event.productId = scheduledProduct.id;
      event.orderQuantity = ordered; event.stockQuantity = stockTarget; event.shipmentMode = input.shipmentMode; event.shipDate = shipDate; event.completionDate = completionDate;
      event.customer = text(scheduledJob.customer); event.serialNo = text(scheduledJob.serialNo); event.quantity = stockTarget;
    } else if (action === "opening") {
      var openingProduct = CATALOG.filter(function (item) { return item.id === text(input.productId); })[0];
      if (!openingProduct) fail("製品を選択してください。");
      event.productId = openingProduct.id; event.quantity = safeInteger(input.quantity, 0, MAX_QUANTITY, "数量"); event.lotNo = text(input.lotNo).slice(0, 120) || event.id;
      event.productionDate = input.productionDate ? isoDate(input.productionDate, "製造日") : "";
      event.producers = producersFrom(input.producers, false);
      if (event.productionDate && (event.productionDate > today || event.productionDate > date)) fail("製造日は今日まで、入庫日以前の日付にしてください。");
    } else if (action === "receive") {
      var job = (options.jobs || []).filter(function (item) { return text(item.id) === text(input.jobId); })[0];
      if (!job || job.archived) fail("在庫製造案件が見つかりません。");
      if (Number(job.version || 0) !== Number(input.jobVersion)) fail("案件が別の端末で更新されています。画面を更新してください。");
      var product = productFor(job), quantity = safeInteger(input.quantity, 1, MAX_QUANTITY, "数量");
      if (!product || product.id !== text(input.productId || product.id)) fail("製品番号を確認してください。");
      if (!job.stages || !job.stages.finish || job.stages.finish.status !== "done" || !polishReady(job)) fail("最終仕上げ完了後、研磨から全数量が戻った案件だけ在庫へ受領できます。");
      if (date > today) fail("実際の入庫日には今日までの日付を入力してください。");
      var productionDate = isoDate(input.productionDate, "製造日");
      if (productionDate > today || productionDate > date) fail("製造日は今日まで、入庫日以前の日付にしてください。");
      var already = state.lots.filter(function (lot) { return lot.jobId === job.id; }).reduce(function (sum, lot) { return sum + lot.quantity; }, 0);
      var plan = planned(job);
      if (already + quantity > plan) fail("在庫受領数量が残りの在庫製造計画を超えています。");
      var producers = producersFrom(input.producers, true);
      event.productId = product.id; event.quantity = quantity; event.jobId = job.id; event.jobVersion = job.version;
      event.customer = text(job.customer); event.serialNo = text(job.serialNo); event.product = text(job.product); event.dueDate = text(job.dueDate);
      event.lotNo = text(input.lotNo).slice(0, 120) || event.id; event.productionDate = productionDate; event.producers = producers;
      event.stageAssignees = Object.keys(job.stages || {}).reduce(function (out, key) { out[key] = text(job.stages[key] && job.stages[key].assignee); return out; }, {});
    } else if (action === "ship") {
      var shipProduct = CATALOG.filter(function (item) { return item.id === text(input.productId); })[0];
      if (!shipProduct) fail("製品を選択してください。");
      event.productId = shipProduct.id; event.quantity = safeInteger(input.quantity, 1, MAX_QUANTITY, "数量");
      var current = snapshot({ jobs: options.jobs || [], events: options.events || [], at: options.at });
      var orderJobId = text(input.orderJobId), linkedOrder = null;
      if (orderJobId) {
        linkedOrder = current.orders.filter(function (order) { return order.jobId === orderJobId; })[0];
        if (!linkedOrder || linkedOrder.productId !== shipProduct.id || linkedOrder.remainingQuantity <= 0) fail("出荷する受注の製品・残数を確認してください。");
        if (Number(linkedOrder.jobVersion) !== Number(input.jobVersion)) fail("案件が別の端末で更新されています。画面を更新してください。");
        if (event.quantity > linkedOrder.allocatedQuantity) fail("出荷数量がこの受注に確保できる在庫数を超えています。");
        if (linkedOrder.shipmentMode === "together" && linkedOrder.shortageQuantity > 0 && !linkedOrder.finishReady) fail("不足分と一緒に出荷する場合は、不足分の製造完了後に記録してください。");
        event.orderJobId = orderJobId;
      } else {
        var availableProduct = current.products.filter(function (row) { return row.id === shipProduct.id; })[0];
        if (event.quantity > availableProduct.stockQuantity) fail("出荷数量が在庫を超えています。");
        if (event.quantity > availableProduct.availableQuantity) fail("他の受注に確保済みの在庫です。対象の受注から出荷するか出荷予定を調整してください。");
      }
      event.customer = text(input.customer).slice(0, 160); event.orderRef = text(input.orderRef).slice(0, 240); event.purpose = input.purpose;
      if (linkedOrder) {
        event.customer = linkedOrder.customer; event.orderRef = text(linkedOrder.serialNo || orderJobId);
      }
      if (!event.customer || !event.orderRef || ["sale", "demo"].indexOf(event.purpose) < 0) fail("得意先・注文番号・出荷目的を入力してください。");
      var eligible = state.lots.filter(function (lot) { return lot.productId === shipProduct.id && lot.remainingQuantity > 0; }).sort(function (a, b) { return a.date.localeCompare(b.date) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id); });
      var selected = text(input.lotId);
      if (selected) eligible = eligible.filter(function (lot) { return lot.id === selected; });
      var left = event.quantity, allocations = [];
      eligible.forEach(function (lot) { if (!left) return; if (date < lot.date || lot.productionDate && date < lot.productionDate) fail("出荷日は入庫日・製造日以降にしてください。"); var use = Math.min(left, lot.remainingQuantity); allocations.push({ lotId: lot.id, quantity: use, lotNo: lot.lotNo, productionDate: lot.productionDate, producers: lot.producers.slice(), stageAssignees: clone(lot.stageAssignees || {}), jobId: lot.jobId, serialNo: lot.serialNo, unknownOrigin: lot.unknownOrigin }); left -= use; });
      if (left) fail("出荷数量が選択ロットの在庫を超えています。");
      event.allocations = allocations;
    } else {
      var target = state.byId[text(input.eventId)];
      if (!target || ["opening", "receive", "ship"].indexOf(target.action) < 0 || state.reversed[target.id]) fail("取消対象の在庫記録が見つかりません。");
      if (!note) fail("取消理由を入力してください。");
      if (date < target.date) fail("取消日は元の記録日以降にしてください。");
      if (target.action !== "ship") {
        var lot = state.lotById[target.id];
        if (!lot || lot.remainingQuantity !== lot.quantity) fail("このロットは一部または全部を出荷済みのため取消できません。");
      }
      event.eventId = target.id; event.productId = target.productId; event.quantity = target.quantity;
    }
    var candidateEvents = (options.events || []).concat([event]);
    var resultSnapshot = snapshot({ jobs: options.jobs || [], events: candidateEvents });
    return { event: event, snapshot: resultSnapshot, retry: false };
  }
  return { CATALOG: catalog(), catalog: catalog, snapshot: snapshot, prepareMutation: prepareMutation, normalizePlannedQuantity: normalizePlannedQuantity, validateJob: validateJob, validateShipmentCompletion: validateShipmentCompletion, productFor: productFor, fulfillment: fulfillment, hash: hash };
}());
