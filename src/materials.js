/* The same material rules run in the browser, MockApi and Apps Script. */
var MaterialInventory = (function () {
  "use strict";
  var MAX_JSON = 45000;
  var SOURCE_NOTE = "2026-10-20提供画像の現在庫。数量は製品1丁につき材料1セット。仕入先: 碓井";
  var CATALOG = [
    { id: "CK001", code: "CK001", name: "慈大式・Tezoe 共通材料", shape: "直・上向", specification: "カブセ・本体10×16×110mm / 1セット / 碓井", openingQuantity: 28 },
    { id: "CK011", code: "CK011", name: "慈大式・Tezoe 共通材料", shape: "弱弯・上向", specification: "カブセ・本体10×16×110mm / 1セット / 碓井", openingQuantity: 12 },
    { id: "CK002", code: "CK002", name: "慈大式 彫骨器材料", shape: "直・下向", specification: "カブセ10×20×185mm／本体10×20×150mm / 1セット / 碓井", openingQuantity: 42 },
    { id: "TEZOE26002", code: "Tezoe 26002", name: "Tezoe 26002 専用材料", shape: "直・下向", specification: "カブセ10×20×185mm／本体10×20×150mm / 26002専用 / 1セット / 碓井", openingQuantity: 1 },
    { id: "CK021", code: "CK021", name: "慈大式・Tezoe 共通材料", shape: "強弯・上向", specification: "カブセ・本体10×16×135mm / 1セット / 碓井", openingQuantity: 0 },
    { id: "CK022", code: "CK022", name: "慈大式・Tezoe 共通材料", shape: "強弯・下向", specification: "カブセ10×16×212mm／本体10×16×173mm / 1セット / 碓井", openingQuantity: 0 }
  ];
  var CODE_MAP = { CK001: "CK001", CK002: "CK002", CK011: "CK011", CK021: "CK021", CK022: "CK022", "26001": "CK001", "26002": "TEZOE26002", "26011": "CK011", "26021": "CK021", "26022": "CK022" };
  var SHAPES = { CK001: ["straight", "up"], CK002: ["straight", "down"], CK011: ["weak", "up"], CK021: ["strong", "up"], CK022: ["strong", "down"], TEZOE26002: ["straight", "down"] };
  var MUTATION_FIELDS = {
    order: ["materialId", "orderDate", "quantity", "expectedDate", "note"],
    adjust: ["materialId", "date", "quantity", "note"],
    receive: ["orderId", "date", "quantity", "note"],
    cancel: ["orderId", "date", "note"],
    editOrder: ["orderId", "quantity", "expectedDate", "expectedRevision"],
    stockNote: ["materialId", "note", "expectedRevision"]
  };
  function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
  function key(value) { return text(value).normalize("NFKC").toLowerCase().replace(/[‐‑–−－]/g, "-"); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function japanDate(value) { return new Date(Date.parse(value) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); }
  function catalog() { return clone(CATALOG); }
  function hasMaterial(id) { return CATALOG.some(function (material) { return material.id === id; }); }
  function fail(message) { throw new Error("MATERIAL_INVALID: " + message); }
  function integer(value, allowZero, signed) {
    if (typeof value === "boolean" || value === "" || value === null || value === undefined) fail("数量を整数で入力してください。");
    var number = Number(value);
    if (!Number.isSafeInteger(number) || Math.abs(number) > 1000000 || (!signed && number < 0) || (!allowZero && number === 0)) fail("数量は1〜1000000の整数で入力してください（調整は負数も使用できます）。");
    return number;
  }
  function safeSum(left, right) { var result = left + right; if (!Number.isSafeInteger(result)) fail("累計数量が上限を超えています。"); return result; }
  function isoDate(value, label) {
    var date = text(value), match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var parsed = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (!match || parsed.toISOString().slice(0, 10) !== date) fail((label || "日付") + "を正しい日付で入力してください。");
    return date;
  }
  function expectedOrderDate(value, orderDate) {
    var date = isoDate(value, "入庫予定日");
    if (date < orderDate) fail("入庫予定日は発注日以降にしてください。");
    return date;
  }
  function checkExpectedRevision(expected, actual, target) {
    if (expected !== undefined && text(expected) !== actual) fail("別の端末で" + target + "が更新されました。画面を更新してからやり直してください。");
  }
  function shapeParts(value) {
    var valueKey = key(value), curves = [], directions = [];
    if (/弱[弯湾彎曲]|weak/.test(valueKey)) curves.push("weak");
    if (/強[弯湾彎曲]|strong/.test(valueKey)) curves.push("strong");
    if (/直(?:型|線|[・･\s]|$|(?=[上下]))|ストレート|straight/.test(valueKey)) curves.push("straight");
    if (/上向|上(?:型|[・･\s]|$)|\bup\b/.test(valueKey)) directions.push("up");
    if (/下向|下(?:型|[・･\s]|$)|\bdown\b/.test(valueKey)) directions.push("down");
    return { curve: curves.length === 1 ? curves[0] : "", direction: directions.length === 1 ? directions[0] : "", ambiguous: curves.length > 1 || directions.length > 1 };
  }
  var PRODUCT_FIELDS = ["customer", "product", "productCode", "specLength", "specShape", "bladeWidth"];
  function productIdentity(job) {
    var result = {};
    PRODUCT_FIELDS.forEach(function (name) { result[name] = text(job && job[name]); });
    return result;
  }
  function productKey(job) { return hash(PRODUCT_FIELDS.map(function (name) { return text(job && job[name]).normalize("NFKC").toLowerCase(); })); }
  function isProductExcluded(job, rules) {
    if (!rules || !rules.length) return false;
    var identity = productKey(job);
    return rules.some(function (rule) { return rule.key === identity; });
  }
  // Decisions are append-only and separate from stock movements and job history.
  function exclusions(records) {
    var active = {}, seenIds = {}, seenRequests = {};
    (records || []).forEach(function (record) {
      if (!record || !text(record.id) || seenIds[record.id] || !text(record.requestId) || seenRequests[record.requestId] || !/^[a-f0-9]{64}$/.test(record.requestHash) || ["exclude", "restore", "noop"].indexOf(record.action) < 0 || !text(record.at) || !isFinite(Date.parse(record.at)) || !record.product || !text(record.product.product)) fail("材料対象外の登録履歴が不正または重複しています。管理者に確認してください。");
      var product = productIdentity(record.product);
      if (JSON.stringify(product).length > 15000 || PRODUCT_FIELDS.some(function (name) { return typeof record.product[name] !== "string"; })) fail("材料対象外の製品情報が不正です。");
      seenIds[record.id] = true;
      seenRequests[record.requestId] = true;
      var identity = productKey(product);
      if (record.action === "exclude") active[identity] = Object.assign({ id: text(record.id), key: identity, at: text(record.at), actor: text(record.actor) }, product);
      else if (record.action === "restore") delete active[identity];
    });
    return Object.keys(active).map(function (identity) { return active[identity]; });
  }
  function prepareExclusion(input, options) {
    input = input || {}; options = options || {};
    var records = options.records || [], rules = exclusions(records), action = text(input.action), requestId = text(input.requestId);
    if (!requestId || requestId.length > 120 || ["exclude", "restore"].indexOf(action) < 0 || !/^[a-f0-9]{64}$/.test(input.productKey)) fail("製品を特定できません。材料在庫を更新してから再試行してください。");
    var requestHash = hash({ action: action, productKey: input.productKey, jobId: text(input.jobId), ruleId: text(input.ruleId) });
    var prior = records.filter(function (record) { return record.requestId === requestId; })[0];
    if (prior) { if (prior.requestHash !== requestHash) fail("同じリクエストIDで異なる内容は保存できません。"); return { record: null, retry: true }; }
    var current = rules.filter(function (rule) { return rule.key === input.productKey; })[0], recordAction = action, product;
    if (action === "exclude") {
      var job = (options.jobs || []).filter(function (entry) { return text(entry.id) === text(input.jobId) && !entry.archived; })[0];
      if (!job || productKey(job) !== input.productKey) fail("注文の製品情報が更新されています。材料在庫を更新してから登録してください。");
      if (current) {
        // Persist the request so a retry after a restore cannot create a new rule.
        recordAction = "noop";
      } else {
        var resolution = resolve(job);
        if (!jobState(job) || !resolution.target || resolution.materialId) fail("材料の確認が必要な案件ではありません。材料在庫を更新してください。");
        if ((options.jobs || []).some(function (entry) { var state = jobState(entry); return productKey(entry) === input.productKey && state && state.allocation.length; })) fail("同じ製品に材料の引当が残っています。注文情報と材料履歴を確認してください。");
      }
      product = productIdentity(job);
    } else {
      if (!current || current.id !== text(input.ruleId)) fail("対象外の登録が別の画面で更新されています。材料在庫を更新してから取り消してください。");
      product = productIdentity(current);
    }
    var record = { id: text(options.id) || requestId, requestId: requestId, requestHash: requestHash, action: recordAction, product: product, at: text(options.at) || new Date().toISOString(), actor: text(options.actor) };
    exclusions(records.concat([record]));
    return { record: record, retry: false };
  }
  function resolve(job, excludedProducts) {
    job = job || {};
    if (isProductExcluded(job, excludedProducts)) return { materialId: "", quantity: 0, target: false, reason: "碓井材料を使わない製品として登録されています。" };
    var product = key(job.product), rawCode = key(job.productCode).replace(/[\s-]/g, "").toUpperCase();
    var family = /tezoe|テゾエ|テッツェ/.test(product) ? "tezoe" : /慈大式/.test(product) && /彫骨器|スタンツェ/.test(product) ? "jikei" : "";
    var embedded = product.toUpperCase().match(/(?:^|[^A-Z0-9])(CK0\d{2}|260\d{2})(?=$|[^A-Z0-9])/g) || [];
    var embeddedCodes = embedded.map(function (value) { return value.match(/CK0\d{2}|260\d{2}/)[0]; });
    if (/^TEZOE260\d{2}$/.test(rawCode)) { if (!family) family = "tezoe"; rawCode = rawCode.slice(5); }
    var code = rawCode || (embeddedCodes.length === 1 ? embeddedCodes[0] : "");
    var target = !!family || /^CK0\d{2}$/.test(code) || embeddedCodes.length > 0;
    function unresolved(reason) { return { materialId: "", quantity: 0, target: target, reason: reason }; }
    if (!target) return unresolved("");
    if (embeddedCodes.length > 1 || embeddedCodes.some(function (embeddedCode) { return code && embeddedCode !== code; })) return unresolved("製品番号が複数あり材料を特定できません。");
    if (/アリジ|白銅/.test(product)) return unresolved("碓井以外の材料は在庫管理の対象外です。");
    if (/^CK/.test(code) && !(family === "jikei" || (!family && /彫骨器/.test(product)))) return unresolved("製品番号と製品名の組み合わせを確認してください。");
    if (/^260/.test(code) && family !== "tezoe") return unresolved("260系番号はTezoe製品名の確認が必要です。");
    if (family === "tezoe" && /^CK/.test(code) || family === "jikei" && /^260/.test(code)) return unresolved("製品番号と製品名の組み合わせを確認してください。");
    var shape = shapeParts(text(job.specShape) + " " + product);
    if (shape.ambiguous) return unresolved("型・向きが複数あり材料を特定できません。");
    // Weak-bend-down products do not currently consume any material in this
    // inventory. Keep conflicting codes/specifications in the confirmation flow.
    var excludedWeakDownCode = code === "CK012" || code === "26012";
    var weakDown = shape.curve === "weak" && shape.direction === "down";
    if ((excludedWeakDownCode && (!shape.curve || shape.curve === "weak") && (!shape.direction || shape.direction === "down")) ||
        (!code && family && weakDown)) {
      return { materialId: "", quantity: 0, target: false, reason: "弱弯・下向は現在の材料在庫の対象外です。" };
    }
    var materialId = CODE_MAP[code] || "";
    if (code && !materialId) return unresolved("この製品番号の材料は未登録です。自動で代用しません。");
    if (!materialId && family && shape.curve && shape.direction) {
      materialId = Object.keys(SHAPES).filter(function (id) { return SHAPES[id][0] === shape.curve && SHAPES[id][1] === shape.direction && (family === "tezoe" ? id !== "CK002" : id !== "TEZOE26002"); })[0] || "";
    }
    if (!materialId) return unresolved("型・向きまたは製品番号を確認してください。");
    if (shape.curve && shape.curve !== SHAPES[materialId][0] || shape.direction && shape.direction !== SHAPES[materialId][1]) return unresolved("製品番号と型・向きが一致しません。");
    var quantity = Number(job.quantity);
    if (job.quantity === "" || job.quantity === null || job.quantity === undefined || typeof job.quantity === "boolean" || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000) return unresolved("材料使用数を計算するため数量を整数で確認してください。");
    return { materialId: materialId, quantity: quantity, target: true, reason: "" };
  }
  function allocationFor(job, excludedProducts) { var resolved = resolve(job, excludedProducts); return resolved.materialId && resolved.quantity ? [{ materialId: resolved.materialId, quantity: resolved.quantity }] : []; }
  function normalizeAllocation(value) {
    if (!Array.isArray(value)) fail("案件の材料割当が不正です。");
    var seen = {};
    return value.map(function (allocation) {
      if (!allocation || !hasMaterial(allocation.materialId) || seen[allocation.materialId]) fail("案件の材料割当が不正です。");
      seen[allocation.materialId] = true;
      return { materialId: allocation.materialId, quantity: integer(allocation.quantity, false, false) };
    });
  }
  function normalizeState(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string") { try { value = JSON.parse(value); } catch (error) { fail("案件の材料履歴を読み取れません。管理者に確認してください。"); } }
    if (!value || value.version !== 1 || !Array.isArray(value.history) || !Array.isArray(value.requests) || !value.baseline) fail("案件の材料履歴形式が不正です。");
    var normalized = { version: 1, baseline: { allocation: normalizeAllocation(value.baseline.allocation), at: text(value.baseline.at) }, allocation: normalizeAllocation(value.allocation), history: [], requests: [] };
    if (Object.prototype.hasOwnProperty.call(value.baseline, "unresolvedTargetQuantity")) {
      normalized.baseline.unresolvedTargetQuantity = value.baseline.unresolvedTargetQuantity === null ? null : integer(value.baseline.unresolvedTargetQuantity, true, false);
      if (normalized.baseline.allocation.length || normalized.allocation.length || value.history.length) fail("既存案件の未確認材料基準が不正です。");
    }
    var balances = {}, seen = {};
    normalized.baseline.allocation.forEach(function (allocation) { balances[allocation.materialId] = allocation.quantity; });
    normalized.history = value.history.map(function (event) {
      if (!event || ["use", "release"].indexOf(event.action) < 0 || !hasMaterial(event.materialId) || !text(event.id) || seen[event.id] || !text(event.at) || !isFinite(Date.parse(event.at))) fail("案件の材料履歴が不正です。");
      seen[event.id] = true;
      var normalizedEvent = { id: text(event.id), action: event.action, materialId: event.materialId, quantity: integer(event.quantity, false, false), at: text(event.at), date: isoDate(event.date), actor: text(event.actor), jobId: text(event.jobId), product: text(event.product), customer: text(event.customer), serialNo: text(event.serialNo), orderId: "", note: text(event.note) };
      balances[event.materialId] = safeSum(balances[event.materialId] || 0, (event.action === "use" ? 1 : -1) * normalizedEvent.quantity);
      if (balances[event.materialId] < 0) fail("案件の材料割当と履歴が一致しません。");
      return normalizedEvent;
    });
    CATALOG.forEach(function (material) {
      var allocation = normalized.allocation.filter(function (entry) { return entry.materialId === material.id; })[0];
      if ((balances[material.id] || 0) !== (allocation ? allocation.quantity : 0)) fail("案件の材料割当と履歴が一致しません。");
    });
    var seenRequests = {};
    normalized.requests = value.requests.map(function (request) {
      if (!request || !text(request.requestId) || text(request.requestId).length > 120 || !/^[a-f0-9]{64}$/.test(request.hash) || seenRequests[request.requestId]) fail("案件の材料保存リクエストが不正です。");
      seenRequests[request.requestId] = true;
      return { requestId: request.requestId, hash: request.hash };
    });
    if (JSON.stringify(normalized).length > MAX_JSON) fail("材料履歴が保存上限に達しました。履歴を保持したまま管理者へ確認してください。");
    return normalized;
  }
  function jobState(job) { return normalizeState(job && (job.materials !== undefined ? job.materials : job.materialsJson !== undefined ? job.materialsJson : job._materialsJsonRaw)); }
  function transitionJob(previous, next, options) {
    options = options || {};
    var at = text(options.at) || new Date().toISOString(), state = jobState(previous);
    if (!state) {
      var historical = previous || (options.baselineOnly ? next : null);
      state = { version: 1, baseline: { allocation: historical ? allocationFor(historical) : [], at: at }, allocation: historical ? allocationFor(historical) : [], history: [], requests: [] };
      var historicResolution = historical && resolve(historical);
      if (historicResolution && historicResolution.target && !historicResolution.materialId) {
        var historicQuantity = Number(historical.quantity);
        state.baseline.unresolvedTargetQuantity = historical.quantity !== "" && historical.quantity !== null && historical.quantity !== undefined && typeof historical.quantity !== "boolean" && Number.isSafeInteger(historicQuantity) && historicQuantity >= 0 && historicQuantity <= 1000000 ? historicQuantity : null;
      }
    }
    else state = clone(state);
    if (options.baselineOnly) return normalizeState(state);
    var requestId = text(options.requestId);
    if (requestId) {
      if (requestId.length > 120 || !/^[a-f0-9]{64}$/.test(options.requestHash)) fail("保存リクエストが不正です。");
      var savedRequest = state.requests.filter(function (request) { return request.requestId === requestId; })[0];
      if (savedRequest) { if (savedRequest.hash !== options.requestHash) fail("同じリクエストIDで異なる内容は保存できません。"); return normalizeState(state); }
    }
    // Retain the opening quantity while a product exclusion can be reversed.
    if (Object.prototype.hasOwnProperty.call(state.baseline, "unresolvedTargetQuantity") && !isProductExcluded(next, options.exclusions)) {
      var clarified = resolve(next);
      if (clarified.materialId) {
        // Old unresolved orders were already reflected in the image balance.
        // Learning their missing specification must not charge them a second time.
        var baselineQuantity = state.baseline.unresolvedTargetQuantity === null ? clarified.quantity : state.baseline.unresolvedTargetQuantity;
        state.baseline.allocation = baselineQuantity ? [{ materialId: clarified.materialId, quantity: baselineQuantity }] : [];
        state.allocation = clone(state.baseline.allocation);
        delete state.baseline.unresolvedTargetQuantity;
      } else if (!clarified.target) delete state.baseline.unresolvedTargetQuantity;
    }
    var nextAllocation = allocationFor(next, options.exclusions), before = {}, after = {};
    state.allocation.forEach(function (allocation) { before[allocation.materialId] = allocation.quantity; });
    nextAllocation.forEach(function (allocation) { after[allocation.materialId] = allocation.quantity; });
    CATALOG.forEach(function (material) {
      var delta = (after[material.id] || 0) - (before[material.id] || 0);
      if (!delta) return;
      state.history.push({ id: text(options.eventId || requestId || next.id || "job") + ":" + (state.history.length + 1), action: delta > 0 ? "use" : "release", materialId: material.id, quantity: Math.abs(delta), at: at, date: japanDate(at), actor: text(options.actor), jobId: text(next.id), product: text(next.product), customer: text(next.customer), serialNo: text(next.serialNo), note: delta > 0 ? "注文確定・変更による材料使用" : "注文数量・材料変更による使用数訂正" });
    });
    state.allocation = nextAllocation;
    if (requestId) state.requests.push({ requestId: requestId, hash: options.requestHash });
    return normalizeState(state);
  }
  function stable(value) {
    if (Array.isArray(value)) return "[" + value.map(function (entry) { return stable(entry === undefined ? null : entry); }).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).filter(function (name) { return value[name] !== undefined; }).sort().map(function (name) { return JSON.stringify(name) + ":" + stable(value[name]); }).join(",") + "}";
    return JSON.stringify(value);
  }
  // Portable SHA-256 avoids storing a complete order copy for every retry key.
  function hash(value) {
    var input = unescape(encodeURIComponent(stable(value))), words = [], length = input.length * 8, primes = [], candidate = 2, index, j;
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
  function jobRequestHash(input) {
    var payload = {};
    Object.keys(input || {}).forEach(function (name) { if (name !== "requestId" && name !== "materials" && name !== "materialsJson" && name !== "productMaster" && name.charAt(0) !== "_") payload[name] = input[name]; });
    return hash(payload);
  }
  function findRequest(jobs, requestId, requestHash) {
    if (!requestId) return null;
    var found = null;
    (jobs || []).forEach(function (job) {
      var state = jobState(job), request = state && state.requests.filter(function (entry) { return entry.requestId === requestId; })[0];
      if (!request) return;
      if (request.hash !== requestHash || found) fail("同じリクエストIDで異なる内容は保存できません。");
      found = job;
    });
    return found;
  }
  function openingEvents(options) {
    options = options || {};
    var at = text(options.at) || new Date().toISOString();
    return CATALOG.map(function (material) { return { id: "opening-v1:" + material.id, requestId: "opening-v1:" + material.id, requestHash: hash({ materialId: material.id, quantity: material.openingQuantity, note: SOURCE_NOTE }), action: "opening", date: japanDate(at), at: at, materialId: material.id, quantity: material.openingQuantity, orderId: "", orderDate: "", expectedDate: "", note: SOURCE_NOTE, actor: text(options.actor) }; });
  }
  function replay(events) {
    var quantities = {}, orders = [], orderMap = Object.create(null), seen = Object.create(null), seenIds = Object.create(null), opening = {}, stockNotes = {}, history = [];
    CATALOG.forEach(function (material) { quantities[material.id] = 0; });
    (events || []).forEach(function (source) {
      var event = clone(source);
      if (!event.id || seenIds[event.id] || !event.requestId || seen[event.requestId] || !hasMaterial(event.materialId) || !text(event.at) || !isFinite(Date.parse(event.at)) || (event.action !== "opening" && !Array.isArray(MUTATION_FIELDS[event.action])) || !/^[a-f0-9]{64}$/.test(event.requestHash)) fail("材料履歴が不正または重複しています。管理者に確認してください。");
      seen[event.requestId] = event;
      seenIds[event.id] = true;
      event.date = isoDate(event.date);
      event.quantity = integer(event.quantity, event.action === "opening" || event.action === "stockNote", event.action === "adjust");
      if (event.action === "opening") {
        if (opening[event.materialId]) fail("材料の初期在庫が重複しています。");
        opening[event.materialId] = event;
        quantities[event.materialId] = safeSum(quantities[event.materialId], event.quantity);
      } else if (event.action === "order") {
        if (!event.orderId || orderMap[event.orderId]) fail("材料発注が重複しています。");
        var orderDate = isoDate(event.orderDate);
        var order = { id: event.orderId, revision: event.id, materialId: event.materialId, orderDate: orderDate, quantity: event.quantity, expectedDate: expectedOrderDate(event.expectedDate, orderDate), receivedQuantity: 0, remainingQuantity: event.quantity, canceledQuantity: 0, note: text(event.note) };
        orderMap[order.id] = order;
        orders.push(order);
      } else if (event.action === "adjust") {
        quantities[event.materialId] = safeSum(quantities[event.materialId], event.quantity);
      } else if (event.action === "stockNote") {
        stockNotes[event.materialId] = event;
      } else {
        var referenced = orderMap[event.orderId];
        if (!referenced || referenced.materialId !== event.materialId || (referenced.canceledQuantity > 0 && referenced.remainingQuantity === 0)) fail("材料履歴に対象の発注がありません。管理者に確認してください。");
        if (event.action === "receive") {
          referenced.receivedQuantity = safeSum(referenced.receivedQuantity, event.quantity);
          quantities[event.materialId] = safeSum(quantities[event.materialId], event.quantity);
        } else if (event.action === "editOrder") {
          referenced.expectedDate = expectedOrderDate(event.expectedDate, referenced.orderDate);
          referenced.quantity = event.quantity;
          referenced.revision = event.id;
        } else {
          if (event.quantity > referenced.remainingQuantity) fail("材料の取消が発注残を超えています。");
          referenced.canceledQuantity += event.quantity;
        }
        referenced.remainingQuantity = Math.max(0, referenced.quantity - referenced.receivedQuantity - referenced.canceledQuantity);
      }
      history.push(Object.assign({ jobId: "", product: "", customer: "", serialNo: "", orderId: "" }, event));
    });
    return { quantities: quantities, orders: orders, orderMap: orderMap, requests: seen, opening: opening, stockNotes: stockNotes, history: history };
  }
  function prepareMutation(action, input, options) {
    input = input || {}; options = options || {};
    var requestId = text(input.requestId);
    if (!requestId || requestId.length > 120) fail("操作のリクエストIDがありません。");
    var requestPayload = { action: action }, names = MUTATION_FIELDS[action];
    if (!Array.isArray(names)) fail("不明な材料操作です。");
    names.forEach(function (name) { requestPayload[name] = input[name] === undefined ? "" : input[name]; });
    var requestHash = hash(requestPayload), state = replay(options.events || []), prior = state.requests[requestId];
    if (prior) { if (prior.requestHash !== requestHash) fail("同じリクエストIDで異なる内容は保存できません。"); return { event: null, retry: true }; }
    var note = action === "editOrder" ? "" : text(input.note);
    if (note.length > 1000) fail("備考・理由は1000文字以内にしてください。");
    if ((action === "adjust" || action === "cancel") && !note) fail("在庫調整・発注取消の理由を入力してください。");
    var at = text(options.at) || new Date().toISOString();
    var materialId = text(input.materialId), orderId = "", expectedDate = "", orderDate = "", quantity;
    if (action === "receive" || action === "cancel" || action === "editOrder") {
      orderId = text(input.orderId);
      var order = state.orderMap[orderId];
      if (!order || order.canceledQuantity > 0) fail("対象の発注が見つからないか取り消されています。画面を更新してください。");
      materialId = order.materialId;
      if (action === "cancel" && order.remainingQuantity <= 0) fail("取り消せる発注残がありません。画面を更新してください。");
      if (action === "editOrder") {
        checkExpectedRevision(input.expectedRevision, order.revision, "発注内容");
        expectedDate = expectedOrderDate(input.expectedDate, order.orderDate);
      }
      quantity = action === "cancel" ? order.remainingQuantity : integer(input.quantity, false, false);
    } else if (action === "stockNote") {
      var stockNote = state.stockNotes[materialId];
      checkExpectedRevision(input.expectedRevision, stockNote ? stockNote.id : "", "在庫の備考");
      quantity = 0;
    } else {
      quantity = integer(input.quantity, false, action === "adjust");
      if (action === "order") {
        orderDate = isoDate(input.orderDate, "発注日");
        expectedDate = expectedOrderDate(input.expectedDate, orderDate);
      }
    }
    if (!hasMaterial(materialId)) fail("材料を選択してください。");
    var id = text(options.id) || requestId;
    var date = action === "order" ? orderDate : action === "editOrder" || action === "stockNote" ? japanDate(at) : isoDate(input.date);
    var event = { id: id, requestId: requestId, requestHash: requestHash, action: action, date: date, at: at, materialId: materialId, quantity: quantity, orderId: action === "order" ? id : orderId, orderDate: orderDate, expectedDate: expectedDate, note: note, actor: text(options.actor) };
    if (JSON.stringify(event).length > MAX_JSON) fail("材料履歴が大きすぎます。");
    return { event: event, retry: false };
  }
  function snapshot(options) {
    options = options || {};
    var state = replay(options.events || []), history = state.history.slice(), unresolved = [];
    (options.jobs || []).forEach(function (job) {
      var materials = jobState(job), resolved = resolve(job, options.exclusions);
      if (materials && !job.archived && resolved.target && !resolved.materialId) unresolved.push(Object.assign({ id: text(job.id), productKey: productKey(job), serialNo: text(job.serialNo), quantity: job.quantity, reason: resolved.reason }, productIdentity(job)));
      if (!materials) return;
      materials.history.forEach(function (event) { state.quantities[event.materialId] = safeSum(state.quantities[event.materialId], (event.action === "use" ? -1 : 1) * event.quantity); history.push(clone(event)); });
    });
    var materials = catalog().map(function (material) {
      var orders = state.orders.filter(function (order) { return order.materialId === material.id && order.remainingQuantity > 0; });
      var stockNote = state.stockNotes[material.id];
      material.openingQuantity = state.opening[material.id] ? state.opening[material.id].quantity : 0;
      material.stockQuantity = state.quantities[material.id];
      material.onOrderQuantity = orders.reduce(function (sum, order) { return safeSum(sum, order.remainingQuantity); }, 0);
      material.nextExpectedDate = orders.map(function (order) { return order.expectedDate; }).filter(Boolean).sort()[0] || "";
      material.shortageQuantity = Math.max(0, -material.stockQuantity);
      material.note = stockNote ? text(stockNote.note) : "";
      material.noteRevision = stockNote ? stockNote.id : "";
      return material;
    });
    history.sort(function (a, b) { return text(b.at || b.date).localeCompare(text(a.at || a.date)) || text(b.id).localeCompare(text(a.id)); });
    return { materials: materials, orders: state.orders, history: history, unresolved: unresolved, excludedProducts: clone(options.exclusions || []), initializedAt: Object.keys(state.opening).map(function (id) { return state.opening[id].at; }).sort()[0] || "" };
  }
  return Object.freeze({ catalog: catalog, resolve: resolve, productKey: productKey, exclusions: exclusions, prepareExclusion: prepareExclusion, normalizeState: normalizeState, transitionJob: transitionJob, jobRequestHash: jobRequestHash, findRequest: findRequest, openingEvents: openingEvents, prepareMutation: prepareMutation, snapshot: snapshot, hash: hash });
}());
if (typeof globalThis !== "undefined") globalThis.MaterialInventory = MaterialInventory;
