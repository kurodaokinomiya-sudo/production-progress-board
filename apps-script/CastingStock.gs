var CASTING_STOCK_SHEET_ = "工程管理_鋳物在庫";
var CASTING_STOCK_HEADERS_ = ["記録ID", "内容JSON"];
var CASTING_STOCK_START_ = "開始";
var CASTING_STOCK_FIXED_START_ = "開始（1・2階）";

function getCastingInventory() {
  requireWorkerAccess_();
  var ledger = readCastingLedger_();
  if (ledger && ledger.seed.fixedStorageFrom === undefined) {
    ledger = withDocumentLock_(function () {
      requireWorkerAccess_();
      return enableCastingFixedStorage_(readCastingLedger_());
    });
  }
  if (ledger) return CastingStock.project(ledger.seed, ledger.events);
  var source = readCastingInventorySource_();
  var preview = CastingStock.project(Object.assign({}, source, {
    initializedAt: new Date().toISOString(),
    fixedStorageFrom: 0,
  }), []);
  return Object.assign({}, preview, {
    initialized: false,
    initializedAt: "",
    sourceRevision: source.sourceRevision,
    openingOrders: preview.orders,
    orders: [],
    revision: 0,
  });
}

function getCastingInventoryHistory(partId) {
  requireWorkerAccess_();
  var ledger = readCastingLedger_();
  return ledger ? CastingStock.historyForPart(ledger.seed, ledger.events, partId) : [];
}

function startCastingInventory(input) {
  requireOwnerAccess_();
  return withDocumentLock_(function () {
    requireOwnerAccess_();
    var ledger = enableCastingFixedStorage_(readCastingLedger_());
    if (ledger) return CastingStock.project(ledger.seed, ledger.events);

    var source = readCastingInventorySource_();
    if (!input || typeof input.sourceRevision !== "string" || !input.sourceRevision || input.sourceRevision !== source.sourceRevision) {
      throw new Error("CASTING_STOCK_SOURCE_CHANGED: 現行表が更新されました。最新の在庫数を読み直してから開始してください。");
    }
    var seed = Object.assign({}, source, { initializedAt: new Date().toISOString(), fixedStorageFrom: 0 });
    var snapshot = CastingStock.project(seed, []);
    var sheet = ensureSheet_(getSpreadsheet_(), CASTING_STOCK_SHEET_, CASTING_STOCK_HEADERS_);
    appendCastingLedgerRow_(sheet, CASTING_STOCK_FIXED_START_, seed);
    return snapshot;
  });
}

function saveCastingInventoryChange(input) {
  requireWorkerAccess_();
  return withDocumentLock_(function () {
    var access = requireWorkerAccess_();
    var ledger = enableCastingFixedStorage_(readCastingLedger_());
    if (!ledger) throw new Error("CASTING_STOCK_NOT_STARTED: 所有者が鋳物在庫の管理を開始すると記録できます。");
    var result = CastingStock.apply(ledger.seed, ledger.events, input, { createdAt: new Date().toISOString(), actor: access.email || "" });
    if (result.event) appendCastingLedgerRow_(ledger.sheet, "op:" + result.event.request.opId, result.event);
    return result.snapshot;
  });
}

function readCastingLedger_() {
  var sheet = getSpreadsheet_().getSheetByName(CASTING_STOCK_SHEET_);
  var lastRow = sheet ? sheet.getLastRow() : 0;
  if (!lastRow) return null;
  var rows = sheet.getRange(1, 1, lastRow, CASTING_STOCK_HEADERS_.length).getValues();
  if (!CASTING_STOCK_HEADERS_.every(function (header, index) { return rows[0][index] === header; })) {
    throw new Error("鋳物在庫の見出しが一致しません。管理者に確認してください。");
  }
  if (lastRow === 1) return null;

  var fixedStorage = rows[1][0] === CASTING_STOCK_FIXED_START_;
  var seed = readCastingLedgerRow_(rows[1], 2, fixedStorage ? CASTING_STOCK_FIXED_START_ : CASTING_STOCK_START_);
  if (fixedStorage !== (seed.fixedStorageFrom !== undefined)) {
    throw new Error("鋳物在庫の開始記録を確認してください。");
  }
  var events = rows.slice(2).map(function (row, index) { return readCastingLedgerRow_(row, index + 3); });
  return { sheet: sheet, seed: seed, events: events };
}

// Replay stored operations under the rules in force when they were recorded.
function enableCastingFixedStorage_(ledger) {
  if (!ledger || ledger.seed.fixedStorageFrom !== undefined) return ledger;
  var seed = Object.assign({}, ledger.seed, { fixedStorageFrom: ledger.events.length });
  CastingStock.project(seed, ledger.events);
  // A tab served by an earlier release must fail closed before adding records
  // under the former storage rules.
  ledger.sheet.getRange(2, 1, 1, 2).setValues([[CASTING_STOCK_FIXED_START_, castingLedgerJson_(seed)]]);
  SpreadsheetApp.flush();
  return Object.assign({}, ledger, { seed: seed });
}

function readCastingLedgerRow_(row, rowNumber, seedId) {
  var data;
  try { data = JSON.parse(row[1]); } catch (error) { data = null; }
  var id = seedId || (data && data.request && typeof data.request.opId === "string" ? "op:" + data.request.opId : "");
  if (!data || typeof data !== "object" || !id || row[0] !== id) {
    throw new Error("鋳物在庫の" + rowNumber + "行目を読み取れません。管理者に確認してください。");
  }
  return data;
}

function castingLedgerJson_(data) {
  var json = JSON.stringify(data);
  if (json.length > 50000) throw new Error("鋳物在庫の記録がセルの文字数上限を超えています。備考を短くしてください。");
  return json;
}

function appendCastingLedgerRow_(sheet, id, data) {
  sheet.appendRow([id, castingLedgerJson_(data)]);
  SpreadsheetApp.flush();
}
