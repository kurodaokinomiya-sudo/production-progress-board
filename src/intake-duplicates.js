/* Shared by the browser, MockApi and Apps Script. Order content alone is not an identity. */
var IntakeDuplicates = (function () {
  "use strict";

  function text(value) {
    return String(value === undefined || value === null ? "" : value).trim();
  }

  function key(value) {
    var valueText = text(value);
    try { valueText = valueText.normalize("NFKC"); } catch (ignore) { /* Keep the original on older engines. */ }
    return valueText.replace(/[‐‑–−－]/g, "-").replace(/[\s\u3000]+/g, "").toLocaleLowerCase("ja");
  }

  function first(source, names) {
    for (var index = 0; index < names.length; index += 1) {
      if (text(source && source[names[index]])) return text(source[names[index]]);
    }
    return "";
  }

  function identity(order) {
    order = order || {};
    return {
      customer: text(order.customer),
      serialNo: text(order.serialNo),
      externalOrderNo: first(order, ["externalOrderNo", "externalOrderId", "purchaseOrderNo", "orderNo", "purchaseNo"]),
      externalLineNo: first(order, ["externalLineNo", "externalLineId", "orderLineNo", "lineNo", "itemNo"])
    };
  }

  function reasons(order, other) {
    var left = identity(order), right = identity(other), found = [];
    if (!key(left.customer) || key(left.customer) !== key(right.customer)) return found;
    if (key(left.serialNo) && key(left.serialNo) === key(right.serialNo)) {
      found.push("同じ得意先・連番（" + left.serialNo + "）");
    }
    if (key(left.externalOrderNo) && key(left.externalOrderNo) === key(right.externalOrderNo)) {
      if (key(left.externalLineNo) && key(right.externalLineNo)) {
        if (key(left.externalLineNo) === key(right.externalLineNo)) found.push("同じ得意先・外部注文番号・明細番号（" + left.externalOrderNo + " / " + left.externalLineNo + "）");
      } else {
        found.push("同じ得意先・外部注文番号（" + left.externalOrderNo + "、明細番号を確認）");
      }
    }
    return found;
  }

  function summary(kind, id, status, order, matchReasons) {
    var orderIdentity = identity(order);
    return {
      kind: kind, id: text(id), status: status,
      customer: orderIdentity.customer, serialNo: orderIdentity.serialNo,
      externalOrderNo: orderIdentity.externalOrderNo, externalLineNo: orderIdentity.externalLineNo,
      product: text(order.product), productCode: text(order.productCode), quantity: order.quantity === undefined || order.quantity === null ? "" : order.quantity,
      dueDate: text(order.dueDate), reasons: matchReasons,
      version: Number(order.version || 0)
    };
  }

  function fingerprint(order) {
    var orderIdentity = identity(order);
    return [key(orderIdentity.customer), key(orderIdentity.serialNo), key(orderIdentity.externalOrderNo), key(orderIdentity.externalLineNo),
      text(order.product), text(order.productCode), text(order.quantity), text(order.dueDate)];
  }

  function hash(value) {
    var firstHash = 2166136261, secondHash = 5381;
    for (var index = 0; index < value.length; index += 1) {
      firstHash = Math.imul(firstHash ^ value.charCodeAt(index), 16777619);
      secondHash = Math.imul(secondHash, 33) ^ value.charCodeAt(index);
    }
    return (firstHash >>> 0).toString(16) + "-" + (secondHash >>> 0).toString(16);
  }

  function inspect(options) {
    options = options || {};
    var order = options.order || {}, intakeId = text(options.intakeId), matches = [];
    var batchItems = Array.isArray(options.batchItems) ? options.batchItems : [];
    var batchById = Object.create(null);
    batchItems.forEach(function(entry) { if (entry) batchById[text(entry.intakeId)] = entry; });
    (options.jobs || []).forEach(function(job) {
      if (!job || (text(job.sourceType) === "intake" && text(job.sourceRef) === intakeId)) return;
      var matchReasons = reasons(order, job);
      if (!matchReasons.length) return;
      var status = job.archived === true || text(job.archived).toLowerCase() === "true" ? "archived"
        : job.shippingStatus === "shipped" ? "completed" : "active";
      matches.push(summary("job", job.id, status, job, matchReasons));
    });
    var seenIntakes = Object.create(null);
    (options.intakes || []).forEach(function(item) {
      if (!item || text(item.id) === intakeId || text(item.status || "pending") !== "pending") return;
      var otherId = text(item.id), batch = batchById[otherId];
      seenIntakes[otherId] = true;
      var otherOrder = batch ? (batch.order || {}) : (item.parsed || {});
      var matchReasons = reasons(order, otherOrder);
      if (matchReasons.length) matches.push(summary(batch ? "batch" : "intake", otherId, "pending", otherOrder, matchReasons));
    });
    // Also cover edited batch rows when the caller only supplied a pending subset.
    batchItems.forEach(function(entry) {
      if (!entry || text(entry.intakeId) === intakeId || seenIntakes[text(entry.intakeId)]) return;
      var matchReasons = reasons(order, entry.order || {});
      if (matchReasons.length) matches.push(summary("batch", entry.intakeId, "pending", entry.order || {}, matchReasons));
    });
    matches.sort(function(left, right) {
      var leftKey = left.kind + ":" + left.id, rightKey = right.kind + ":" + right.id;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    var signatureValue = JSON.stringify([intakeId, fingerprint(order), matches.map(function(match) {
      return [match.kind, match.id, match.status, match.version, fingerprint(match), match.reasons];
    })]);
    return {
      matches: matches,
      duplicateSignature: matches.length ? "intake-duplicate-v1:" + hash(signatureValue) : "",
      message: matches.length ? "同じ注文の可能性があります。一致する案件・候補を確認してください。" : ""
    };
  }

  function decisionAccepted(duplicate, decision) {
    return Boolean(duplicate && duplicate.matches && duplicate.matches.length && decision && decision.action === "add_separate" &&
      text(decision.signature) === duplicate.duplicateSignature);
  }

  return Object.freeze({ identity: identity, reasons: reasons, inspect: inspect, decisionAccepted: decisionAccepted });
}());
