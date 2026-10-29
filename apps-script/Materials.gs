// Append-only events. A receipt is one row: both stock and order remainder
// derive from that row, so neither can commit without the other.
var MATERIAL_EVENT_FIELDS_ = ["id", "requestId", "requestHash", "action", "date", "at", "materialId", "quantity", "orderId", "orderDate", "expectedDate", "note", "actor"];
var MATERIAL_EVENT_HEADERS_ = ["記録ID", "リクエストID", "内容照合", "操作", "日付", "記録日時", "材料ID", "数量（セット）", "発注ID", "発注日", "入荷予定日", "備考・理由", "操作者"];

function ensureMaterialsSheet_() {
  return ensureSheet_(getSpreadsheet_(), APP.SHEETS.MATERIALS, MATERIAL_EVENT_HEADERS_);
}

function readMaterialEvents_() {
  return readRows_(APP.SHEETS.MATERIALS, MATERIAL_EVENT_FIELDS_, true).map(function (row) {
    var event = {};
    MATERIAL_EVENT_FIELDS_.forEach(function (field) { event[field] = field === "quantity" ? Number(row[field]) : String(row[field] || ""); });
    ["date", "orderDate", "expectedDate"].forEach(function (field) { event[field] = normalizeStoredDate_(row._rawValues[MATERIAL_EVENT_FIELDS_.indexOf(field)]); });
    return event;
  });
}

function appendMaterialEvents_(events) {
  if (!events.length) return;
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.MATERIALS);
  var rows = events.map(function (event) { return MATERIAL_EVENT_FIELDS_.map(function (field) { return event[field] === undefined ? "" : event[field]; }); });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, MATERIAL_EVENT_FIELDS_.length).setValues(sheetValues_(rows));
  SpreadsheetApp.flush();
}

// Caller holds the document lock. Opening quantities are today's opening
// balance from the supplied image, never invented historic usage movements.
function initializeMaterialsUnlocked_(access) {
  ensureMaterialsSheet_();
  var events = readMaterialEvents_();
  MaterialInventory.snapshot({ events: events, jobs: [] }); // Validate before appending anything.
  var seeds = MaterialInventory.openingEvents({ at: new Date().toISOString(), actor: access && access.email || "" });
  var missing = seeds.filter(function (seed) { return !events.some(function (event) { return event.action === "opening" && event.materialId === seed.materialId; }); });
  appendMaterialEvents_(missing);
  return events.concat(missing);
}

function materialInventorySnapshotUnlocked_(access, jobs) {
  return MaterialInventory.snapshot({ jobs: jobs || readJobs_(), events: initializeMaterialsUnlocked_(access) });
}

function getMaterialInventory() {
  var access = requireEditorAccess_();
  ensureSystem_();
  return withDocumentLock_(function () {
    access = requireEditorAccess_();
    return materialInventorySnapshotUnlocked_(access);
  });
}

function saveMaterialOrder(input) {
  var access = requireEditorAccess_();
  return mutateMaterials_("order", input, access);
}

function receiveMaterialOrder(input) {
  var access = requireEditorAccess_();
  return mutateMaterials_("receive", input, access);
}

function adjustMaterialStock(input) {
  var access = requireEditorAccess_();
  return mutateMaterials_("adjust", input, access);
}

function cancelMaterialOrder(input) {
  var access = requireEditorAccess_();
  return mutateMaterials_("cancel", input, access);
}

function mutateMaterials_(action, input, access) {
  ensureSystem_();
  return withDocumentLock_(function () {
    access = requireEditorAccess_();
    var events = initializeMaterialsUnlocked_(access);
    var prepared = MaterialInventory.prepareMutation(action, input, { events: events, at: new Date().toISOString(), actor: access.email || "", id: Utilities.getUuid() });
    if (prepared.event) { appendMaterialEvents_([prepared.event]); events.push(prepared.event); }
    return MaterialInventory.snapshot({ jobs: readJobs_(), events: events });
  });
}

function prepareJobMaterials_(previous, next, input, options) {
  options = options || {};
  var access = typeof requireAppAccess_ === "function" ? requireAppAccess_() : {};
  return MaterialInventory.transitionJob(previous, next, {
    at: next.updatedAt || new Date().toISOString(), actor: access.email || "", baselineOnly: options.baselineOnly === true,
    requestId: input && input.requestId || "", requestHash: input && input.requestId ? MaterialInventory.jobRequestHash(input) : ""
  });
}

function materialJobForAccess_(job, access) {
  var response = Object.assign({}, job);
  delete response._materialsJsonRaw;
  delete response.materialsJson;
  if (!access || access.canEdit !== true) delete response.materials;
  return response;
}
