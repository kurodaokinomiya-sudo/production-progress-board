/* Order reservations and date-based finished-stock forecasts. */
var FinishedStockOrders = (function () {
  "use strict";
  var MAX_QUANTITY = 1000000;

  function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
  function normalizedText(value) {
    var result = text(value);
    return typeof result.normalize === "function" ? result.normalize("NFKC").trim() : result;
  }
  function isStockOnly(job) {
    var customer = normalizedText(job && job.customer);
    return customer === "在庫" || customer === "在庫用";
  }
  function plannedQuantity(job) {
    return isStockOnly(job) ? quantity(job && job.quantity) : quantity(job && job.stockPlannedQuantity);
  }
  function issueRow(job, productCode, product, message) {
    return {
      jobId: text(job && job.id), customer: text(job && job.customer), serialNo: text(job && job.serialNo),
      product: product === undefined ? text(job && (job.product || job.name)) : product,
      productCode: productCode === undefined ? text(job && (job.productCode || job.code)) : productCode,
      message: message,
    };
  }
  function number(value) {
    var parsed = Number(value === undefined || value === null || value === "" ? 0 : value);
    return isFinite(parsed) ? parsed : 0;
  }
  function quantity(value) {
    var parsed = number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_QUANTITY ? parsed : 0;
  }
  function isValidQuantity(value, optional) {
    if (optional && (value === undefined || value === null || value === "")) return true;
    if (typeof value === "boolean" || value === null || value === undefined || value === "") return false;
    var parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_QUANTITY;
  }
  function date(value) {
    var candidate = text(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return "";
    var parsed = new Date(candidate + "T00:00:00Z");
    return isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : "";
  }
  function polishingReady(job) {
    var polishing = job && job.polishing || {};
    var quantity = Number(job && job.quantity);
    return Number.isSafeInteger(quantity) && quantity > 0 && polishing.sentQuantity === quantity && polishing.returnedQuantity === quantity;
  }
  function finishReady(job) {
    return !!(job && job.stages && job.stages.finish && job.stages.finish.status === "done" && polishingReady(job));
  }
  function productId(value) {
    if (value && typeof value === "object") return text(value.id || value.productId || value.code);
    return text(value);
  }
  function newestSchedules(history) {
    var schedules = Object.create(null);
    (history || []).forEach(function (event, index) {
      if (!event || event.action !== "schedule" || !text(event.jobId)) return;
      var prior = schedules[event.jobId];
      var stamp = text(event.at || event.date);
      var sequence = event.sequence === undefined || event.sequence === null || event.sequence === "" ? null : Number(event.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 0) sequence = null;
      if (!prior || sequence !== null && prior.sequence !== null && sequence > prior.sequence ||
          (sequence !== null && prior.sequence === null) ||
          (sequence === null && prior.sequence === null && (stamp > prior.stamp || stamp === prior.stamp && index < prior.index))) {
        schedules[event.jobId] = { event: event, stamp: stamp, sequence: sequence, index: index };
      }
    });
    var result = Object.create(null);
    Object.keys(schedules).forEach(function (jobId) { result[jobId] = schedules[jobId].event; });
    return result;
  }
  function historyState(history) {
    var reversed = Object.create(null), shipped = Object.create(null);
    (history || []).forEach(function (event) {
      if (!event) return;
      if (event.action === "reverse" && text(event.eventId)) reversed[text(event.eventId)] = true;
    });
    (history || []).forEach(function (event) {
      if (!event || event.action !== "ship" || reversed[text(event.id)] || !text(event.orderJobId)) return;
      var jobId = text(event.orderJobId);
      shipped[jobId] = (shipped[jobId] || 0) + quantity(event.quantity);
    });
    return { reversed: reversed, shipped: shipped };
  }
  function stableLots(snapshot) {
    return (snapshot && snapshot.lots || []).map(function (lot, index) {
      return { lot: lot, index: index, remaining: quantity(lot && lot.remainingQuantity) };
    }).filter(function (entry) { return entry.remaining > 0; }).sort(function (a, b) {
      return text(a.lot.date).localeCompare(text(b.lot.date)) || text(a.lot.at).localeCompare(text(b.lot.at)) || text(a.lot.id).localeCompare(text(b.lot.id)) || a.index - b.index;
    });
  }
  function project(baseSnapshot, jobs, options) {
    baseSnapshot = baseSnapshot || {};
    jobs = Array.isArray(jobs) ? jobs : [];
    options = options || {};
    var identify = typeof options.productFor === "function" ? options.productFor : function () { return null; };
    var history = Array.isArray(baseSnapshot.history) ? baseSnapshot.history : [];
    var schedules = newestSchedules(history), movement = historyState(history), issues = [];
    var productRows = (baseSnapshot.products || []).map(function (product) {
      return Object.assign({}, product, { reservedQuantity: 0, availableQuantity: quantity(product.stockQuantity), orderQuantity: 0, shortageQuantity: 0 });
    });
    var productsById = Object.create(null);
    productRows.forEach(function (product) { productsById[productId(product)] = product; });
    var eligibleJobs = [];

    jobs.forEach(function (job) {
      if (!job) return;
      var stockOnly = isStockOnly(job), active = !job.archived && job.shippingStatus !== "shipped";
      var existingPlan = (baseSnapshot.plans || []).find(function (plan) { return text(plan.jobId) === text(job.id); });
      var existingReceived = quantity(existingPlan && existingPlan.receivedQuantity);
      if (stockOnly && !active && plannedQuantity(job) <= existingReceived) return;
      if (!active && !stockOnly) return;
      var identity = null, identificationError = "";
      try { identity = identify(job); }
      catch (error) { identificationError = text(error && error.message || error); }
      var code = text(job.productCode || job.code);
      var productName = text(job.product || job.name);
      var looksTezoe = /tezoe/i.test(productName) || /^(?:260\d{2}|35002)$/.test(code) || quantity(job.stockPlannedQuantity) > 0;
      if (!identity) {
        if (looksTezoe) issues.push(issueRow(job, code, productName, identificationError || "Tezoe在庫品を特定できません。"));
        return;
      }
      if (!isValidQuantity(job.quantity, false) || !isValidQuantity(job.stockPlannedQuantity, true) ||
          quantity(job.stockPlannedQuantity) > quantity(job.quantity)) {
        issues.push(issueRow(job, code, productName, "製造数量または在庫予定数量が不正です。"));
        return;
      }
      var pid = productId(identity);
      if (!pid) {
        issues.push(issueRow(job, code, productName, "製品番号を特定できません。"));
        return;
      }
      var schedule = schedules[text(job.id)] || null;
      if (stockOnly) {
        if (schedule && quantity(schedule.orderQuantity) > 0) {
          issues.push(issueRow(job, code, productName, "在庫専用案件の出荷予定には注文数量0を指定してください。"));
        }
        return;
      }
      var shipped = movement.shipped[text(job.id)] || 0;
      var currentCustomerQuantity = Math.max(0, number(job.quantity) - number(job.stockPlannedQuantity));
      var ordered = schedule && schedule.orderQuantity !== undefined ? quantity(schedule.orderQuantity) : quantity(currentCustomerQuantity);
      if (shipped > ordered) issues.push(issueRow(job, code, productName, "出荷済み数量が注文数量を超えています。"));
      var remaining = Math.max(0, ordered - shipped);
      var stockTarget = schedule ? Math.max(0, quantity(schedule.stockQuantity) - shipped) : remaining;
      stockTarget = Math.min(remaining, stockTarget);
      var row = {
        job: job, productId: pid, schedule: schedule, quantity: ordered, remainingQuantity: remaining,
        shippedQuantity: shipped, stockTargetQuantity: stockTarget,
        orderProductionQuantity: Math.max(0, number(job.quantity) - number(job.stockPlannedQuantity)),
        finishReady: finishReady(job),
        shipDate: schedule ? date(schedule.shipDate) : "",
        shipmentMode: schedule ? text(schedule.shipmentMode) : "",
        completionDate: schedule && date(schedule.completionDate) || date(job.dueDate),
        hasSchedule: !!schedule,
        createdAt: text(job.createdAt),
        dueDate: date(job.dueDate),
        _tie: text(job.createdAt) || text(job.dueDate),
      };
      eligibleJobs.push(row);
      if (!productsById[pid]) {
        issues.push(issueRow(job, code, productName, "製品が在庫カタログにありません。"));
      }
    });

    eligibleJobs.sort(function (a, b) {
      return a._tie.localeCompare(b._tie) || a.dueDate.localeCompare(b.dueDate) || text(a.job.id).localeCompare(text(b.job.id));
    });
    var lots = stableLots(baseSnapshot), orders = [];
    eligibleJobs.forEach(function (entry) {
      var allocationLimit = entry.stockTargetQuantity, allocations = [], allocated = 0;
      lots.forEach(function (lotEntry) {
        if (!allocationLimit || lotEntry.remaining <= 0 || productId(lotEntry.lot.productId) !== entry.productId) return;
        var amount = Math.min(allocationLimit, lotEntry.remaining);
        allocations.push({
          lotId: text(lotEntry.lot.id), lotNo: text(lotEntry.lot.lotNo), quantity: amount,
          productionDate: text(lotEntry.lot.productionDate), date: text(lotEntry.lot.date),
          producers: Array.isArray(lotEntry.lot.producers) ? lotEntry.lot.producers.slice() : [],
          jobId: text(lotEntry.lot.jobId), serialNo: text(lotEntry.lot.serialNo), unknownOrigin: !!lotEntry.lot.unknownOrigin,
        });
        lotEntry.remaining -= amount; allocationLimit -= amount; allocated += amount;
      });
      var job = entry.job;
      orders.push({
        jobId: text(job.id), jobVersion: number(job.version), productId: entry.productId,
        customer: text(job.customer), serialNo: text(job.serialNo), dueDate: entry.dueDate,
        createdAt: entry.createdAt, quantity: entry.quantity, totalQuantity: number(job.quantity),
        remainingQuantity: entry.remainingQuantity, shippedQuantity: entry.shippedQuantity,
        stockTargetQuantity: entry.stockTargetQuantity, orderProductionQuantity: entry.orderProductionQuantity,
        allocatedQuantity: allocated, shortageQuantity: Math.max(0, entry.remainingQuantity - allocated),
        shipDate: entry.shipDate, shipmentMode: entry.shipmentMode, completionDate: entry.completionDate,
        finishReady: entry.finishReady, hasSchedule: entry.hasSchedule, allocations: allocations,
      });
      var product = productsById[entry.productId];
      if (product) {
        product.orderQuantity += entry.remainingQuantity;
        product.reservedQuantity += allocated;
        product.shortageQuantity += Math.max(0, entry.remainingQuantity - allocated);
      }
    });

    productRows.forEach(function (product) {
      product.availableQuantity = Math.max(0, quantity(product.stockQuantity) - product.reservedQuantity);
    });

    var planByJob = Object.create(null);
    (baseSnapshot.plans || []).forEach(function (plan) { planByJob[text(plan.jobId)] = plan; });
    var productions = [];
    jobs.forEach(function (job) {
      if (!job || job.archived) return;
      var stockOnly = isStockOnly(job), active = !job.archived && job.shippingStatus !== "shipped";
      var plan = planByJob[text(job.id)] || {};
      var receivedFromLots = (baseSnapshot.lots || []).filter(function (lot) { return text(lot.jobId) === text(job.id); }).reduce(function (sum, lot) { return sum + quantity(lot.quantity); }, 0);
      var received = Math.max(quantity(plan.receivedQuantity), receivedFromLots);
      var stockPlanTotal = plannedQuantity(job);
      var stockRemaining = plan.jobId ? quantity(plan.quantity) : Math.max(0, stockPlanTotal - received);
      if (!active && stockRemaining <= 0) return;
      var identity = null;
      try { identity = identify(job); } catch (error) { return; }
      if (!identity) return;
      if (!isValidQuantity(job.quantity, false) || !isValidQuantity(job.stockPlannedQuantity, true) ||
          quantity(job.stockPlannedQuantity) > quantity(job.quantity)) return;
      var pid = productId(identity), schedule = schedules[text(job.id)] || null;
      var plannedTotal = stockPlanTotal;
      if (stockOnly) stockRemaining = Math.max(0, plannedTotal - received);
      var orderProduction = stockOnly || job.shippingStatus === "shipped" ? 0 : Math.max(0, number(job.quantity) - number(job.stockPlannedQuantity));
      var producers = Object.keys(job.stages || {}).map(function (key) { return text(job.stages[key] && job.stages[key].assignee); }).filter(Boolean);
      var stageAssignees = Object.keys(job.stages || {}).reduce(function (result, key) { result[key] = text(job.stages[key] && job.stages[key].assignee); return result; }, {});
      var productionQuantity = stockRemaining + orderProduction;
      if (job.shippingStatus === "shipped" && productionQuantity === 0) return;
      productions.push({
        jobId: text(job.id), productId: pid, quantity: productionQuantity,
        stockQuantity: stockRemaining, orderProductionQuantity: orderProduction,
        totalQuantity: number(job.quantity), orderQuantity: orderProduction,
        plannedQuantity: plannedTotal, receivedQuantity: received,
        customer: text(job.customer), serialNo: text(job.serialNo), dueDate: schedule && date(schedule.completionDate) || date(job.dueDate),
        shippingStatus: text(job.shippingStatus),
        finishReady: finishReady(job), jobVersion: number(job.version), producers: Array.from(new Set(producers)), stageAssignees: stageAssignees,
      });
    });

    return { orders: orders, products: productRows, plans: (baseSnapshot.plans || []).slice(), productions: productions, issues: issues };
  }

  function forecast(baseSnapshot, requestedProductId, asof) {
    baseSnapshot = baseSnapshot || {};
    var pid = productId(requestedProductId), cutoff = date(asof);
    if (!cutoff) throw new Error("FINISHED_STOCK_FORECAST_INVALID: 基準日をYYYY-MM-DDで指定してください。");
    var product = (baseSnapshot.products || []).find(function (row) { return productId(row) === pid; });
    if (!product) throw new Error("FINISHED_STOCK_FORECAST_INVALID: 製品が見つかりません。");
    var incoming = 0;
    (baseSnapshot.productions || []).forEach(function (production) {
      if (productId(production.productId) !== pid || !date(production.dueDate) || date(production.dueDate) > cutoff) return;
      incoming += quantity(production.quantity);
    });
    var outgoing = 0, undated = 0, futureReserved = 0;
    (baseSnapshot.orders || []).forEach(function (order) {
      if (productId(order.productId) !== pid || quantity(order.remainingQuantity) <= 0) return;
      var remaining = quantity(order.remainingQuantity);
      function account(amount, targetDate) {
        if (!amount) return;
        var plannedDate = date(targetDate);
        if (!plannedDate) { outgoing += amount; undated += amount; }
        else if (plannedDate <= cutoff) outgoing += amount;
        else futureReserved += amount;
      }
      if (!order.hasSchedule) {
        account(remaining, "");
      } else if (order.shipmentMode === "split") {
        var stockPart = Math.min(remaining, quantity(order.stockTargetQuantity));
        account(stockPart, order.shipDate);
        account(remaining - stockPart, order.completionDate);
      } else {
        account(remaining, order.shipDate);
      }
    });
    var stock = quantity(product.stockQuantity);
    var projected = stock + incoming - outgoing;
    return { incomingQuantity: incoming, outgoingQuantity: outgoing, quantity: projected, undatedOrderQuantity: undated, futureReservedQuantity: futureReserved, availableQuantity: projected - futureReserved };
  }

  return { project: project, forecast: forecast, isStockOnly: isStockOnly, plannedQuantity: plannedQuantity };
}());
