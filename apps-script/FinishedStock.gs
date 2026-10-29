var FINISHED_STOCK_HEADERS_ = Object.freeze(["id", "requestId", "action", "date", "eventJson"]);

function ensureFinishedStockSheet_() {
  return ensureSheet_(getSpreadsheet_(), APP.SHEETS.FINISHED_STOCK, FINISHED_STOCK_HEADERS_);
}

function readFinishedStockEventsIfPresent_() {
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.FINISHED_STOCK);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var header = sheet.getRange(1, 1, 1, FINISHED_STOCK_HEADERS_.length).getDisplayValues()[0];
  if (!FINISHED_STOCK_HEADERS_.every(function (name, index) { return header[index] === name; })) {
    throw new Error("Tezoe完成品在庫の履歴シート見出しが不正です。管理者に確認してください。");
  }
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, FINISHED_STOCK_HEADERS_.length).getValues();
  return rows.filter(function (row) { return row.some(function (cell) { return cell !== ""; }); }).map(function (row) {
    try { return JSON.parse(String(row[4] || "")); }
    catch (error) { throw new Error("Tezoe完成品在庫の履歴を読み取れません。管理者に確認してください。"); }
  });
}

function appendFinishedStockEvent_(event) {
  var sheet = ensureFinishedStockSheet_();
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, FINISHED_STOCK_HEADERS_.length).setValues(sheetValues_([[
    event.id, event.requestId, event.action, event.date, JSON.stringify(event)
  ]]));
  SpreadsheetApp.flush();
}

function getFinishedStock() {
  var access = requireEditorAccess_();
  ensureSystem_();
  return withDocumentLock_(function () {
    access = requireEditorAccess_();
    var events = readFinishedStockEventsIfPresent_();
    return FinishedStock.snapshot({ jobs: reconcileStockFulfillments_(readJobs_(), events), events: events });
  });
}

// Repairable after an event write whose reply (or subsequent job write) failed.
// Never reduce/increase stock here: the original reversal event owns that effect.
function reconcileStockFulfillments_(jobs, events) {
  return jobs.map(function(job) {
    if (job.completionKind !== "stock_fulfillment" || job.shippingStatus !== "shipped" || FinishedStock.fulfillment(job, events)) return job;
    var rows = readRows_(APP.SHEETS.JOBS, APP.JOB_HEADERS);
    var row = rows.filter(function(value) { return String(value.id) === job.id; })[0];
    if (!row) throw new Error("受注の再開対象が見つかりません。");
    job.shippingStatus = "not_ready"; job.completedAt = ""; job.completionKind = "";
    job.version += 1; job.updatedAt = new Date().toISOString();
    getSpreadsheet_().getSheetByName(APP.SHEETS.JOBS).getRange(row._rowNumber, 1, 1, APP.JOB_HEADERS.length).setValues(sheetValues_([jobToRow_(job)]));
    SpreadsheetApp.flush();
    appendLog_("job.fulfillment.reopen", "job", job.id, { reason: "stock-shipment-reversed", version: job.version });
    return job;
  });
}

function receiveFinishedStock(input) {
  requireEditorAccess_();
  return mutateFinishedStock_("receive", input);
}

function shipFinishedStock(input) {
  requireEditorAccess_();
  return mutateFinishedStock_("ship", input);
}

function openFinishedStock(input) {
  requireEditorAccess_();
  return mutateFinishedStock_("opening", input);
}

function reverseFinishedStock(input) {
  requireEditorAccess_();
  return mutateFinishedStock_("reverse", input);
}

function saveFinishedStockSchedule(input) {
  requireEditorAccess_();
  return mutateFinishedStock_("schedule", input);
}

function mutateFinishedStock_(action, input) {
  ensureSystem_();
  var access = requireEditorAccess_();
  return withDocumentLock_(function () {
    access = requireEditorAccess_();
    var jobs = readJobs_();
    var events = readFinishedStockEventsIfPresent_();
    var result = FinishedStock.prepareMutation(action, input, {
      jobs: jobs, events: events, at: new Date().toISOString(), actor: access.email || "", id: Utilities.getUuid()
    });
    if (result.event) {
      appendFinishedStockEvent_(result.event);
      appendLog_("finished-stock." + action, "finished-stock", result.event.id, {
        requestId: result.event.requestId, productId: result.event.productId || "", quantity: result.event.quantity || 0,
        eventId: result.event.eventId || ""
      });
      var committed = events.concat([result.event]);
      return FinishedStock.snapshot({ jobs: reconcileStockFulfillments_(jobs, committed), events: committed });
    }
    return FinishedStock.snapshot({ jobs: reconcileStockFulfillments_(jobs, events), events: events });
  });
}
