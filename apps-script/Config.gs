var APP = Object.freeze({
  SHEETS: Object.freeze({
    JOBS: "工程管理_案件",
    INTAKE: "工程管理_取込キュー",
    SETTINGS: "工程管理_設定",
    LOG: "工程管理_操作履歴"
  }),
  STAGES: Object.freeze(["welding", "base", "grinding", "heat", "finish"]),
  CATEGORIES: Object.freeze(["鋭匙鉗子", "ケリソンパンチ"]),
  ASSIGNEES: Object.freeze(["豊", "幹", "望", "鈴", "河", "誠", "小", "保", "大", "順"]),
  JOB_HEADERS: Object.freeze([
    "id", "customer", "product", "dueDate", "quantity", "specLength", "specShape", "bladeWidth", "serialNo",
    "weldingStatus", "weldingAssignee", "baseStatus", "baseAssignee", "grindingStatus", "grindingAssignee",
    "heatStatus", "heatAssignee", "finishStatus", "finishAssignee", "shippingStatus", "note", "sourceType",
    "sourceRef", "priority", "archived", "createdAt", "updatedAt", "version", "completedAt", "category",
    "labelPrintStatus", "labelPrintedAt"
  ]),
  INTAKE_HEADERS: Object.freeze([
    "id", "sourceType", "sourceRef", "receivedAt", "sender", "subject", "originalText", "parsedJson",
    "confidence", "status", "createdAt", "updatedAt"
  ]),
  SETTING_HEADERS: Object.freeze(["key", "value", "description"]),
  LOG_HEADERS: Object.freeze(["timestamp", "action", "entityType", "entityId", "actor", "detailJson"]),
  DEFAULTS: Object.freeze({
    gmailQuery: "newer_than:30d (subject:(注文 OR 発注 OR 依頼))",
    maxEmailThreads: "20",
    syncIntervalSeconds: "20"
  })
});

function getSpreadsheet_() {
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = properties.getProperty("SPREADSHEET_ID");
  if (spreadsheetId) return SpreadsheetApp.openById(spreadsheetId);

  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error("スプレッドシートを特定できません。Apps Script画面で setupSystem を1回実行してください。");
  }
  properties.setProperty("SPREADSHEET_ID", active.getId());
  return active;
}

function setupSystem() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("このスクリプトを管理対象のスプレッドシートに紐づけて実行してください。");
  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", spreadsheet.getId());
  ensureSystem_();
  return { ok: true, spreadsheetId: spreadsheet.getId(), spreadsheetName: spreadsheet.getName() };
}

function ensureSystem_() {
  var spreadsheet = getSpreadsheet_();
  ensureSheet_(spreadsheet, APP.SHEETS.JOBS, APP.JOB_HEADERS);
  ensureSheet_(spreadsheet, APP.SHEETS.INTAKE, APP.INTAKE_HEADERS);
  ensureSheet_(spreadsheet, APP.SHEETS.SETTINGS, APP.SETTING_HEADERS);
  ensureSheet_(spreadsheet, APP.SHEETS.LOG, APP.LOG_HEADERS);
  ensureDefaultSettings_();
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
    if (settings[key] === undefined) rows.push([key, APP.DEFAULTS[key], descriptions[key]]);
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, APP.SETTING_HEADERS.length).setValues(rows);
}
