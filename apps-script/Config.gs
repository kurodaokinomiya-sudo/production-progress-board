var APP = Object.freeze({
  SHEETS: Object.freeze({
    JOBS: "工程管理_案件",
    INTAKE: "工程管理_取込キュー",
    SETTINGS: "工程管理_設定",
    LOG: "工程管理_操作履歴",
    POLISHING: "工程管理_研磨",
    LEARNING: "工程管理_製品補完",
    MATERIALS: "工程管理_材料履歴",
    FINISHED_STOCK: "工程管理_Tezoe完成品在庫"
  }),
  STAGES: Object.freeze(["welding", "base", "grinding", "heat", "finish"]),
  CATEGORIES: Object.freeze(["鋭匙鉗子", "ケリソンパンチ"]),
  ASSIGNEES: Object.freeze(["豊", "幹", "望", "鈴", "河", "誠", "小", "保", "大", "順"]),
  JOB_HEADERS: Object.freeze([
    "id", "customer", "product", "dueDate", "quantity", "specLength", "specShape", "bladeWidth", "serialNo",
    "weldingStatus", "weldingAssignee", "baseStatus", "baseAssignee", "grindingStatus", "grindingAssignee",
    "heatStatus", "heatAssignee", "finishStatus", "finishAssignee", "shippingStatus", "note", "sourceType",
    "sourceRef", "priority", "archived", "createdAt", "updatedAt", "version", "completedAt", "category",
    "labelPrintStatus", "labelPrintedAt", "distributionAssignee", "polishingJson", "productCode", "externalOrderNo", "externalLineNo", "materialsJson", "stockPlannedQuantity", "completionKind", "processSaveJson"
  ]),
  INTAKE_HEADERS: Object.freeze([
    "id", "sourceType", "sourceRef", "receivedAt", "sender", "subject", "originalText", "parsedJson",
    "confidence", "status", "createdAt", "updatedAt"
  ]),
  SETTING_HEADERS: Object.freeze(["key", "value", "description"]),
  LEARNING_HEADERS: Object.freeze(["key", "ruleJson", "updatedAt"]),
  LOG_HEADERS: Object.freeze(["timestamp", "action", "entityType", "entityId", "actor", "detailJson"]),
  DEFAULTS: Object.freeze({
    gmailQuery: "newer_than:30d (subject:(注文 OR 発注 OR 依頼))",
    maxEmailThreads: "20",
    syncIntervalSeconds: "20"
  })
});

// Apps Script globals live only for the current execution. Share the workbook
// handle, never row data, so every new request still reads current sheet values.
var REQUEST_SPREADSHEET_ = null;

// Encode only at the managed-sheet write boundary. Sheets consumes one leading
// apostrophe as a text escape; escape existing apostrophes too so round trips
// preserve the actual input. Readers and business models use the original text.
// Numbers, dates, booleans and ordinary JSON strings retain their types/values.
function sheetCellValue_(value) {
  return typeof value === "string" && /^[=']/.test(value) ? "'" + value : value;
}

function sheetValues_(rows) {
  return rows.map(function(row) { return row.map(sheetCellValue_); });
}

function getSpreadsheet_() {
  if (REQUEST_SPREADSHEET_) return REQUEST_SPREADSHEET_;
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = properties.getProperty("SPREADSHEET_ID");
  if (spreadsheetId) {
    REQUEST_SPREADSHEET_ = SpreadsheetApp.openById(spreadsheetId);
    return REQUEST_SPREADSHEET_;
  }

  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error("スプレッドシートを特定できません。Apps Script画面で setupSystem を1回実行してください。");
  }
  properties.setProperty("SPREADSHEET_ID", active.getId());
  REQUEST_SPREADSHEET_ = active;
  return active;
}

function setupSystem() {
  requireOwnerAccess_();
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("このスクリプトを管理対象のスプレッドシートに紐づけて実行してください。");
  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", spreadsheet.getId());
  REQUEST_SPREADSHEET_ = spreadsheet;
  ensureSystem_();
  return { ok: true, spreadsheetId: spreadsheet.getId(), spreadsheetName: spreadsheet.getName() };
}

function ensureSystem_() {
  var spreadsheet = getSpreadsheet_();
  ensureSheet_(spreadsheet, APP.SHEETS.JOBS, APP.JOB_HEADERS);
  ensureSheet_(spreadsheet, APP.SHEETS.INTAKE, APP.INTAKE_HEADERS);
  ensureSheet_(spreadsheet, APP.SHEETS.SETTINGS, APP.SETTING_HEADERS);
  ensureSheet_(spreadsheet, APP.SHEETS.LOG, APP.LOG_HEADERS);
  ensureSheet_(spreadsheet, APP.SHEETS.LEARNING, APP.LEARNING_HEADERS);
  if (typeof ensurePolishingSheet_ === "function") ensurePolishingSheet_(spreadsheet);
  var settings = ensureDefaultSettings_();
  if (typeof repairPolishingMirrorIfNeeded_ === "function") repairPolishingMirrorIfNeeded_();
  return settings;
}

function ensureSheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight("bold")
      .setBackground("#e8eefc")
      .setFontColor("#17376d");
    sheet.autoResizeColumns(1, Math.min(headers.length, 12));
    return sheet;
  }

  var width = Math.max(sheet.getLastColumn(), headers.length);
  var headerRow = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  var lastHeader = headerRow.reduce(function(last, value, index) { return value ? index + 1 : last; }, 0);
  var current = headerRow.slice(0, lastHeader);
  var prefixMatches = current.every(function(header, index) { return headers[index] === header; });
  if (prefixMatches && current.length < headers.length) {
    var additions = headers.slice(current.length);
    sheet.getRange(1, current.length + 1, 1, additions.length).setValues([additions]);
    sheet.getRange(1, current.length + 1, 1, additions.length)
      .setFontWeight("bold")
      .setBackground("#e8eefc")
      .setFontColor("#17376d");
    return sheet;
  }
  var matches = current.length === headers.length && prefixMatches;
  if (!matches) {
    throw new Error("「" + name + "」シートの見出しがアプリ形式と異なります。既存シートを保護するため自動変更を停止しました。");
  }
  return sheet;
}

function normalizePolishing_(value) {
  var parsed = value;
  if (typeof value === "string") {
    if (!value.trim()) return { sentQuantity: 0, returnedQuantity: 0, history: [] };
    try { parsed = JSON.parse(value); } catch (error) { throw new Error("研磨履歴の保存データが壊れています。管理者に確認してください。"); }
  }
  if (value === undefined || value === null || value === "") return { sentQuantity: 0, returnedQuantity: 0, history: [] };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.history) || !Number.isSafeInteger(parsed.sentQuantity) || parsed.sentQuantity < 0 || !Number.isSafeInteger(parsed.returnedQuantity) || parsed.returnedQuantity < 0 || parsed.returnedQuantity > parsed.sentQuantity) {
    throw new Error("研磨履歴の保存データが不正です。管理者に確認してください。");
  }
  var requestIds = Object.create(null), returnedEvents = Object.create(null), undoneReturns = Object.create(null);
  var totals = { send: 0, return: 0, cancel: 0, "undo-return": 0 };
  var replay = { sent: 0, returned: 0 };
  var history = parsed.history.map(function(event) {
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.requestId !== "string" || !event.requestId.trim() || event.requestId.length > 120 || ["send", "return", "cancel", "undo-return"].indexOf(event.action) < 0 || !Number.isSafeInteger(event.quantity) || event.quantity <= 0 || typeof event.at !== "string" || !event.at.trim() || !isFinite(Date.parse(event.at))) {
      throw new Error("研磨履歴の保存データが不正です。管理者に確認してください。");
    }
    if (requestIds[event.requestId]) throw new Error("研磨履歴に重複したリクエストIDがあります。管理者に確認してください。");
    requestIds[event.requestId] = true;
    totals[event.action] += event.quantity;
    if (!Number.isSafeInteger(totals[event.action])) throw new Error("研磨履歴の数量が上限を超えています。");
    if (event.action === "send") replay.sent += event.quantity;
    if (event.action === "return") {
      if (event.quantity > replay.sent - replay.returned) throw new Error("研磨履歴の返却数量が送付数量を超えています。");
      replay.returned += event.quantity;
    }
    if (event.action === "cancel") {
      if (event.quantity > replay.sent - replay.returned) throw new Error("研磨履歴の取消数量が未返却数量を超えています。");
      replay.sent -= event.quantity;
    }
    if (event.action === "undo-return") {
      var target = typeof event.returnRequestId === "string" && returnedEvents[event.returnRequestId];
      if (typeof event.returnRequestId !== "string" || !event.returnRequestId.trim() || event.returnRequestId.length > 120 || !target || undoneReturns[event.returnRequestId] || event.quantity !== target.quantity || event.quantity > replay.returned) {
        throw new Error("研磨履歴の返却取消の参照または数量が不正です。管理者に確認してください。");
      }
      undoneReturns[event.returnRequestId] = true;
      replay.returned -= event.quantity;
    }
    if (!Number.isSafeInteger(replay.sent) || !Number.isSafeInteger(replay.returned)) throw new Error("研磨履歴の数量が上限を超えています。");
    var normalized = { requestId: event.requestId, action: event.action, quantity: event.quantity, at: event.at };
    if (event.requestedDate !== undefined) normalized.requestedDate = event.requestedDate;
    if (event.recordedAt !== undefined) normalized.recordedAt = event.recordedAt;
    if (event.dateEdits !== undefined) {
      if (!Array.isArray(event.dateEdits) || event.dateEdits.some(function(edit) {
        return !edit || typeof edit.requestId !== "string" || !edit.requestId.trim() || edit.requestId.length > 120 ||
          typeof edit.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(edit.date) ||
          !isFinite(Date.parse(edit.previousAt)) || !isFinite(Date.parse(edit.at));
      })) throw new Error("研磨日付の訂正履歴が不正です。管理者に確認してください。");
      normalized.dateEdits = event.dateEdits.map(function(edit) { return { requestId: edit.requestId, date: edit.date, previousAt: edit.previousAt, at: edit.at }; });
    }
    if (event.action === "return") returnedEvents[event.requestId] = normalized;
    if (event.action === "undo-return") normalized.returnRequestId = event.returnRequestId;
    return normalized;
  });
  if (totals.send - totals.cancel !== parsed.sentQuantity || totals.return - totals["undo-return"] !== parsed.returnedQuantity || replay.sent !== parsed.sentQuantity || replay.returned !== parsed.returnedQuantity) {
    throw new Error("研磨履歴と累計数量が一致しません。管理者に確認してください。");
  }
  return { sentQuantity: parsed.sentQuantity, returnedQuantity: parsed.returnedQuantity, history: history };
}

function polishingActiveReturns_(polishing) {
  var history = normalizePolishing_(polishing).history, undone = Object.create(null);
  history.forEach(function(event) { if (event.action === "undo-return") undone[event.returnRequestId] = true; });
  return history.filter(function(event) { return event.action === "return" && !undone[event.requestId]; });
}

function polishingOutstanding_(polishing) {
  var normalized = normalizePolishing_(polishing);
  return normalized.sentQuantity - normalized.returnedQuantity;
}

function finalFinishingReady_(job) {
  var quantity = Number(job && job.quantity);
  var polishing = normalizePolishing_(job && job.polishing);
  return Number.isSafeInteger(quantity) && quantity > 0 && polishing.sentQuantity === quantity && polishing.returnedQuantity === quantity;
}

function validatePolishingLifecycle_(polishing, quantity, finishStatus, shippingStatus, existing, historicalImport) {
  var state = normalizePolishing_(polishing);
  var previousFinish = existing && existing.stages && existing.stages.finish && existing.stages.finish.status;
  // Historical shipments without a polishing log can have their quantities
  // corrected without inventing movements or repeating the shipment. Existing
  // polishing records still constrain quantity changes to their real totals.
  var noRecordedPolishing = state.sentQuantity === 0 && state.returnedQuantity === 0 && state.history.length === 0;
  if (existing && existing.shippingStatus === "shipped" && shippingStatus === "shipped" &&
      previousFinish === finishStatus && (Number(existing.quantity) === Number(quantity) || noRecordedPolishing)) return;
  if (shippingStatus === "shipped" && finishStatus !== "done") {
    throw new Error("出荷完了にするには、最終仕上げを完了にしてください。");
  }
  // Only the owner-only migration path passes this separate internal option.
  // Retain imported historical states without manufacturing polishing events.
  if (historicalImport === true && !existing) return;
  var ready = finalFinishingReady_({ quantity: quantity, polishing: state });
  var unchangedHistoricalFinish = previousFinish === "done" && finishStatus === "done" && !finalFinishingReady_(existing);
  // Old ordinary-finishing completion must remain recoverable, but it does not
  // authorize either new final completion or shipment without a real return.
  if (finishStatus === "done" && !ready && !unchangedHistoricalFinish) throw new Error("研磨の全数発送と全数の戻りを記録するまで、最終仕上げを完了にできません。");
  if (shippingStatus === "shipped" && !ready) throw new Error("研磨の全数発送と全数の戻りを記録するまで、出荷完了にできません。");
}

function ensureDefaultSettings_() {
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.SETTINGS);
  var settings = readSettings_();
  var rows = [];
  var descriptions = {
    gmailQuery: "注文メールを探すGmail検索式",
    maxEmailThreads: "1回に確認する最大スレッド数",
    syncIntervalSeconds: "画面の自動更新間隔（秒）"
  };
  Object.keys(APP.DEFAULTS).forEach(function(key) {
    if (settings[key] === undefined) {
      rows.push([key, APP.DEFAULTS[key], descriptions[key]]);
      settings[key] = APP.DEFAULTS[key];
    }
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, APP.SETTING_HEADERS.length).setValues(sheetValues_(rows));
  return settings;
}
