function doGet(request) {
  var browserShortcut = !!(request && request.parameter && request.parameter.launch === "browser");
  var output;
  if (readAccessContext_()) output = HtmlService.createHtmlOutputFromFile("Index");
  else {
    var template = HtmlService.createTemplateFromFile("Access");
    template.appUrl = ScriptApp.getService().getUrl() + (browserShortcut ? "?launch=browser" : "");
    output = template.evaluate();
  }
  output
    .setTitle("生産工程管理")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
  // 通常URLは専用画面、launch=browserは通常のChromeショートカットとして追加する。
  // 本人確認の前後で同じ起動方式を保ち、端末側の追加制限は回避しない。
  if (!browserShortcut) {
    output.addMetaTag("mobile-web-app-capable", "yes")
      .addMetaTag("apple-mobile-web-app-capable", "yes");
  }
  return output
    .addMetaTag("viewport", "width=device-width, initial-scale=1, viewport-fit=cover");
}

function getSnapshot(request) {
  var access = requireAppAccess_();
  var settings = ensureSystem_() || readSettings_();
  access = requireAppAccess_();
  var canReadImports = access.canEdit === true;
  var jobs;
  var materialInventory = null;
  if (canReadImports && typeof materialInventorySnapshotUnlocked_ === "function" && typeof MaterialInventory !== "undefined") {
    materialInventory = withDocumentLock_(function() {
      access = requireAppAccess_();
      canReadImports = access.canEdit === true;
      jobs = readJobs_();
      return canReadImports ? materialInventorySnapshotUnlocked_(access, jobs) : null;
    });
  } else jobs = readJobs_();
  if (!access.isOwner) {
    delete settings.gmailQuery;
    delete settings.maxEmailThreads;
  }
  if (!canReadImports) {
    delete settings.customerRules;
    delete settings.importSettings;
  }
  if (typeof materialJobForAccess_ === "function") jobs = jobs.map(function(job) { return materialJobForAccess_(job, access); });
  return {
    jobs: typeof decorateProductJobs_ === "function" ? decorateProductJobs_(jobs, settings) : jobs,
    materialInventory: materialInventory,
    productMasterStatus: typeof getProductMasterStatus_ === "function" ? getProductMasterStatus_() : null,
    intake: canReadImports ? readIntake_() : [],
    settings: settings,
    access: access,
    accessSettings: access.isAdmin ? getAccessSettings() : null,
    mode: "live",
    aiImport: canReadImports ? getAiImportStatus() : { configured: false, ready: false, model: "" },
    scriptEditorUrl: access.isOwner ? "https://script.google.com/home/projects/" + encodeURIComponent(ScriptApp.getScriptId()) + "/edit" : "",
    serverTime: new Date().toISOString(),
    setupRequired: false,
    requestedSince: request && request.since ? request.since : null
  };
}

function saveSettings(input) {
  var access = requireAdminAccess_();
  input = input || {};
  var ownerSettings = ["gmailQuery", "maxEmailThreads"].some(function(key) { return input[key] !== undefined; });
  if (ownerSettings) requireOwnerAccess_();
  var updates = {};
  var allowed = ["gmailQuery", "maxEmailThreads", "syncIntervalSeconds"];
  allowed.forEach(function(key) {
    if (input[key] === undefined) return;
    var value = String(input[key]).trim();
    if (key === "gmailQuery" && !value) throw new Error("Gmail検索式を入力してください。");
    if (key === "maxEmailThreads" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50)) {
      throw new Error("メール検索件数は1〜50で入力してください。");
    }
    if (key === "syncIntervalSeconds" && (!/^\d+$/.test(value) || Number(value) < 10 || Number(value) > 300)) {
      throw new Error("自動更新間隔は10〜300秒で入力してください。");
    }
    updates[key] = value;
  });
  if (input.stageAssignees !== undefined) updates.stageAssignees = normalizeStageAssigneesSetting_(input.stageAssignees);
  if (input.distributionAssignees !== undefined) updates.distributionAssignees = normalizeDistributionAssigneesSetting_(input.distributionAssignees);

  ensureSystem_();
  return withDocumentLock_(function() {
    access = requireAdminAccess_();
    if (ownerSettings) access = requireOwnerAccess_();
    var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.SETTINGS);
    var values = sheet.getDataRange().getValues();
    var rowsByKey = {};
    for (var i = 1; i < values.length; i += 1) rowsByKey[String(values[i][0])] = i + 1;
    Object.keys(updates).forEach(function(key) {
      if (rowsByKey[key]) sheet.getRange(rowsByKey[key], 2).setValue(sheetCellValue_(updates[key]));
      else sheet.appendRow(sheetValues_([[key, updates[key], ""]])[0]);
    });
    appendLog_("settings.update", "settings", "global", input);
    var settings = readSettings_();
    if (!access.isOwner) {
      delete settings.gmailQuery;
      delete settings.maxEmailThreads;
    }
    return settings;
  });
}

function normalizeStageAssigneesSetting_(value) {
  var parsed;
  try { parsed = JSON.parse(String(value)); }
  catch (error) { throw new Error("工程担当者の設定JSONが不正です。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工程担当者の設定形式が不正です。");
  var settingStages = APP.STAGES.concat(["heatSharp"]);
  Object.keys(parsed).forEach(function(stage) {
    if (settingStages.indexOf(stage) < 0) throw new Error("不明な工程です: " + stage);
  });
  var normalized = {};
  settingStages.forEach(function(stage) {
    if (!Object.prototype.hasOwnProperty.call(parsed, stage)) {
      normalized[stage] = stage === "heatSharp" ? normalized.heat.slice() : APP.ASSIGNEES.slice();
      return;
    }
    if (!Array.isArray(parsed[stage])) throw new Error("工程担当者は配列で指定してください: " + stage);
    var seen = {};
    normalized[stage] = parsed[stage].map(function(name) {
      if (typeof name !== "string" || APP.ASSIGNEES.indexOf(name) < 0) throw new Error("不明な担当者です: " + name);
      if (seen[name]) return null;
      seen[name] = true;
      return name;
    }).filter(function(name) { return name !== null; });
  });
  return JSON.stringify(normalized);
}

function normalizeDistributionAssigneesSetting_(value) {
  var parsed;
  try { parsed = JSON.parse(String(value)); }
  catch (error) { throw new Error("配布担当者の設定JSONが不正です。"); }
  if (!Array.isArray(parsed)) throw new Error("配布担当者は配列で指定してください。");
  parsed.forEach(function(name) {
    if (typeof name !== "string" || APP.ASSIGNEES.indexOf(name) < 0) throw new Error("不明な配布担当者です: " + name);
  });
  var seen = {};
  var normalized = APP.ASSIGNEES.filter(function(name) {
    if (parsed.indexOf(name) < 0 || seen[name]) return false;
    seen[name] = true;
    return true;
  });
  return JSON.stringify(normalized);
}

/**
 * Return the server-side customer rules snapshot.  The setting is one JSON
 * value so unrelated rows in 工程管理_設定 remain untouched.  When the row is
 * absent, version 0 is an in-memory default; no existing intake or job is
 * rewritten as a consequence.
 */
function getCustomerRules() {
  requireEditorAccess_();
  if (typeof ensureSystem_ === "function") ensureSystem_();
  return readCustomerRulesSnapshot_();
}

function saveCustomerRules(input) {
  requireAdminAccess_();
  if (!input || typeof input !== "object") throw new Error("得意先ルールがありません。");
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error("expectedVersionは0以上の整数で指定してください。");
  if (!Object.prototype.hasOwnProperty.call(input, "rules")) throw new Error("保存する得意先ルールがありません。");
  if (!input.rules || typeof input.rules !== "object" || Array.isArray(input.rules) || !Array.isArray(input.rules.ownCompanyNames) || !Array.isArray(input.rules.aliases)) {
    throw new Error("保存する得意先ルールの配列が不正です。");
  }
  var normalized = normalizeCustomerRules_(input.rules);
  if (typeof ensureSystem_ === "function") ensureSystem_();
  return withCustomerRulesLock_(function() {
    requireAdminAccess_();
    var current = readCustomerRulesSnapshot_();
    if (current.version !== input.expectedVersion) {
      throw new Error("得意先ルールが別の端末で更新されています。画面を更新して再試行してください。");
    }
    var saved = customerRulesApiObject_(current.version + 1, normalized);
    writeCustomerRulesSetting_(saved);
    return saved;
  });
}

function withCustomerRulesLock_(callback) {
  if (typeof withDocumentLock_ !== "function") throw new Error("得意先ルールの保存用ロックを利用できません。");
  return withDocumentLock_(callback);
}

function readCustomerRulesSnapshot_() {
  var stored = readCustomerRulesSetting_();
  if (!stored.exists) return customerRulesApiObject_(0, defaultCustomerRules_());
  var decoded;
  try {
    decoded = typeof stored.value === "string" ? JSON.parse(stored.value) : stored.value;
  } catch (error) {
    throw new Error("保存済み得意先ルールのJSONが不正です。修正してから再試行してください。");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("保存済み得意先ルールのJSONが不正です。修正してから再試行してください。");
  var rules = decoded;
  if (decoded.ownCompanyNames === undefined && decoded.aliases === undefined && decoded.rules !== undefined) rules = decoded.rules;
  if (!Number.isInteger(decoded.version) || decoded.version < 0) throw new Error("保存済み得意先ルールのversionが不正です。修正してから再試行してください。");
  try {
    return customerRulesApiObject_(decoded.version, rules);
  } catch (error) {
    throw new Error("保存済み得意先ルールの内容が不正です。" + (error && error.message ? error.message : "修正してから再試行してください。"));
  }
}

function readCustomerRulesSetting_() {
  var directLookup = false;
  if (typeof getSpreadsheet_ === "function" && typeof APP !== "undefined") {
    try {
      var spreadsheet = getSpreadsheet_();
      var sheet = spreadsheet && spreadsheet.getSheetByName(APP.SHEETS.SETTINGS);
      if (sheet) {
        directLookup = true;
        var lastRow = Number(sheet.getLastRow() || 0);
        if (lastRow < 2) return { exists: false };
        var range = sheet.getRange(2, 1, lastRow - 1, 3);
        var values = range.getDisplayValues ? range.getDisplayValues() : range.getValues();
        var matches = values.filter(function(row) { return String(row[0] || "") === "customerRules"; });
        if (matches.length > 1) throw new Error("工程管理_設定のcustomerRulesが重複しています。重複を解消してから再試行してください。");
        return matches.length ? { exists: true, value: matches[0][1] } : { exists: false };
      }
    } catch (error) {
      // A local VM may provide readSettings_ without a Spreadsheet service.
      // Once a real settings sheet was found, surface its errors instead of
      // silently falling back and hiding malformed persisted JSON.
      if (directLookup || typeof readSettings_ !== "function" || typeof SpreadsheetApp !== "undefined") throw error;
    }
  }
  if (typeof readSettings_ === "function") {
    var settings = readSettings_() || {};
    if (Object.prototype.hasOwnProperty.call(settings, "customerRules")) return { exists: true, value: settings.customerRules };
  }
  return { exists: false };
}

function writeCustomerRulesSetting_(saved) {
  if (typeof getSpreadsheet_ !== "function" || typeof APP === "undefined") throw new Error("設定シートを特定できません。");
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet && spreadsheet.getSheetByName(APP.SHEETS.SETTINGS);
  if (!sheet) throw new Error("設定シートを特定できません。");
  var lastRow = Number(sheet.getLastRow() || 0);
  var rows = [];
  if (lastRow >= 2) {
    var range = sheet.getRange(2, 1, lastRow - 1, 3);
    rows = range.getDisplayValues ? range.getDisplayValues() : range.getValues();
  }
  var matches = [];
  rows.forEach(function(row, index) {
    if (String(row[0] || "") === "customerRules") matches.push(index + 2);
  });
  if (matches.length > 1) throw new Error("工程管理_設定のcustomerRulesが重複しています。重複を解消してから再試行してください。");
  var value = JSON.stringify(saved);
  if (matches.length) {
    var cell = sheet.getRange(matches[0], 2);
    if (typeof cell.setValue === "function") cell.setValue(sheetCellValue_(value));
    else cell.setValues(sheetValues_([[value]]));
  } else if (typeof sheet.appendRow === "function") {
    sheet.appendRow(sheetValues_([["customerRules", value, "AI取込の得意先判定ルール"]])[0]);
  } else {
    sheet.getRange(lastRow + 1, 1, 1, 3).setValues(sheetValues_([["customerRules", value, "AI取込の得意先判定ルール"]]));
  }
  if (typeof SpreadsheetApp !== "undefined" && SpreadsheetApp.flush) SpreadsheetApp.flush();
  if (typeof appendLog_ === "function") appendLog_("settings.customerRules.update", "settings", "customerRules", { version: saved.version });
}
