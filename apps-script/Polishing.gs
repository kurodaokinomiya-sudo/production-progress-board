var POLISHING_HEADERS = Object.freeze([
  "案件ID", "得意先", "品名", "製造番号", "納期", "総数量", "発送数量", "戻り数量", "研磨屋の数量", "最終仕上げ状態", "発送日", "最終返却日", "製品番号", "研磨区分", "使用材料", "江部自由単価", "嘉代自由単価"
]);
var POLISHING_LEGACY_HEADERS_ = Object.freeze(["案件ID", "得意先", "品名", "製造番号", "納期", "総数量", "持出し数量", "戻り数量", "研磨屋の数量", "最終仕上げ状態", "最終送付日", "最終返却日"]);
var POLISHING_MIRROR_REPAIR_PROPERTY = "POLISHING_MIRROR_REPAIR_REQUIRED";

function ensurePolishingSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(APP.SHEETS.POLISHING);
  if (sheet && sheet.getLastRow()) {
    var lastColumn = sheet.getLastColumn();
    var current = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    var oldCurrentBase = POLISHING_HEADERS.slice(0, 15).every(function(header, index) { return current[index] === header; });
    var oldLegacyBase = POLISHING_LEGACY_HEADERS_.every(function(header, index) { return current[index] === header; }) && POLISHING_HEADERS.slice(12, 15).every(function(header, index) { return current[index + 12] === header; });
    if (lastColumn === 16 && ["輪レバー加算", "メニスカス加算"].indexOf(current[15]) >= 0 && (oldCurrentBase || oldLegacyBase)) {
      // Retire only the known derived surcharge column; canonical movement history is untouched.
      sheet.getRange(1, 16, sheet.getLastRow(), 1).clearContent();
      current = current.slice(0, 15);
      lastColumn = 15;
      if (typeof PropertiesService !== "undefined") {
        try { PropertiesService.getScriptProperties().setProperty(POLISHING_MIRROR_REPAIR_PROPERTY, "true"); } catch (error) {}
      }
    }
    var legacyBase = POLISHING_LEGACY_HEADERS_.every(function(header, index) { return current[index] === header; });
    var legacyTailKnown = lastColumn >= 12 && lastColumn <= POLISHING_HEADERS.length && POLISHING_HEADERS.slice(12, lastColumn).every(function(header, index) { return current[index + 12] === header; });
    var exactLegacy = legacyBase && legacyTailKnown;
    var exactOldCurrent = lastColumn === 12 && POLISHING_HEADERS.slice(0, 12).every(function(header, index) { return current[index] === header; });
    var currentPrefix = lastColumn >= 13 && lastColumn <= POLISHING_HEADERS.length && POLISHING_HEADERS.slice(0, lastColumn).every(function(header, index) { return current[index] === header; });
    if (exactLegacy) {
      // Rename only the exact legacy prefix and known appended columns; keep all row data.
      sheet.getRange(1, 1, 1, 12).setValues([POLISHING_HEADERS.slice(0, 12)]);
    } else if (exactOldCurrent) {
      // The known current twelve-column schema can be extended in place.
    } else if (!currentPrefix) {
      throw new Error("「" + APP.SHEETS.POLISHING + "」シートの見出しがアプリ形式と異なります。既存シートを保護するため自動変更を停止しました。");
    }
    if (lastColumn < POLISHING_HEADERS.length) {
      // Existing mirror rows need their new identity/class columns populated once.
      if (typeof PropertiesService !== "undefined") {
        try { PropertiesService.getScriptProperties().setProperty(POLISHING_MIRROR_REPAIR_PROPERTY, "true"); } catch (error) {}
      }
      var additions = POLISHING_HEADERS.slice(lastColumn);
      sheet.getRange(1, lastColumn + 1, 1, additions.length).setValues([additions]);
      if (sheet.getRange(1, lastColumn + 1, 1, additions.length).setFontWeight) sheet.getRange(1, lastColumn + 1, 1, additions.length).setFontWeight("bold").setBackground("#e8eefc").setFontColor("#17376d");
    }
    if (lastColumn > POLISHING_HEADERS.length && !POLISHING_HEADERS.every(function(header, index) { return current[index] === header; })) {
      throw new Error("「" + APP.SHEETS.POLISHING + "」シートに未対応の列があります。既存シートを保護するため自動変更を停止しました。");
    }
    return sheet;
  }
  return ensureSheet_(spreadsheet, APP.SHEETS.POLISHING, POLISHING_HEADERS);
}

function polishingLastEventDate_(job, action) {
  var history = action === "return" ? polishingActiveReturns_(job.polishing) : normalizePolishing_(job.polishing).history;
  for (var i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].action === action) return polishingJapanDate_(history[i].at);
  }
  return "";
}

function polishingJapanDate_(value) {
  if (!value) return "";
  return Utilities.formatDate(new Date(value), "Asia/Tokyo", "yyyy/MM/dd HH:mm");
}

function polishingFinishLabel_(job, polishing) {
  if (polishing.returnedQuantity === 0) return "—";
  return { not_started: "待ち", working: "中", done: "完了", hold: "保留" }[job.stages.finish.status] || "待ち";
}

function polishingMirrorNeedsJobUpdate_(before, after) {
  function signature(job) {
    if (!job || job.archived || !normalizePolishing_(job.polishing).history.length) return "";
    // These are the fields used by the mirror or its product-master matching.
    return JSON.stringify([job.id, job.customer, job.product, job.productCode, job.specLength,
      job.specShape, job.bladeWidth, job.note, job.serialNo, job.dueDate, job.quantity,
      job.stages.finish.status, normalizePolishing_(job.polishing)]);
  }
  return signature(before) !== signature(after);
}

function syncPolishingMirror_(lockedJobs, lockedSettings) {
  var spreadsheet = getSpreadsheet_();
  var sheet = ensurePolishingSheet_(spreadsheet);
  var allJobs = lockedJobs || readJobs_(), settings = lockedSettings || readSettings_();
  var jobs = allJobs.filter(function(job) { return !job.archived && normalizePolishing_(job.polishing).history.length > 0; });
  if (typeof decorateProductJobs_ === "function" && jobs.length) jobs = decorateProductJobs_(jobs, settings);
  jobs.sort(function(a, b) {
    return String(a.dueDate || "").localeCompare(String(b.dueDate || ""), "ja") ||
      String(a.customer || "").localeCompare(String(b.customer || ""), "ja") || String(a.serialNo || "").localeCompare(String(b.serialNo || ""), "ja");
  });
  var rows = jobs.map(function(job) {
    var polishing = normalizePolishing_(job.polishing);
    var metadata = job.productMaster || {}, customRates = metadata.classCode === "自由設定" && metadata.customRates || {};
    return [job.id, job.customer, job.product, job.serialNo, job.dueDate, job.quantity,
      polishing.sentQuantity, polishing.returnedQuantity, polishing.sentQuantity - polishing.returnedQuantity,
      polishingFinishLabel_(job, polishing), polishingLastEventDate_(job, "send"), polishingLastEventDate_(job, "return"),
      job.productCode || "", metadata.classCode || "未分類", metadata.material || "",
      customRates["江部"] === null || customRates["江部"] === undefined ? "" : customRates["江部"],
      customRates["嘉代"] === null || customRates["嘉代"] === undefined ? "" : customRates["嘉代"]];
  });
  var last = sheet.getLastRow();
  if (rows.length) sheet.getRange(2, 1, rows.length, POLISHING_HEADERS.length).setValues(sheetValues_(rows));
  // Overwrite existing rows in one write. Only removed trailing rows need a
  // clear, and a failed write no longer empties the previous readable mirror.
  if (last > rows.length + 1) sheet.getRange(rows.length + 2, 1, last - rows.length - 1, POLISHING_HEADERS.length).clearContent();
  return { count: rows.length };
}

function syncPolishingMirrorBestEffort_(lockedJobs, lockedSettings) {
  try {
    syncPolishingMirror_(lockedJobs, lockedSettings);
    try { PropertiesService.getScriptProperties().deleteProperty(POLISHING_MIRROR_REPAIR_PROPERTY); } catch (error) {}
    return "";
  } catch (error) {
    try { PropertiesService.getScriptProperties().setProperty(POLISHING_MIRROR_REPAIR_PROPERTY, "true"); } catch (propertyError) {}
    return "研磨管理シートを更新できませんでした。次回の更新時に再同期します。";
  }
}

function repairPolishingMirrorIfNeeded_() {
  if (typeof PropertiesService === "undefined") return;
  var properties;
  try { properties = PropertiesService.getScriptProperties(); } catch (error) { return; }
  if (properties.getProperty(POLISHING_MIRROR_REPAIR_PROPERTY) !== "true") return;
  try {
    withDocumentLock_(function() { syncPolishingMirror_(); });
    properties.deleteProperty(POLISHING_MIRROR_REPAIR_PROPERTY);
  } catch (error) {
    properties.setProperty(POLISHING_MIRROR_REPAIR_PROPERTY, "true");
  }
}

function polishingDateKey_(value) {
  // ISO conversion avoids dependence on the script or caller's local timezone.
  return new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function polishingDateAt_(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("研磨の日付を正しく入力してください。");
  var at = new Date(date + "T00:00:00+09:00");
  if (!isFinite(at.getTime()) || polishingDateKey_(at) !== date) throw new Error("研磨の日付を正しく入力してください。");
  if (date > polishingDateKey_(new Date())) throw new Error("研磨の日付に未来の日付は指定できません。");
  return at.toISOString();
}

function validatePolishingDates_(history) {
  var daily = Object.create(null), balance = 0;
  history.forEach(function(event) {
    var day = polishingDateKey_(event.at);
    daily[day] = (daily[day] || 0) + (event.action === "send" || event.action === "undo-return" ? event.quantity : -event.quantity);
  });
  Object.keys(daily).sort().forEach(function(day) {
    balance += daily[day];
    if (balance < 0) throw new Error("戻り日・取消日が発送日より前になる日付は指定できません。研磨履歴の日付を確認してください。");
  });
}

function savePolishingMovement(input) {
  requireEditorAccess_();
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 120) throw new Error("研磨更新の形式が不正です。");
  if (["send", "return", "cancel", "undo-return"].indexOf(input.action) < 0 || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new Error("研磨更新の形式が不正です。");
  var dated = input.date !== undefined;
  if (dated && ["send", "return"].indexOf(input.action) < 0) throw new Error("日付を指定できるのは発送・戻りだけです。");
  var movementAt = dated ? polishingDateAt_(input.date) : "";
  var ids = Object.create(null);
  input.items.forEach(function(item) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id || !Number.isInteger(item.version) || !Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("研磨数量または案件情報が不正です。");
    if (input.action === "undo-return" && (typeof item.returnRequestId !== "string" || !item.returnRequestId.trim() || item.returnRequestId.length > 120)) throw new Error("取り消す返却履歴の指定が不正です。");
    if (ids[item.id]) throw new Error("同じ案件を複数回指定できません。");
    ids[item.id] = true;
  });
  ensureSystem_();
  return withDocumentLock_(function() {
    var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.JOBS);
    var rows = readRows_(APP.SHEETS.JOBS, APP.JOB_HEADERS, true);
    var now = new Date().toISOString();
    var columns = {};
    APP.JOB_HEADERS.forEach(function(header, index) { columns[header] = index; });
    var updates = input.items.map(function(item) {
      var row = rows.find(function(record) { return String(record.id) === item.id; });
      if (!row) throw new Error("案件が見つかりません。画面を更新してください。");
      var job = jobFromRow_(row);
      var polishing = normalizePolishing_(job.polishing);
      var prior = polishing.history.find(function(event) { return event.requestId === input.requestId; });
      if (prior) {
        if (prior.action !== input.action || prior.quantity !== item.quantity || (prior.requestedDate || "") !== (input.date || "") || input.action === "undo-return" && prior.returnRequestId !== item.returnRequestId) throw new Error("同じリクエストIDが異なる研磨更新に使われています。");
        return { rowNumber: row._rowNumber, job: job, idempotent: true };
      }
      if (job.archived) throw new Error("削除済みの案件は研磨更新できません。");
      if (job.shippingStatus === "shipped") throw new Error("出荷済みの案件は研磨更新できません。");
      if (Number(item.version) !== Number(job.version || 0)) throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
      var resetFinishing = input.action === "send" || input.action === "undo-return" ||
        input.action === "return" && job.stages.finish.status === "done" && !finalFinishingReady_(job);
      var total = Number(job.quantity);
      if (input.action === "send" && (!Number.isSafeInteger(total) || total <= 0)) throw new Error("研磨へ送付するには案件の数量を正しい整数で登録してください。");
      if (input.action === "send" && !Number.isSafeInteger(polishing.sentQuantity + item.quantity) || input.action === "return" && !Number.isSafeInteger(polishing.returnedQuantity + item.quantity)) throw new Error("研磨数量が上限を超えています。");
      if (input.action === "send" && item.quantity > total - polishing.sentQuantity) throw new Error("研磨へ送付できる数量を超えています。");
      if (input.action === "return" && item.quantity > polishing.sentQuantity - polishing.returnedQuantity) throw new Error("研磨へ送付済みの未返却数量を超えています。");
      if (input.action === "cancel" && item.quantity > polishing.sentQuantity - polishing.returnedQuantity) throw new Error("取り消せる未返却数量を超えています。");
      if (input.action === "undo-return") {
        var activeReturns = polishingActiveReturns_(polishing), latestReturn = activeReturns[activeReturns.length - 1];
        if (!latestReturn || latestReturn.requestId !== item.returnRequestId) throw new Error("取り消せる最新の返却履歴が変わっています。画面を更新して内容を確認してください。");
        if (item.quantity !== latestReturn.quantity) throw new Error("返却を取り消すには、対象履歴の全数量を指定してください。");
        polishing.returnedQuantity -= item.quantity;
      }
      if (input.action === "send") polishing.sentQuantity += item.quantity;
      if (input.action === "return") polishing.returnedQuantity += item.quantity;
      if (input.action === "cancel") polishing.sentQuantity -= item.quantity;
      var event = { requestId: input.requestId, action: input.action, quantity: item.quantity, at: movementAt || now };
      if (dated) { event.requestedDate = input.date; event.recordedAt = now; }
      if (input.action === "undo-return") event.returnRequestId = item.returnRequestId;
      polishing.history.push(event);
      if (dated) validatePolishingDates_(polishing.history);
      job.polishing = polishing;
      if (resetFinishing) {
        job.stages.finish.status = "not_started";
        job.shippingStatus = "not_ready";
      }
      job.updatedAt = now;
      job.version = Number(job.version || 1) + 1;
      var rawRow = row._rawValues.slice();
      rawRow[columns.polishingJson] = JSON.stringify(polishing);
      rawRow[columns.updatedAt] = now;
      rawRow[columns.version] = job.version;
      if (resetFinishing) {
        rawRow[columns.finishStatus] = job.stages.finish.status;
        rawRow[columns.shippingStatus] = job.shippingStatus;
      }
      return { rowNumber: row._rowNumber, job: job, rawRow: rawRow, idempotent: false };
    });
    // Every item is fully checked before the first canonical write.
    updates.forEach(function(update) {
      if (update.idempotent) return;
      sheet.getRange(update.rowNumber, 1, 1, APP.JOB_HEADERS.length).setValues(sheetValues_([update.rawRow]));
    });
    SpreadsheetApp.flush();
    var settings = typeof readSettings_ === "function" ? readSettings_() : {};
    var changedRows = updates.filter(function(update) { return !update.idempotent; }).map(function(update) {
      return { rowNumber: update.rowNumber, values: update.rawRow };
    });
    var mirrorWarning = syncPolishingMirrorBestEffort_(jobsAfterRowUpdates_(rows, changedRows), settings);
    updates.forEach(function(update) {
      if (update.idempotent) return;
      var item = input.items.filter(function(item) { return item.id === update.job.id; })[0];
      var detail = { requestId: input.requestId, quantity: item.quantity, version: update.job.version };
      if (dated) detail.date = input.date;
      if (input.action === "undo-return") detail.returnRequestId = item.returnRequestId;
      appendLog_("job.polishing." + input.action, "job", update.job.id, detail);
    });
    var responseJobs = updates.map(function(update) { return update.job; });
    if (typeof decorateProductJobs_ === "function") responseJobs = decorateProductJobs_(responseJobs, settings);
    var response = { jobs: responseJobs };
    if (mirrorWarning) response.mirrorWarning = mirrorWarning;
    return response;
  });
}

function savePolishingEventDate(input) {
  requireEditorAccess_();
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string" || !input.id || !Number.isInteger(input.version) ||
      typeof input.eventRequestId !== "string" || !input.eventRequestId.trim() || input.eventRequestId.length > 120 ||
      typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 120) throw new Error("研磨日付の更新形式が不正です。");
  var at = polishingDateAt_(input.date);
  ensureSystem_();
  return withDocumentLock_(function() {
    var rows = readRows_(APP.SHEETS.JOBS, APP.JOB_HEADERS, true);
    var row = rows.find(function(record) { return String(record.id) === input.id; });
    if (!row) throw new Error("案件が見つかりません。画面を更新してください。");
    var job = jobFromRow_(row), polishing = normalizePolishing_(job.polishing);
    var target = polishing.history.find(function(event) { return event.requestId === input.eventRequestId; });
    var priorEvent = polishing.history.find(function(event) { return (event.dateEdits || []).some(function(edit) { return edit.requestId === input.requestId; }); });
    var prior = priorEvent && priorEvent.dateEdits.find(function(edit) { return edit.requestId === input.requestId; });
    if (prior && (priorEvent.requestId !== input.eventRequestId || prior.date !== input.date)) throw new Error("同じリクエストIDが異なる研磨日付の更新に使われています。");
    var updates = [];
    if (!prior) {
      if (job.archived) throw new Error("削除済みの案件は研磨日付を更新できません。");
      if (job.version !== input.version) throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
      if (!target || ["send", "return"].indexOf(target.action) < 0) throw new Error("変更する発送・戻りの履歴が見つかりません。");
      var previousAt = target.at, now = new Date().toISOString();
      target.recordedAt = target.recordedAt || previousAt;
      target.at = at;
      validatePolishingDates_(polishing.history);
      target.dateEdits = (target.dateEdits || []).concat([{ requestId: input.requestId, date: input.date, previousAt: previousAt, at: now }]);
      job.polishing = polishing;
      job.updatedAt = now;
      job.version += 1;
      var rawRow = row._rawValues.slice();
      rawRow[APP.JOB_HEADERS.indexOf("polishingJson")] = JSON.stringify(polishing);
      rawRow[APP.JOB_HEADERS.indexOf("updatedAt")] = now;
      rawRow[APP.JOB_HEADERS.indexOf("version")] = job.version;
      getSpreadsheet_().getSheetByName(APP.SHEETS.JOBS).getRange(row._rowNumber, 1, 1, APP.JOB_HEADERS.length).setValues(sheetValues_([rawRow]));
      SpreadsheetApp.flush();
      updates.push({ rowNumber: row._rowNumber, values: rawRow });
      appendLog_("job.polishing.date", "job", job.id, { requestId: input.requestId, eventRequestId: input.eventRequestId, date: input.date, previousAt: previousAt, version: job.version });
    }
    var settings = typeof readSettings_ === "function" ? readSettings_() : {};
    var warning = syncPolishingMirrorBestEffort_(jobsAfterRowUpdates_(rows, updates), settings);
    var response = { jobs: typeof decorateProductJobs_ === "function" ? decorateProductJobs_([job], settings) : [job] };
    if (warning) response.mirrorWarning = warning;
    return response;
  });
}
