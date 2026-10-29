function readIntakeLearningRules_() {
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.LEARNING);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var records = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.LEARNING_HEADERS.length).getValues();
  var rules = [];
  records.forEach(function(row) {
    if (!row[0] || !row[1]) return;
    var rule;
    try { rule = JSON.parse(String(row[1])); } catch (error) { throw new Error("保存した製品補完の形式が不正です。補完一覧を確認してください。"); }
    if (!rule || rule.key !== String(row[0])) throw new Error("保存した製品補完の識別情報が一致しません。");
    if (rule.disabled !== true) rules.push(rule);
  });
  return IntakeLearning.sanitizeRules(rules);
}

function writeIntakeLearningRule_(rule) {
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.LEARNING);
  if (!sheet) throw new Error("製品補完の保存先が見つかりません。");
  var value = JSON.stringify(rule);
  if (value.length > 15000) throw new Error("製品補完が長すぎます。備考を短くしてください。");
  var found = [];
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach(function(row, index) {
      if (String(row[0]) === rule.key) found.push(index + 2);
    });
  }
  if (found.length > 1) throw new Error("同じ製品補完が重複しています。補完一覧を確認してください。");
  var row = found.length ? found[0] : sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, APP.LEARNING_HEADERS.length).setValues(sheetValues_([[rule.key, value, rule.updatedAt]]));
}

function getIntakeLearningRules() {
  requireEditorAccess_();
  ensureSystem_();
  return { rules: readIntakeLearningRules_() };
}

function forgetIntakeLearningRule(input) {
  requireEditorAccess_();
  if (!input || typeof input.key !== "string" || !input.key || input.key.length > 2500 || typeof input.intakeId !== "string") {
    throw new Error("製品補完を特定できません。一覧を開き直してください。");
  }
  ensureSystem_();
  return withDocumentLock_(function() {
    requireEditorAccess_();
    var rules = readIntakeLearningRules_();
    var current = rules.find(function(rule) { return rule.key === input.key; });
    if (!current) return { rules: rules };
    if (current.intakeId !== input.intakeId) throw new Error("この製品補完が別の画面で更新されています。一覧を開き直してください。");
    writeIntakeLearningRule_(Object.assign({}, current, { disabled: true, updatedAt: new Date().toISOString() }));
    appendLog_("intake.learning.forget", "product", current.key, { intakeId: current.intakeId });
    return { rules: readIntakeLearningRules_() };
  });
}

// Called only after the authoritative job was saved, under the approval lock.
function learnIntakeProduct_(candidate, job, request) {
  if (request.learnProduct !== true) return "";
  var rules = readIntakeLearningRules_();
  var result = IntakeLearning.learn({ rules: rules, parsed: candidate.parsed || {}, order: job,
    intakeId: String(candidate.id), includeNote: request.learnNote === true, updatedAt: new Date().toISOString() });
  if (!result.changed) return result.message || "";
  var changedKey = result.rule ? result.rule.key : result.removedKey;
  var current = rules.find(function(rule) { return rule.key === changedKey; });
  if (!result.rule && !current) return "";
  // A newer approved correction must not be overwritten by an older candidate.
  if (current && current.intakeId !== candidate.id) {
    var revisions = candidate.parsed._learning && candidate.parsed._learning.ruleIntakeIds || {};
    var staleNote = request.learnNote === true && current.note &&
      (!result.rule || String(result.rule.note || "") !== current.note) && revisions[current.key] !== current.intakeId;
    var stale = (result.rule ? result.rule.fields : current.fields).some(function(field) {
      return String(current.target[field] || "") !== String(job[field] || "") &&
        String(current.target[field] || "") !== String(candidate.parsed[field] || "");
    });
    if (stale || staleNote) return "案件は反映しました。製品補完は別の確認で更新されているため、既存の補完を保持しました。";
  }
  if (result.removedKey) {
    writeIntakeLearningRule_(Object.assign({}, current, { disabled: true, intakeId: String(candidate.id), updatedAt: new Date().toISOString() }));
    appendLog_("intake.learning.forget", "product", changedKey, { intakeId: String(candidate.id) });
    return result.message || "この製品の補完を解除しました。";
  }
  writeIntakeLearningRule_(result.rule);
  appendLog_("intake.learning.update", "product", result.rule.key, { intakeId: String(candidate.id), fields: result.rule.fields, note: Boolean(result.rule.note) });
  return result.message || "この製品の修正を次回の取り込みに覚えました。";
}
