/* Shared, bounded product correction learning for intake review. */
var IntakeLearning = (function () {
  "use strict";

  var FIELDS = Object.freeze(["product", "productCode", "category", "specLength", "specShape", "bladeWidth"]);
  var MAX_RULES = 500;
  var MAX_FIELD = 600;
  var MAX_NOTE = 1000;
  var MAX_APPLIED_NOTE = 2000;
  var GENERIC_NAMES = /^(?:ケリソン|ケリソンパンチ|ケリソン鉗子|ケリソン骨パンチ|鋭匙|鋭匙鉗子|鉗子|パンチ|スタンツェ|スタンツェパンチ|)$/;

  function isObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function plain(value) {
    if (!isObject(value)) return {};
    var result = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (key !== "__proto__" && key !== "constructor" && key !== "prototype") result[key] = value[key];
    });
    return result;
  }

  function rawText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" && typeof value !== "number") return "";
    return String(value);
  }

  function normalizedText(value) {
    var result = rawText(value);
    try { result = result.normalize("NFKC"); } catch (ignore) { /* Older Apps Script runtime. */ }
    return result.trim().replace(/[\s\u3000]+/g, " ");
  }

  function bounded(value, maximum) {
    var result = normalizedText(value);
    return result.length <= maximum ? result : null;
  }

  function fieldValue(source, field) {
    return bounded(source && source[field], MAX_FIELD);
  }

  function stableFields(source) {
    var input = plain(source), result = {};
    FIELDS.forEach(function (field) { result[field] = fieldValue(input, field) || ""; });
    return result;
  }

  function customerValue(value) {
    return bounded(value, MAX_FIELD);
  }

  function normalizeMeasurement(value) {
    var text = normalizedText(value).toLowerCase().replace(/\s+/g, "");
    if (!text) return "";
    var match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(mm|cm|ミリ|センチ)?$/i);
    if (!match) return text;
    var number = Number(match[1]);
    if (match[2] === "cm" || match[2] === "センチ") number *= 10;
    if (!isFinite(number)) return text;
    return String(Math.round(number * 10000) / 10000);
  }

  function semantic(field, value) {
    if (field === "productCode") return normalizedText(value).toUpperCase();
    if (field === "specLength" || field === "bladeWidth") return normalizeMeasurement(value);
    return normalizedText(value);
  }

  function same(field, left, right) {
    return semantic(field, left) === semantic(field, right);
  }

  function keyFor(customer, source) {
    return JSON.stringify([normalizedText(customer), semantic("productCode", source.productCode), normalizedText(source.product)]);
  }

  function genericName(value) {
    var name = normalizedText(value).replace(/[\s　]/g, "");
    return !name || GENERIC_NAMES.test(name);
  }

  function sanitizeRule(rule) {
    if (!isObject(rule)) return null;
    var input = plain(rule), sourceInput = plain(input.source), targetInput = plain(input.target);
    var customer = customerValue(input.customer);
    if (customer === null) return null;
    var source = stableFields(sourceInput), target = stableFields(targetInput);
    var key = bounded(input.key, MAX_FIELD);
    if (!key || !customer || key !== keyFor(customer, source)) return null;
    if (!source.product || (!source.productCode && genericName(source.product))) return null;
    if (!Array.isArray(input.fields)) return null;
    var fields = [];
    input.fields.forEach(function (field) {
      if (FIELDS.indexOf(field) >= 0 && fields.indexOf(field) < 0 && !same(field, source[field], target[field])) fields.push(field);
    });
    if (!fields.length && !bounded(input.note, MAX_NOTE)) return null;
    var note = input.note === undefined || input.note === null ? "" : bounded(input.note, MAX_NOTE);
    if (note === null) return null;
    var updatedAt = bounded(input.updatedAt, 80);
    var intakeId = bounded(input.intakeId, MAX_FIELD);
    if (intakeId === null) return null;
    return {
      key: key, customer: customer, source: source, target: target, fields: fields,
      ...(note ? { note: note } : {}), updatedAt: updatedAt || "", intakeId: intakeId || ""
    };
  }

  function sanitizeRules(rules) {
    if (!Array.isArray(rules)) return [];
    var result = [];
    rules.slice(0, MAX_RULES).forEach(function (rule) {
      var clean = sanitizeRule(rule);
      if (clean) result.push(clean);
    });
    return result;
  }

  function getOriginal(parsed) {
    var input = plain(parsed), learning = plain(input._learning);
    return isObject(learning.original) ? plain(learning.original) : input;
  }

  function prepareStable(source) {
    var values = stableFields(source), overflow = FIELDS.some(function (field) { return fieldValue(source, field) === null; });
    return { values: values, overflow: overflow };
  }

  function noteCorrection(original, order, includeNote) {
    if (!includeNote) return "";
    var before = bounded(original && original.note, MAX_NOTE), after = bounded(order && order.note, MAX_NOTE);
    if (before === null || after === null) return null;
    if (same("note", before, after)) return "";
    if (before && after.indexOf(before) === 0) {
      var suffix = after.slice(before.length).replace(/^[\s/・,，;；:：\-–—]+/, "").trim();
      return suffix;
    }
    return after;
  }

  function sourceMatchesRule(rule, source) {
    return FIELDS.every(function (field) {
      var left = source[field], right = rule.source[field];
      return !left || !right || same(field, left, right) || same(field, left, rule.target[field]);
    });
  }

  function noteAlreadyPresent(note, addition) {
    var expected = normalizedText(addition);
    if (!expected) return true;
    var current = normalizedText(note);
    if (current === expected || (" / " + current + " / ").indexOf(" / " + expected + " / ") >= 0) return true;
    return current.split(/[\/・,，;；\n]+/).some(function (part) { return normalizedText(part) === expected; });
  }

  function noteAppendsToProjection(projected, finalValue) {
    var before = normalizedText(projected), after = normalizedText(finalValue);
    if (!before || after.indexOf(before) !== 0 || after === before) return false;
    return after.slice(before.length).indexOf(" / ") === 0;
  }

  function learn(options) {
    options = plain(options);
    var rules = sanitizeRules(options.rules), parsed = plain(options.parsed), order = plain(options.order);
    var original = getOriginal(parsed), originalCustomer = customerValue(original.customer), finalCustomer = customerValue(order.customer);
    var sourcePrepared = prepareStable(original), targetPrepared = prepareStable(order), parsedPrepared = prepareStable(parsed);
    if (sourcePrepared.overflow || targetPrepared.overflow || parsedPrepared.overflow || originalCustomer === null || finalCustomer === null) {
      return { rules: rules, changed: false, message: "製品情報が長すぎるため、修正を共有できません。" };
    }
    var source = sourcePrepared.values, finalValues = targetPrepared.values, projectedValues = parsedPrepared.values;
    var manualFields = FIELDS.filter(function (field) { return !same(field, projectedValues[field], finalValues[field]); });
    var manualNoteChanged = options.includeNote === true && !same("note", parsed.note, order.note);
    if (!originalCustomer || normalizedText(originalCustomer) !== normalizedText(finalCustomer)) {
      return { rules: rules, changed: false, message: "得意先が一致しないため、製品修正を共有できません。" };
    }
    if (!source.product || (!source.productCode && genericName(source.product))) {
      return { rules: rules, changed: false, message: "製品を特定できないため、修正を共有できません。" };
    }
    var parsedLearning = plain(parsed._learning), suggestedKeys = Array.isArray(parsedLearning.ruleKeys) ? parsedLearning.ruleKeys : [];
    var linked = rules.filter(function (rule) {
      if (suggestedKeys.indexOf(rule.key) < 0 || normalizedText(rule.customer) !== normalizedText(originalCustomer)) return false;
      var identity = matchRules(original, [rule]);
      return identity.matched.length === 1;
    });
    var linkedSignatures = Object.create(null);
    linked.forEach(function (rule) { linkedSignatures[ruleSignature(rule)] = true; });
    if (Object.keys(linkedSignatures).length > 1) return { rules: rules, changed: false, message: "複数の異なる製品修正に一致しました。修正を共有できません。" };
    var prior = linked.length ? linked[0] : null;
    var key = prior ? prior.key : keyFor(originalCustomer, source), intakeId = bounded(options.intakeId, MAX_FIELD);
    if (intakeId === null) return { rules: rules, changed: false, message: "取込候補を特定できないため、修正を共有できません。" };
    if (intakeId && rules.some(function (rule) { return rule.intakeId === intakeId && rule.key === key; })) {
      return { rules: rules, changed: false, message: "" };
    }
    if (!manualFields.length && !manualNoteChanged) return { rules: rules, changed: false, message: "" };
    var existingMatches = [];
    for (var index = 0; index < rules.length; index += 1) {
      if (rules[index].key === key && sourceMatchesRule(rules[index], source)) existingMatches.push(index);
    }
    if (existingMatches.length > 1) {
      var existingSignatures = Object.create(null);
      existingMatches.forEach(function (matchIndex) { existingSignatures[ruleSignature(rules[matchIndex])] = true; });
      if (Object.keys(existingSignatures).length > 1) return { rules: rules, changed: false, message: "複数の異なる製品修正に一致しました。修正を共有できません。" };
    }
    var existingIndex = existingMatches.length ? existingMatches[0] : -1;
    if (prior) existingIndex = rules.indexOf(prior);
    prior = existingIndex >= 0 ? rules[existingIndex] : null;
    var note = manualNoteChanged ? noteCorrection(parsed, order, true) : "";
    if (note === null) return { rules: rules, changed: false, message: "備考が長すぎるため、修正を共有できません。" };
    var baseline = prior ? Object.assign({}, prior.source) : source;
    var target = prior ? Object.assign({}, prior.target) : Object.assign({}, source);
    var fields = prior ? prior.fields.slice() : [];
    FIELDS.forEach(function (field) {
      if (manualFields.indexOf(field) >= 0) {
        target[field] = finalValues[field];
        if (same(field, baseline[field], finalValues[field])) fields = fields.filter(function (item) { return item !== field; });
        else if (fields.indexOf(field) < 0) fields.push(field);
      }
    });
    var mergedNote = prior && prior.note ? prior.note : "";
    if (manualNoteChanged) {
      mergedNote = note;
      if (prior && prior.note && note && noteAppendsToProjection(parsed.note, order.note) && noteAlreadyPresent(parsed.note, prior.note)) {
        if (!noteAlreadyPresent(parsed.note, note)) mergedNote = prior.note + " / " + note;
        else mergedNote = prior.note;
      }
    }
    var rule = {
      key: key, customer: originalCustomer, source: baseline, target: target,
      fields: fields, updatedAt: bounded(options.updatedAt, 80) || new Date().toISOString(), intakeId: intakeId || ""
    };
    if (mergedNote) rule.note = mergedNote;
    if (!fields.length && !mergedNote && prior) {
      var removedKey = rules[existingIndex].key;
      rules.splice(existingIndex, 1);
      return { rules: rules, changed: true, removedKey: removedKey, message: "この製品の共有修正を解除しました。" };
    }
    if (!fields.length && !mergedNote) return { rules: rules, changed: false, message: "" };
    var cleanRule = sanitizeRule(rule);
    if (!cleanRule) return { rules: rules, changed: false, message: "製品修正を安全な形式で保存できません。" };
    if (rules.length >= MAX_RULES && existingIndex < 0) return { rules: rules, changed: false, message: "共有できる製品修正が上限に達しています。" };
    if (existingIndex >= 0) rules[existingIndex] = cleanRule;
    else rules.push(cleanRule);
    return { rules: rules, changed: true, rule: cleanRule, message: "この製品の修正を次回の取り込みに覚えました。" };
  }

  function ruleSignature(rule) {
    return JSON.stringify([rule.customer, rule.source, rule.target, rule.fields, rule.note || ""]);
  }

  function matchRules(original, rules) {
    var customer = normalizedText(original.customer), code = semantic("productCode", original.productCode), name = normalizedText(original.product);
    if (!customer) return { matched: [], rejected: false };
    var codeConflict = false;
    var identityMatches = rules.filter(function (rule) {
      if (normalizedText(rule.customer) !== customer) return false;
      var codes = [semantic("productCode", rule.source.productCode), semantic("productCode", rule.target.productCode)].filter(Boolean);
      if (code) {
        if (codes.indexOf(code) >= 0) return true;
        if (name && (name === normalizedText(rule.source.product) || name === normalizedText(rule.target.product))) codeConflict = true;
        return false;
      }
      return Boolean(name && (name === normalizedText(rule.source.product) || name === normalizedText(rule.target.product)));
    });
    var compatible = [], dimensionConflict = false;
    identityMatches.forEach(function (rule) {
      var ok = ["specShape", "bladeWidth", "specLength"].every(function (field) {
        var value = normalizedText(original[field]);
        if (!value) return true;
        var source = rule.source[field], target = rule.target[field];
        if (!source && !target) return true;
        return same(field, value, source) || same(field, value, target);
      });
      if (ok) compatible.push(rule); else dimensionConflict = true;
    });
    if (!compatible.length) return { matched: [], rejected: dimensionConflict || codeConflict };
    var signatures = Object.create(null);
    compatible.forEach(function (rule) { signatures[ruleSignature(rule)] = true; });
    if (Object.keys(signatures).length > 1) return { matched: [], ambiguous: true };
    return { matched: [compatible[0]], ambiguous: false };
  }

  function originalSnapshot(source) {
    var snapshot = stableFields(source);
    snapshot.customer = normalizedText(source && source.customer);
    snapshot.note = rawText(source && source.note).slice(0, MAX_APPLIED_NOTE);
    return snapshot;
  }

  function apply(options) {
    options = plain(options);
    var parsed = plain(options.parsed), original = getOriginal(parsed), rules = sanitizeRules(options.rules);
    var snapshot = originalSnapshot(original), values = stableFields(original), selection = matchRules(original, rules);
    var status = "none", message = "", fields = [], ruleKeys = [], ruleIntakeIds = {};
    if (selection.ambiguous) {
      status = "ambiguous"; message = "複数の異なる製品修正が一致しました。原本と製品仕様を確認してください。";
    } else if (selection.rejected) {
      status = "conflict"; message = "製品仕様が共有済み修正と異なります。自動補正せず確認してください。";
    } else if (selection.matched.length) {
      var rule = selection.matched[0], proposed = Object.assign({}, values), conflict = false;
      rule.fields.forEach(function (field) {
        var incoming = values[field], sourceValue = rule.source[field], targetValue = rule.target[field];
        if (!incoming || same(field, incoming, sourceValue)) {
          proposed[field] = targetValue;
          if (!same(field, incoming, targetValue)) fields.push(field);
        } else if (same(field, incoming, targetValue)) {
          proposed[field] = incoming;
        } else {
          conflict = true;
        }
      });
      var incomingNote = rawText(parsed.note), appendedNote = incomingNote;
      if (!conflict && rule.note && !noteAlreadyPresent(incomingNote, rule.note)) {
        appendedNote = incomingNote ? incomingNote + " / " + rule.note : rule.note;
        if (appendedNote.length > MAX_APPLIED_NOTE) conflict = true;
      }
      if (conflict) {
        status = "conflict"; fields = [];
        message = rule.note && appendedNote.length > MAX_APPLIED_NOTE
          ? "備考が長いため共有修正を追加できません。元の備考を確認してください。"
          : "入力済みの製品情報が共有済み修正と異なります。自動補正せず確認してください。";
      } else {
        FIELDS.forEach(function (field) { if (fields.indexOf(field) >= 0) parsed[field] = proposed[field]; });
        if (rule.note) {
          parsed.note = appendedNote;
          if (parsed.note !== incomingNote && fields.indexOf("note") < 0) fields.push("note");
        }
        status = fields.length ? "applied" : "none";
        message = status === "applied" ? "共有済みの製品修正を候補に反映しました。" : "共有済みの製品修正と一致しています。";
        ruleKeys.push(rule.key);
        ruleIntakeIds[rule.key] = rule.intakeId || "";
      }
    }
    parsed._learning = {
      original: snapshot, status: status, fields: fields, message: message, ruleKeys: ruleKeys, ruleIntakeIds: ruleIntakeIds
    };
    return { parsed: parsed, status: status, fields: fields, message: message, ruleKeys: ruleKeys, ruleIntakeIds: ruleIntakeIds };
  }

  function promptExamples(options) {
    options = plain(options);
    var rules = sanitizeRules(options.rules), text = normalizedText(options.text), limit = Number(options.limit);
    if (!isFinite(limit) || limit < 0) limit = 20;
    limit = Math.min(20, Math.floor(limit));
    if (!text || !limit) return [];
    var examples = [], budget = 12000;
    rules.forEach(function (rule) {
      if (examples.length >= limit) return;
      var customer = normalizedText(rule.customer), sourceName = normalizedText(rule.source.product), targetName = normalizedText(rule.target.product);
      if (!customer || text.indexOf(customer) < 0 || !(sourceName && text.indexOf(sourceName) >= 0 || targetName && text.indexOf(targetName) >= 0)) return;
      var example = {
        customer: rule.customer, source: stableFields(rule.source), target: stableFields(rule.target), fields: rule.fields.slice()
      };
      var size = JSON.stringify(example).length;
      if (size > budget) return;
      examples.push(example); budget -= size;
    });
    return examples;
  }

  function remove(options) {
    options = plain(options);
    var key = bounded(options.key, MAX_FIELD);
    if (!key) return sanitizeRules(options.rules);
    return sanitizeRules(options.rules).filter(function (rule) { return rule.key !== key; });
  }

  return Object.freeze({ sanitizeRules: sanitizeRules, learn: learn, apply: apply, promptExamples: promptExamples, remove: remove });
}());

if (typeof globalThis !== "undefined") globalThis.IntakeLearning = IntakeLearning;
