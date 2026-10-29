function readRows_(sheetName, headers, includeRawValues) {
  var sheet = getSpreadsheet_().getSheetByName(sheetName);
  var lastRow = sheet ? sheet.getLastRow() : 0;
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function(row, index) {
    return { row: row, rowNumber: index + 2 };
  }).filter(function(entry) {
    return entry.row.some(function(cell) { return cell !== ""; });
  }).map(function(entry) {
    return recordFromValues_(entry.row, headers, entry.rowNumber, includeRawValues);
  });
}

function recordFromValues_(values, headers, rowNumber, includeRawValues) {
  var record = { _rowNumber: rowNumber };
  headers.forEach(function(header, column) {
    var value = values[column];
    if (header === "dueDate") record[header] = normalizeStoredDate_(value);
    // Monthly identifiers such as 10-1 can be date cells in existing Sheets.
    else if (header === "serialNo" && value instanceof Date) record[header] = Utilities.formatDate(value, "Asia/Tokyo", "M-d");
    else record[header] = serializeCell_(value);
  });
  if (includeRawValues) record._rawValues = values;
  return record;
}

// Call only inside the same script lock as the read and writes. Reconstruct
// the exact post-write model without another full sheet read or a data cache.
function jobsAfterRowUpdates_(rows, updates) {
  var updatedRows = Object.create(null);
  updates.forEach(function(update) { updatedRows[update.rowNumber] = update; });
  var jobs = rows.map(function(row) {
    var update = updatedRows[row._rowNumber];
    if (!update) return jobFromRow_(row);
    delete updatedRows[row._rowNumber];
    return jobFromRow_(recordFromValues_(update.values, APP.JOB_HEADERS, update.rowNumber));
  });
  Object.keys(updatedRows).forEach(function(rowNumber) {
    var update = updatedRows[rowNumber];
    jobs.push(jobFromRow_(recordFromValues_(update.values, APP.JOB_HEADERS, update.rowNumber)));
  });
  return jobs;
}

function serializeCell_(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function readSettings_() {
  var spreadsheet;
  try { spreadsheet = getSpreadsheet_(); } catch (error) { return {}; }
  var sheet = spreadsheet.getSheetByName(APP.SHEETS.SETTINGS);
  var lastRow = sheet ? sheet.getLastRow() : 0;
  if (lastRow < 2) return {};
  var rows = sheet.getRange(2, 1, lastRow - 1, APP.SETTING_HEADERS.length).getDisplayValues();
  return rows.reduce(function(settings, row) {
    if (row[0]) settings[row[0]] = row[1];
    return settings;
  }, {});
}

function readJobs_() {
  return readRows_(APP.SHEETS.JOBS, APP.JOB_HEADERS).map(jobFromRow_);
}

function jobFromRow_(row) {
  var product = String(row.product || "");
  var productCode = storedProductCode_(row.productCode) || legacyProductCodeFromNote_(row.note);
  var inferredSpecs = inferSpecsFromProductName_(product, {
    specLength: row.specLength,
    specShape: row.specShape,
    bladeWidth: row.bladeWidth
  });
  var stages = {};
  APP.STAGES.forEach(function(key) {
    stages[key] = {
      status: row[key + "Status"] || "not_started",
      assignee: row[key + "Assignee"] || ""
    };
  });
  return {
    id: String(row.id || ""),
    customer: String(row.customer || ""),
    product: product,
    productCode: productCode,
    dueDate: normalizeStoredDate_(row.dueDate),
    quantity: row.quantity === "" ? "" : Number(row.quantity),
    specLength: inferredSpecs.specLength,
    specShape: inferredSpecs.specShape,
    bladeWidth: inferredSpecs.bladeWidth,
    serialNo: String(row.serialNo || ""),
    externalOrderNo: String(row.externalOrderNo || ""),
    externalLineNo: String(row.externalLineNo || ""),
    stockPlannedQuantity: row.stockPlannedQuantity === "" || row.stockPlannedQuantity === null || row.stockPlannedQuantity === undefined ? 0 : Number(row.stockPlannedQuantity),
    category: normalizeCategory_(row.category, product),
    stages: stages,
    shippingStatus: String(row.shippingStatus || "not_ready"),
    note: String(row.note || ""),
    sourceType: String(row.sourceType || "manual"),
    sourceRef: String(row.sourceRef || ""),
    priority: String(row.priority || "normal"),
    archived: isArchivedValue_(row.archived),
    createdAt: normalizeDateTime_(row.createdAt),
    updatedAt: normalizeDateTime_(row.updatedAt),
    version: Number(row.version || 1),
    completedAt: normalizeDateTime_(row.completedAt),
    completionKind: row.completionKind === "stock_fulfillment" ? "stock_fulfillment" : "",
    labelPrintStatus: normalizeLabelPrintStatus_(row.labelPrintStatus),
    labelPrintedAt: normalizeDateTime_(row.labelPrintedAt),
    distributionAssignee: String(row.distributionAssignee || ""),
    polishing: normalizePolishing_(row.polishingJson),
    materials: typeof MaterialInventory !== "undefined" ? MaterialInventory.normalizeState(row.materialsJson) : undefined,
    _materialsJsonRaw: row.materialsJson || "",
    _processSaveJsonRaw: row.processSaveJson || ""
  };
}

function isArchivedValue_(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function normalizeStoredDate_(value) {
  if (!value) return "";
  if (value instanceof Date) return Utilities.formatDate(value, "Asia/Tokyo", "yyyy-MM-dd");
  var text = String(value);
  var iso = text.match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : text;
}

function normalizeDateTime_(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function validateJob_(input) {
  if (!input || typeof input !== "object") throw new Error("案件データがありません。");
  if (!String(input.customer || "").trim()) throw new Error("得意先を入力してください。");
  if (!String(input.product || "").trim()) throw new Error("品名を入力してください。");
  if (input.dueDate && !isValidIsoDate_(String(input.dueDate))) throw new Error("納期は正しい日付で入力してください。");
  if (input.quantity !== "" && input.quantity !== null && input.quantity !== undefined) {
    var quantity = Number(input.quantity);
    if (!isFinite(quantity) || quantity < 0) throw new Error("数量は0以上の数値で入力してください。");
  }
}

function isValidIsoDate_(value) {
  var match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function sanitizeText_(value, maxLength) {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, maxLength || 500);
}

function sanitizeStatus_(value) {
  var allowed = ["not_started", "working", "done", "hold"];
  return allowed.indexOf(value) >= 0 ? value : "not_started";
}

function sanitizeAssignee_(value, stageKey) {
  var text = sanitizeText_(value, 80);
  if (!text) return "";
  if (APP.ASSIGNEES.indexOf(text) < 0) {
    throw new Error("工程「" + stageKey + "」の担当者が不正です。固定担当者から選択してください。");
  }
  return text;
}

function storedProductCode_(value) {
  var code = String(value || "").normalize("NFKC").trim().replace(/[‐‑–−]/g, "-");
  // The reference master can use purchase-style numbers as product identities.
  return code;
}

function legacyProductCodeFromNote_(note) {
  var match = String(note || "").match(/(?:^|\s*\/\s*)品番\s*[:：]\s*([A-ZＡ-Ｚ0-9０-９]+(?:[_＿\-－‐‑–−][A-ZＡ-Ｚ0-9０-９]+)*)/i);
  return match ? storedProductCode_(match[1]) : "";
}

function sanitizeDistributionAssignee_(value) {
  var text = sanitizeText_(value, 80);
  if (text && APP.ASSIGNEES.indexOf(text) < 0) {
    throw new Error("配布担当者が不正です。固定担当者から選択してください。");
  }
  return text;
}

function normalizeLabelPrintStatus_(value) {
  var status = String(value || "");
  return ["waiting", "reprint", "printed", "not_required"].indexOf(status) >= 0 ? status : "not_required";
}

function labelContentChanged_(existing, next) {
  if (!existing) return false;
  return ["customer", "product", "productCode", "dueDate", "quantity", "specLength", "specShape", "bladeWidth", "serialNo"]
    .some(function(key) { return String(existing[key] === undefined || existing[key] === null ? "" : existing[key]) !== String(next[key] === undefined || next[key] === null ? "" : next[key]); });
}

function normalizeJobInput_(input, existing, normalizationOptions) {
  validateJob_(input);
  var now = new Date().toISOString();
  var product = sanitizeText_(input.product, 240);
  var inferredSpecs = inferSpecsFromProductName_(product, {
    specLength: sanitizeText_(input.specLength, 80),
    specShape: sanitizeText_(input.specShape, 120),
    bladeWidth: sanitizeText_(input.bladeWidth, 80)
  });
  var rawCategory = input.category;
  if (rawCategory === undefined || rawCategory === null) rawCategory = existing ? existing.category : "";
  var stages = {};
  APP.STAGES.forEach(function(key) {
    var source = input.stages && input.stages[key] ? input.stages[key] : {};
    stages[key] = { status: sanitizeStatus_(source.status), assignee: sanitizeAssignee_(source.assignee, key) };
  });
  var shipping = ["not_ready", "waiting", "shipped", "hold"].indexOf(input.shippingStatus) >= 0 ? input.shippingStatus : "not_ready";
  var priority = ["normal", "high", "urgent"].indexOf(input.priority) >= 0 ? input.priority : "normal";
  var polishing = normalizePolishing_(existing ? existing.polishing : null);
  var quantityValue = input.quantity === "" || input.quantity === null || input.quantity === undefined ? 0 : Number(input.quantity);
  if (existing && polishing.sentQuantity > quantityValue) throw new Error("研磨へ送付済みの数量より少なくできません。");
  var completed = shipping === "shipped";
  var wasShipped = existing && existing.shippingStatus === "shipped";
  var next = {
    id: existing ? existing.id : sanitizeText_(input.id, 80) || Utilities.getUuid(),
    customer: sanitizeText_(input.customer, 160),
    product: product,
    dueDate: sanitizeText_(input.dueDate, 10),
    quantity: input.quantity === "" || input.quantity === null || input.quantity === undefined ? "" : Number(input.quantity),
    specLength: inferredSpecs.specLength,
    specShape: inferredSpecs.specShape,
    bladeWidth: inferredSpecs.bladeWidth,
    serialNo: sanitizeText_(input.serialNo, 120),
    externalOrderNo: sanitizeText_(input.externalOrderNo === undefined ? (existing ? existing.externalOrderNo : "") : input.externalOrderNo, 240),
    externalLineNo: sanitizeText_(input.externalLineNo === undefined ? (existing ? existing.externalLineNo : "") : input.externalLineNo, 120),
    category: normalizeCategory_(rawCategory, product, true),
    stages: stages,
    shippingStatus: shipping,
    note: sanitizeText_(input.note, 1000),
    sourceType: existing ? existing.sourceType : sanitizeText_(input.sourceType, 40) || "manual",
    sourceRef: existing ? existing.sourceRef : sanitizeText_(input.sourceRef, 500),
    priority: priority,
    archived: input.archived === true,
    createdAt: existing ? existing.createdAt : sanitizeText_(input.createdAt, 40) || now,
    updatedAt: now,
    version: existing ? Number(existing.version || 1) + 1 : 1,
    completedAt: completed ? (wasShipped ? existing.completedAt || "" : now) : "",
    polishing: polishing,
    materials: existing ? existing.materials : null,
    _materialsJsonRaw: existing ? existing._materialsJsonRaw : "",
    _processSaveJsonRaw: existing ? existing._processSaveJsonRaw : ""
  };
  next.productCode = sanitizeText_(input.productCode === undefined || input.productCode === null
    ? (existing ? existing.productCode : "")
    : input.productCode, 120);
  next.stockPlannedQuantity = typeof FinishedStock !== "undefined"
    ? FinishedStock.normalizePlannedQuantity(input.stockPlannedQuantity === undefined ? (existing ? existing.stockPlannedQuantity : 0) : input.stockPlannedQuantity, next.quantity)
    : Number(input.stockPlannedQuantity === undefined ? (existing ? existing.stockPlannedQuantity : 0) : input.stockPlannedQuantity) || 0;
  var fulfillment = existing && !existing.archived && !next.archived && shipping === "shipped" && typeof FinishedStock !== "undefined" && typeof readFinishedStockEventsIfPresent_ === "function"
    ? FinishedStock.fulfillment(next, readFinishedStockEventsIfPresent_()) : null;
  if (fulfillment) {
    if (stages.finish.status === "done") throw new Error("製造不要の受注は最終仕上げを完了にせず、受注履行完了を記録してください。");
    next.completionKind = "stock_fulfillment";
    next.completedAt = new Date(fulfillment.date + "T00:00:00+09:00").toISOString();
  } else {
    if (shipping === "shipped" && existing && existing.completionKind === "stock_fulfillment") throw new Error("有効な在庫出荷が注文数量を満たしていません。受注を再開して出荷履歴を確認してください。");
    validatePolishingLifecycle_(polishing, quantityValue, stages.finish.status, shipping, existing,
      !existing && normalizationOptions && normalizationOptions.historicalImport === true);
    next.completionKind = "";
  }
  if (typeof FinishedStock !== "undefined") FinishedStock.validateJob(next, existing, []);
  // Remove the legacy note encoding once the dedicated field is saved, so an
  // explicit productCode clear does not reappear on the next read.
  if (Object.prototype.hasOwnProperty.call(input, "productCode")) {
    next.note = next.note.replace(/(?:^|\s*\/\s*)品番\s*[:：]\s*[A-ZＡ-Ｚ0-9０-９]+(?:[-－‐‑–−][A-ZＡ-Ｚ0-9０-９]+)*/ig, "").replace(/^\s*\/\s*|\s*\/\s*$/g, "").replace(/\s*\/\s*\/\s*/g, " / ").trim();
  }
  next.distributionAssignee = sanitizeDistributionAssignee_(input.distributionAssignee === undefined
    ? (existing ? existing.distributionAssignee : "")
    : input.distributionAssignee);
  var requestedLabelStatus = input.labelPrintStatus === undefined
    ? (existing ? existing.labelPrintStatus : "not_required")
    : input.labelPrintStatus;
  next.labelPrintStatus = normalizeLabelPrintStatus_(requestedLabelStatus);
  next.labelPrintedAt = next.labelPrintStatus === "printed"
    ? (existing && existing.labelPrintedAt ? existing.labelPrintedAt : now)
    : "";
  if (existing && existing.labelPrintStatus === "printed" && next.labelPrintStatus !== "not_required" && labelContentChanged_(existing, next)) {
    next.labelPrintStatus = "reprint";
    next.labelPrintedAt = "";
  }
  return next;
}

function jobToRow_(job) {
  var flat = {
    id: job.id, customer: job.customer, product: job.product, dueDate: job.dueDate, quantity: job.quantity,
    specLength: job.specLength, specShape: job.specShape, bladeWidth: job.bladeWidth, serialNo: job.serialNo,
    shippingStatus: job.shippingStatus, note: job.note, sourceType: job.sourceType, sourceRef: job.sourceRef,
    priority: job.priority, archived: job.archived, createdAt: job.createdAt, updatedAt: job.updatedAt, version: job.version,
    completedAt: job.completedAt, category: job.category, completionKind: job.completionKind || "",
    labelPrintStatus: job.labelPrintStatus, labelPrintedAt: job.labelPrintedAt,
    distributionAssignee: job.distributionAssignee,
    polishingJson: job._polishingJsonRaw !== undefined ? job._polishingJsonRaw : JSON.stringify(normalizePolishing_(job.polishing)),
    productCode: job.productCode, externalOrderNo: job.externalOrderNo, externalLineNo: job.externalLineNo,
    stockPlannedQuantity: job.stockPlannedQuantity || 0,
    processSaveJson: job._processSaveJsonRaw || "",
    materialsJson: job.materials !== undefined && job.materials !== null && typeof MaterialInventory !== "undefined"
      ? JSON.stringify(MaterialInventory.normalizeState(job.materials)) : job._materialsJsonRaw || ""
  };
  APP.STAGES.forEach(function(key) {
    flat[key + "Status"] = job.stages[key].status;
    flat[key + "Assignee"] = job.stages[key].assignee;
  });
  return APP.JOB_HEADERS.map(function(header) { return flat[header] === undefined ? "" : flat[header]; });
}

function saveJob(input) {
  requireEditorAccess_();
  ensureSystem_();
  return withDocumentLock_(function() { return saveJobUnlocked_(input); });
}

function decorateJobForResponse_(job, settings) {
  var response = typeof decorateProductJobs_ === "function" ? decorateProductJobs_([job], settings || readSettings_())[0] : job;
  return typeof materialJobForAccess_ === "function" ? materialJobForAccess_(response, typeof requireAppAccess_ === "function" ? requireAppAccess_() : null) : response;
}

// The job row (including material usage/retry identity) can commit before its
// separate product-label setting. Repair only that pending side effect, without
// rewriting the job or replacing a newer editor's setting.
function finishRetriedJobSave_(input, job) {
  // A later save can change the product identity. An old retry must never apply
  // its former label choice to that newer job or its product settings.
  if (Number(job.version) !== Number(input.version || 0) + 1) return decorateJobForResponse_(job);
  var labelRule = null;
  if (typeof prepareProductLabelRule_ === "function") {
    if (input.productLabelRule !== undefined) {
      var currentRules = (readSettings_() || {}).productLabelRules || "{}";
      var probeInput = Object.assign({}, input, { productLabelRule: Object.assign({}, input.productLabelRule, { expectedRules: currentRules }) });
      var probe = prepareProductLabelRule_(probeInput, job, null);
      if (probe && !probe.changed) labelRule = probe;
    }
    if (!labelRule) {
      labelRule = prepareProductLabelRule_(input, job, null);
      if (labelRule) commitProductLabelRule_(labelRule, job);
    }
  }
  var response = decorateJobForResponse_(job);
  if (labelRule) response.productLabelRules = labelRule.value;
  return response;
}

function saveJobUnlocked_(input, processOnlyRow, lockedRows) {
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.JOBS);
  var rows = lockedRows || readRows_(APP.SHEETS.JOBS, APP.JOB_HEADERS);
  if (!processOnlyRow && input.requestId && typeof MaterialInventory !== "undefined") {
    var retriedJob = MaterialInventory.findRequest(rows.map(jobFromRow_), String(input.requestId).trim(), MaterialInventory.jobRequestHash(input));
    if (retriedJob) return finishRetriedJobSave_(input, retriedJob);
  }
  var row = rows.find(function(record) { return String(record.id) === String(input.id || ""); });
  if (!row && input.sourceRef) {
    var duplicate = rows.find(function(record) {
      return !isArchivedValue_(record.archived) && String(record.sourceRef || "") === String(input.sourceRef);
    });
    if (duplicate) return decorateJobForResponse_(jobFromRow_(duplicate));
  }
  var existing = row ? jobFromRow_(row) : null;
  if (!existing && Number(input.version || 0) > 0) throw new Error("案件が見つかりません。画面を更新してください。");
  if (existing && existing.archived) throw new Error("削除済みの案件は更新できません。");
  if (existing && Number(input.version || 0) !== Number(existing.version || 0)) {
    throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
  }
  var job = normalizeJobInput_(input, existing);
  if (typeof FinishedStock !== "undefined" && (Number(job.stockPlannedQuantity || 0) > 0 || Number(existing && existing.stockPlannedQuantity || 0) > 0 || /tezoe/i.test(job.product || "") || /tezoe/i.test(existing && existing.product || ""))) {
    var stockEvents = readFinishedStockEventsIfPresent_();
    FinishedStock.validateJob(job, existing, stockEvents);
    if (existing && existing.shippingStatus !== "shipped" && job.shippingStatus === "shipped") {
      var orderBeforeShipment = FinishedStock.snapshot({ jobs: rows.map(jobFromRow_), events: stockEvents }).orders.filter(function(order) { return order.jobId === job.id; })[0];
      FinishedStock.validateShipmentCompletion(orderBeforeShipment, job);
    }
  }
  if (!processOnlyRow && typeof prepareJobMaterials_ === "function" && typeof MaterialInventory !== "undefined") job.materials = prepareJobMaterials_(existing, job, input);
  var labelRule = !processOnlyRow && typeof prepareProductLabelRule_ === "function" ? prepareProductLabelRule_(input, job, existing) : null;
  if (labelRule && labelRule.changed && existing && existing.labelPrintStatus === "printed" && job.labelPrintStatus !== "not_required") {
    job.labelPrintStatus = "reprint";
    job.labelPrintedAt = "";
  }
  var rowJob = job;
  if (processOnlyRow) {
    // Preserve the stored representation exactly for fields outside the worker
    // contract, including intentionally empty specs/category and print state.
    rowJob = {};
    Object.keys(job).forEach(function(key) { rowJob[key] = job[key]; });
    ["customer", "product", "dueDate", "quantity", "specLength", "specShape", "bladeWidth", "serialNo",
      "category", "note", "sourceType", "sourceRef", "priority", "archived", "createdAt", "labelPrintStatus",
      "labelPrintedAt", "distributionAssignee", "productCode", "externalOrderNo", "externalLineNo", "stockPlannedQuantity"].forEach(function(key) {
      rowJob[key] = processOnlyRow[key] === undefined ? "" : processOnlyRow[key];
    });
    rowJob.polishing = normalizePolishing_(processOnlyRow.polishingJson);
    rowJob._polishingJsonRaw = processOnlyRow.polishingJson;
    rowJob._materialsJsonRaw = processOnlyRow.materialsJson;
    rowJob._processSaveJsonRaw = processOnlyRow.processSaveJson || "";
    job._processSaveJsonRaw = rowJob._processSaveJsonRaw;
    rowJob.materials = undefined;
  }
  var values = [jobToRow_(rowJob)];
  var rowNumber = row ? row._rowNumber : sheet.getLastRow() + 1;
  sheet.getRange(rowNumber, 1, 1, APP.JOB_HEADERS.length).setValues(sheetValues_(values));
  SpreadsheetApp.flush();
  if (labelRule) commitProductLabelRule_(labelRule, job);
  var settings = typeof decorateProductJobs_ === "function" ? readSettings_() : null;
  if (typeof syncPolishingMirrorBestEffort_ === "function" &&
      (typeof polishingMirrorNeedsJobUpdate_ !== "function" || polishingMirrorNeedsJobUpdate_(existing, job))) {
    syncPolishingMirrorBestEffort_(jobsAfterRowUpdates_(rows, [{ rowNumber: rowNumber, values: values[0] }]), settings);
  }
  appendLog_(existing ? "job.update" : "job.create", "job", job.id, { version: job.version, sourceType: job.sourceType });
  var response = decorateJobForResponse_(job, settings);
  if (labelRule) response.productLabelRules = labelRule.value;
  return response;
}

/**
 * 案件はシートの行を物理削除せず、archivedフラグで一覧から外す。
 * 更新番号を検証するため、別端末の編集を誤って隠すこともない。
 */
function setJobArchived(input) {
  requireEditorAccess_();
  ensureSystem_();
  if (!input || !input.id) throw new Error("案件を特定できません。");
  return withDocumentLock_(function() {
    var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.JOBS);
    var rows = readRows_(APP.SHEETS.JOBS, APP.JOB_HEADERS);
    var row = rows.find(function(record) { return String(record.id) === String(input.id); });
    if (!row) throw new Error("案件が見つかりません。画面を更新してください。");
    var job = jobFromRow_(row);
    if (Number(input.version || 0) !== Number(job.version || 0)) {
      throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
    }
    if (input.archived === true && polishingOutstanding_(job.polishing) > 0) throw new Error("研磨から未返却の数量がある案件は削除できません。");
    var previous = Object.assign({}, job);
    job.archived = input.archived === true;
    job.updatedAt = new Date().toISOString();
    job.version = Number(job.version || 1) + 1;
    var values = jobToRow_(job);
    sheet.getRange(row._rowNumber, 1, 1, APP.JOB_HEADERS.length).setValues(sheetValues_([values]));
    SpreadsheetApp.flush();
    var settings = typeof decorateProductJobs_ === "function" ? readSettings_() : null;
    if (typeof syncPolishingMirrorBestEffort_ === "function" &&
        (typeof polishingMirrorNeedsJobUpdate_ !== "function" || polishingMirrorNeedsJobUpdate_(previous, job))) {
      syncPolishingMirrorBestEffort_(jobsAfterRowUpdates_(rows, [{ rowNumber: row._rowNumber, values: values }]), settings);
    }
    appendLog_(job.archived ? "job.delete" : "job.restore", "job", job.id, { version: job.version });
    return decorateJobForResponse_(job, settings);
  });
}

function processSaveIdentity_(input) {
  return JSON.stringify({ id: input.id, version: input.version, shippingStatus: input.shippingStatus || "",
    stages: APP.STAGES.filter(function(stage) { return Object.prototype.hasOwnProperty.call(input.stages, stage); }).map(function(stage) {
      return [stage, input.stages[stage].status, input.stages[stage].assignee];
    }) });
}

function saveJobProcess(input) {
  var access = requireWorkerAccess_();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("工程更新の形式が不正です。");
  var allowed = ["id", "version", "stages", "shippingStatus", "requestId"];
  if (Object.keys(input).some(function(key) { return allowed.indexOf(key) < 0; })) throw new Error("工程更新に許可されていない項目があります。");
  if (!input.id || !Number.isInteger(input.version) || !input.stages || typeof input.stages !== "object" || Array.isArray(input.stages)) throw new Error("工程更新の形式が不正です。");
  if (input.requestId !== undefined && (typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 120)) throw new Error("工程保存のリクエストIDが不正です。");
  if (input.shippingStatus !== undefined && ["not_ready", "waiting", "shipped", "hold"].indexOf(input.shippingStatus) < 0) throw new Error("出荷状態が不正です。");
  Object.keys(input.stages).forEach(function(stage) {
    if (APP.STAGES.indexOf(stage) < 0) throw new Error("不明な工程です: " + stage);
    var update = input.stages[stage];
    if (!update || typeof update !== "object" || Array.isArray(update) || Object.keys(update).some(function(key) { return key !== "status" && key !== "assignee"; })) throw new Error("工程更新の形式が不正です。");
    if (["not_started", "working", "done", "hold"].indexOf(update.status) < 0) throw new Error("工程の状態が不正です。");
    if (!Object.prototype.hasOwnProperty.call(update, "assignee")) throw new Error("工程担当の形式が不正です。");
    sanitizeAssignee_(update.assignee, stage);
  });
  ensureSystem_();
  return withDocumentLock_(function() {
    var rows = readRows_(APP.SHEETS.JOBS, APP.JOB_HEADERS, true);
    var row = rows.find(function(record) { return String(record.id) === String(input.id); });
    if (!row) throw new Error("案件が見つかりません。画面を更新してください。");
    var existing = jobFromRow_(row);
    if (existing.archived) throw new Error("削除済みの案件は更新できません。");
    if (input.requestId && existing._processSaveJsonRaw) {
      var previousSave;
      try { previousSave = JSON.parse(existing._processSaveJsonRaw); } catch (error) { throw new Error("工程保存の再試行情報が不正です。管理者に確認してください。"); }
      if (previousSave.requestId === input.requestId) {
        if (previousSave.identity !== processSaveIdentity_(input)) throw new Error("同じリクエストIDで異なる工程を保存できません。");
        return decorateJobForResponse_(existing);
      }
    }
    if (Number(input.version) !== Number(existing.version || 0)) throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
    if (!access.canEdit && (existing.shippingStatus === "shipped" || existing.stages.finish.status === "done" && finalFinishingReady_(existing))) {
      throw new Error("EDITOR_REQUIRED: 出荷待ち・出荷済みの案件を更新するには編集権限が必要です。");
    }
    if (!access.canEdit && input.shippingStatus !== undefined && input.shippingStatus !== existing.shippingStatus) {
      throw new Error("EDITOR_REQUIRED: 出荷状態を変更するには編集権限が必要です。");
    }
    var mergedStages = {};
    APP.STAGES.forEach(function(stage) { mergedStages[stage] = { status: existing.stages[stage].status, assignee: existing.stages[stage].assignee }; });
    Object.keys(input.stages).forEach(function(stage) {
      var update = input.stages[stage];
      mergedStages[stage] = { status: update.status, assignee: update.assignee };
    });
    var safeInput = {
      id: existing.id, version: existing.version, customer: existing.customer, product: existing.product,
      dueDate: existing.dueDate, quantity: existing.quantity, specLength: existing.specLength,
      specShape: existing.specShape, bladeWidth: existing.bladeWidth, serialNo: existing.serialNo,
      stockPlannedQuantity: existing.stockPlannedQuantity,
      category: existing.category, stages: mergedStages,
      shippingStatus: input.shippingStatus === undefined ? existing.shippingStatus : input.shippingStatus,
      note: existing.note, sourceType: existing.sourceType, sourceRef: existing.sourceRef,
      priority: existing.priority, archived: existing.archived, createdAt: existing.createdAt,
      distributionAssignee: existing.distributionAssignee, labelPrintStatus: existing.labelPrintStatus,
      labelPrintedAt: existing.labelPrintedAt
    };
    var rawValues = row._rawValues;
    var rawRow = {};
    APP.JOB_HEADERS.forEach(function(header, index) { rawRow[header] = rawValues[index]; });
    if (input.requestId) rawRow.processSaveJson = JSON.stringify({ requestId: input.requestId, identity: processSaveIdentity_(input) });
    return saveJobUnlocked_(safeInput, rawRow, rows);
  });
}

function setDistributionAssignee(input) {
  var access = requireWorkerAccess_();
  ensureSystem_();
  if (!input || !input.id) throw new Error("案件を特定できません。");
  return withDocumentLock_(function() {
    var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.JOBS);
    var rows = readRows_(APP.SHEETS.JOBS, APP.JOB_HEADERS);
    var row = rows.find(function(record) { return String(record.id) === String(input.id); });
    if (!row) throw new Error("案件が見つかりません。画面を更新してください。");
    var job = jobFromRow_(row);
    if (job.archived) throw new Error("削除済みの案件には配布担当を設定できません。");
    if (job.category !== "鋭匙鉗子") throw new Error("配布担当を設定できるのは鋭匙鉗子の案件だけです。");
    if (Number(input.version || 0) !== Number(job.version || 0)) {
      throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
    }
    if (!access.canEdit && (job.shippingStatus === "shipped" || job.stages.finish.status === "done" && finalFinishingReady_(job))) {
      throw new Error("EDITOR_REQUIRED: 出荷待ち・出荷済みの案件を更新するには編集権限が必要です。");
    }
    var assignee = sanitizeDistributionAssignee_(input.assignee);
    if (assignee === job.distributionAssignee) return decorateJobForResponse_(job);

    job.distributionAssignee = assignee;
    job.updatedAt = new Date().toISOString();
    job.version = Number(job.version || 1) + 1;
    sheet.getRange(row._rowNumber, 1, 1, APP.JOB_HEADERS.length).setValues(sheetValues_([jobToRow_(job)]));
    SpreadsheetApp.flush();
    appendLog_("job.distribution-assignee", "job", job.id, { assignee: assignee, version: job.version });
    return decorateJobForResponse_(job);
  });
}

function markLabelsPrinted(input) {
  requireEditorAccess_();
  ensureSystem_();
  var requested = input && Array.isArray(input.jobs) ? input.jobs.slice(0, 9) : [];
  if (!requested.length) throw new Error("印刷済みにする案件がありません。");
  return withDocumentLock_(function() {
    var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.JOBS);
    var rows = readRows_(APP.SHEETS.JOBS, APP.JOB_HEADERS);
    var now = new Date().toISOString();
    var updates = requested.map(function(item) {
      var row = rows.find(function(record) { return String(record.id) === String(item.id || ""); });
      if (!row) throw new Error("印刷対象の案件が見つかりません。画面を更新してください。");
      var job = jobFromRow_(row);
      if (Number(item.version || 0) !== Number(job.version || 0)) {
        throw new Error("印刷対象が別の端末で更新されています。画面を更新してラベル内容を確認してください。");
      }
      job.labelPrintStatus = "printed";
      job.labelPrintedAt = now;
      job.updatedAt = now;
      job.version = Number(job.version || 1) + 1;
      return { rowNumber: row._rowNumber, job: job };
    });
    updates.forEach(function(update) {
      sheet.getRange(update.rowNumber, 1, 1, APP.JOB_HEADERS.length).setValues(sheetValues_([jobToRow_(update.job)]));
      appendLog_("label.print", "job", update.job.id, { printedAt: now });
    });
    SpreadsheetApp.flush();
    var settings = typeof decorateProductJobs_ === "function" ? readSettings_() : null;
    return updates.map(function(update) { return decorateJobForResponse_(update.job, settings); });
  });
}

function withDocumentLock_(callback) {
  // Keep the legacy helper name, but every entry point must use the same
  // script-wide mutex (including AccessControl). Web apps have no document lock.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function readIntake_() {
  return readRows_(APP.SHEETS.INTAKE, APP.INTAKE_HEADERS).map(function(row) {
    var parsed = {};
    try { parsed = row.parsedJson ? JSON.parse(String(row.parsedJson)) : {}; } catch (error) { parsed = {}; }
    return {
      id: String(row.id || ""), sourceType: String(row.sourceType || ""), sourceRef: String(row.sourceRef || ""),
      receivedAt: normalizeDateTime_(row.receivedAt), sender: String(row.sender || ""), subject: String(row.subject || ""),
      originalText: String(row.originalText || ""), parsed: parsed, confidence: Number(row.confidence || 0),
      status: String(row.status || "pending"), createdAt: normalizeDateTime_(row.createdAt), updatedAt: normalizeDateTime_(row.updatedAt)
    };
  });
}

function appendIntake_(item) {
  return appendIntakes_([item])[0];
}

// Validate/prepare the entire batch before the first write. Callers hold the
// shared lock. A range write is not a transaction: callers must verify/recover
// a partial or uncertain write using their stable source identities.
function appendIntakes_(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error("取込候補は1〜100件で保存してください。");
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.INTAKE);
  var now = new Date().toISOString();
  var normalizedItems = items.map(function(item) { return {
    id: item.id || Utilities.getUuid(), sourceType: sanitizeText_(item.sourceType, 40), sourceRef: sanitizeText_(item.sourceRef, 500),
    receivedAt: item.receivedAt || now, sender: sanitizeText_(item.sender, 240), subject: sanitizeText_(item.subject, 500),
    originalText: sanitizeText_(item.originalText, 45000), parsedJson: JSON.stringify(item.parsed || {}),
    confidence: Number(item.confidence || 0), status: item.status || "pending", createdAt: now, updatedAt: now
  }; });
  var rows = normalizedItems.map(function(normalized) {
    return APP.INTAKE_HEADERS.map(function(header) { return normalized[header] === undefined ? "" : normalized[header]; });
  });
  if (rows.some(function(row) { return row.some(function(value) { return typeof value === "string" && value.length > 45000; }); })) {
    throw new Error("取込候補の保存文字数が上限を超えています。原本を分けて再度読み取ってください。");
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, APP.INTAKE_HEADERS.length).setValues(sheetValues_(rows));
  return normalizedItems.map(function(normalized, index) { return {
    id: normalized.id, sourceType: normalized.sourceType, sourceRef: normalized.sourceRef, receivedAt: normalized.receivedAt,
    sender: normalized.sender, subject: normalized.subject, originalText: normalized.originalText, parsed: items[index].parsed || {},
    confidence: normalized.confidence, status: normalized.status, createdAt: now, updatedAt: now
  }; });
}

function appendIntakeIfNew_(item) {
  return withDocumentLock_(function() {
    var exists = readIntake_().some(function(entry) { return entry.sourceRef === item.sourceRef && entry.status === "pending"; }) ||
      readJobs_().some(function(job) { return !job.archived && job.sourceRef === item.sourceRef; });
    return exists ? null : appendIntake_(item);
  });
}

function updateIntakeStatus_(id, status) {
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.INTAKE);
  var rows = readRows_(APP.SHEETS.INTAKE, APP.INTAKE_HEADERS);
  var row = rows.find(function(record) { return String(record.id) === String(id); });
  if (!row) throw new Error("取込候補が見つかりません。画面を更新してください。");
  var statusColumn = APP.INTAKE_HEADERS.indexOf("status") + 1;
  var updatedColumn = APP.INTAKE_HEADERS.indexOf("updatedAt") + 1;
  sheet.getRange(row._rowNumber, statusColumn).setValue(sheetCellValue_(status));
  sheet.getRange(row._rowNumber, updatedColumn).setValue(new Date().toISOString());
}

function approveIntake(input) {
  requireEditorAccess_();
  if (!input || !input.intakeId) throw new Error("取込候補を特定できません。");
  var result = approveIntakes({ items: [input] });
  if (result.errors.length) {
    if (result.errors[0].code === "INTAKE_DUPLICATE") return result.errors[0];
    throw new Error(result.errors[0].message);
  }
  var saved = result.items[0];
  return saved.learningNotice ? Object.assign({}, saved.job, { importLearningNotice: saved.learningNotice }) : saved.job;
}

/**
 * 確認済みの取込候補を複数案件へ反映する。
 *
 * 一括処理では、候補と案件の存在確認・入力検証を先に全件行う。
 * その後の保存は1つのドキュメントロック内で候補ごとに独立して行い、
 * 途中の行で失敗しても、成功した行を失わずに結果へ返す。
 */
function approveIntakes(input) {
  requireEditorAccess_();
  ensureSystem_();
  var requests = input && Array.isArray(input.items) ? input.items : null;
  if (!requests || !requests.length || requests.length > 100) throw new Error("1〜100件を選択してください。");

  return withDocumentLock_(function() {
    var intakeItems = readIntake_();
    var jobs = readJobs_();
    var prepared = [];
    var validationErrors = [];
    var seen = {};

    requests.forEach(function(request) {
      request = request && typeof request === "object" && !Array.isArray(request) ? request : {};
      var requestedIntakeId = request.intakeId;
      var intakeId = requestedIntakeId === undefined || requestedIntakeId === null ? "" : String(requestedIntakeId);
      var duplicate = Object.prototype.hasOwnProperty.call(seen, intakeId);
      seen[intakeId] = true;
      var candidate = intakeItems.find(function(item) { return String(item.id || "") === intakeId; });
      var existing = findIntakeApprovalJob_(jobs, intakeId, candidate, intakeItems);
      var candidateStatus = candidate ? String(candidate.status || "pending") : "";
      var message = "";
      var order = null;

      if (duplicate) message = "同じ候補が重複しています。";
      if (!intakeId) message = message || "取込候補を特定できません。";
      if (!candidate || ["pending", "approved"].indexOf(candidateStatus) < 0) {
        message = message || "この候補は処理済みか、見つかりません。";
      }
      if (!existing && hasAmbiguousLegacyIntakeJob_(jobs, candidate, intakeItems)) {
        message = message || "対応する案件を特定できません。";
      }
      if (candidateStatus === "approved" && !existing) {
        message = message || "反映済みの案件が見つかりません。";
      }
      // 既に案件が存在する行は、書き込み途中で再試行された可能性がある。
      // 入力を再検証して失敗させると、保存済み案件を返せなくなるため、既存案件を正とする。
      if (!message && !existing) {
        try {
          order = normalizeBulkIntakeOrder_(intakeId, request.order, candidate);
        } catch (error) {
          message = bulkApprovalErrorMessage_(error);
        }
      }
      if (message) validationErrors.push({ intakeId: requestedIntakeId, message: message });
      prepared.push({
        intakeId: requestedIntakeId,
        intakeKey: intakeId,
        candidate: candidate,
        candidateStatus: candidateStatus,
        existing: existing,
        order: order,
        duplicateDecision: request.duplicateDecision,
        learnProduct: request.learnProduct === true,
        learnNote: request.learnNote === true
      });
    });

    // 1件でも検証エラーがあれば、案件・候補のどちらにも書き込まない。
    if (validationErrors.length) return { items: [], errors: validationErrors };

    // The UI preview can be stale. Recheck stored jobs, pending candidates and
    // edited siblings together, after acquiring the same lock used for writes.
    var batchItems = prepared.filter(function(entry) { return !entry.existing; }).map(function(entry) {
      return { intakeId: entry.intakeKey, order: entry.order };
    });
    var duplicateErrors = [];
    prepared.forEach(function(entry) {
      if (entry.existing) return;
      var duplicate = IntakeDuplicates.inspect({
        order: entry.order, intakeId: entry.intakeKey, jobs: jobs, intakes: intakeItems, batchItems: batchItems
      });
      if (!duplicate.matches.length) return;
      if (!IntakeDuplicates.decisionAccepted(duplicate, entry.duplicateDecision)) {
        duplicateErrors.push({ intakeId: entry.intakeId, code: "INTAKE_DUPLICATE", message: duplicate.message,
          matches: duplicate.matches, duplicateSignature: duplicate.duplicateSignature });
        return;
      }
      entry.confirmedDuplicate = duplicate;
    });
    if (duplicateErrors.length) return { items: [], errors: duplicateErrors };

    var savedItems = [];
    var runtimeErrors = [];
    prepared.forEach(function(entry) {
      try {
        var job = entry.existing;
        var alreadyApproved = entry.candidateStatus === "approved";
        if (!job) {
          if (entry.confirmedDuplicate || (entry.candidate.parsed && entry.candidate.parsed._duplicateApproval)) {
            recordIntakeDuplicateDecision_(entry.candidate, entry.confirmedDuplicate);
          }
          job = saveJobUnlocked_(entry.order);
        }

        // approved + existing は完全な再試行なので、候補行・操作履歴も含めて書き込まない。
        if (!alreadyApproved) {
          // A previous attempt may have saved the job but failed to append the
          // separate-order audit. Recover that audit before approving the row.
          ensureIntakeDuplicateLog_(entry.candidate, job, Boolean(entry.existing));
          var learningNotice = typeof learnIntakeProduct_ === "function" ? learnIntakeProduct_(entry.candidate, job, entry) : "";
          updateIntakeStatus_(entry.intakeId, "approved");
          appendLog_("intake.approve", "intake", entry.intakeId, { jobId: job.id });
        }
        savedItems.push({ intakeId: entry.intakeId, job: job, learningNotice: alreadyApproved ? "" : learningNotice || "" });
      } catch (error) {
        runtimeErrors.push({ intakeId: entry.intakeId, message: bulkApprovalErrorMessage_(error) });
      }
    });
    return { items: savedItems, errors: runtimeErrors };
  });
}

function recordIntakeDuplicateDecision_(candidate, duplicate) {
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.INTAKE);
  var row = readRows_(APP.SHEETS.INTAKE, APP.INTAKE_HEADERS).find(function(item) { return String(item.id) === String(candidate.id); });
  if (!row) throw new Error("取込候補が見つかりません。画面を更新してください。");
  var parsed = candidate.parsed || {};
  if (duplicate) {
    parsed._duplicateApproval = {
      action: "add_separate", signature: duplicate.duplicateSignature, at: new Date().toISOString(),
      matches: duplicate.matches.map(function(match) {
        return { kind: match.kind, id: match.id, status: match.status, reasons: match.reasons };
      })
    };
  } else {
    delete parsed._duplicateApproval;
  }
  sheet.getRange(row._rowNumber, APP.INTAKE_HEADERS.indexOf("parsedJson") + 1).setValue(JSON.stringify(parsed));
  candidate.parsed = parsed;
}

function ensureIntakeDuplicateLog_(candidate, job, retry) {
  var decision = candidate && candidate.parsed && candidate.parsed._duplicateApproval;
  if (!decision || decision.action !== "add_separate" || !decision.signature || !Array.isArray(decision.matches)) return;
  if (retry) {
    var recorded = readRows_(APP.SHEETS.LOG, APP.LOG_HEADERS).some(function(row) {
      return String(row.action) === "intake.add_separate" && String(row.entityType) === "intake" && String(row.entityId) === String(candidate.id);
    });
    if (recorded) return;
  }
  appendLog_("intake.add_separate", "intake", candidate.id, {
    jobId: job.id, decision: "add_separate", duplicateSignature: decision.signature,
    confirmedAt: decision.at, matches: decision.matches
  });
}

function normalizeBulkIntakeOrder_(intakeId, input, candidate) {
  var source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  var order = {};
  Object.keys(source).forEach(function(key) { order[key] = source[key]; });
  var parsed = candidate && candidate.parsed ? candidate.parsed : {};
  var external = IntakeDuplicates.identity(parsed);
  // Order/line identifiers are source metadata even when the edit form does
  // not expose them. Preserve them through approval and subsequent job edits.
  order.externalOrderNo = external.externalOrderNo || sanitizeText_(order.externalOrderNo, 240);
  order.externalLineNo = external.externalLineNo || sanitizeText_(order.externalLineNo, 120);

  // クライアントから渡された案件の識別・状態・履歴は一括取込では採用しない。
  delete order.id;
  delete order.version;
  delete order.createdAt;
  delete order.updatedAt;
  order.sourceType = "intake";
  order.sourceRef = intakeId;
  order.requestId = "intake-materials:" + intakeId;
  order.labelPrintStatus = "waiting";
  order.labelPrintedAt = "";
  order.shippingStatus = "not_ready";
  order.archived = false;
  order.priority = "normal";
  order.completedAt = "";
  order.stages = {};
  APP.STAGES.forEach(function(key) {
    order.stages[key] = { status: "not_started", assignee: "" };
  });

  var rawQuantity = order.quantity;
  var quantity = typeof rawQuantity === "boolean" ? NaN : Number(rawQuantity);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000000) {
    throw new Error("数量を原本と確認し、1以上の整数で入力してください。");
  }
  // 納期・得意先・品名・分類などの共通ルールは通常の案件正規化へ委譲する。
  normalizeJobInput_(order, null);
  return order;
}

function findIntakeApprovalJob_(jobs, intakeId, candidate, intakeItems) {
  var direct = (jobs || []).find(function(job) {
    return String(job.sourceType || "") === "intake" && String(job.sourceRef || "") === intakeId;
  });
  if (direct) return direct;

  // 旧 approveIntake は候補の sourceType/sourceRef をそのまま保存していた。
  // 既存データも対応する案件として扱い、一括再実行で重複を作らない。
  if (!candidate || !candidate.sourceRef) return null;
  var sibling = hasIntakeSourceSibling_(candidate, intakeItems);
  // 旧形式の sourceRef が複数候補で共有されている場合、どの案件か特定できない。
  if (sibling) return null;
  return (jobs || []).find(function(job) {
    return String(job.sourceType || "") === String(candidate.sourceType || "") &&
      String(job.sourceRef || "") === String(candidate.sourceRef || "");
  }) || null;
}

function hasIntakeSourceSibling_(candidate, intakeItems) {
  if (!candidate || !candidate.sourceRef) return false;
  return (intakeItems || []).some(function(item) {
    return String(item.id || "") !== String(candidate.id || "") &&
      String(item.sourceType || "") === String(candidate.sourceType || "") &&
      String(item.sourceRef || "") === String(candidate.sourceRef || "");
  });
}

function hasAmbiguousLegacyIntakeJob_(jobs, candidate, intakeItems) {
  if (!hasIntakeSourceSibling_(candidate, intakeItems)) return false;
  return (jobs || []).some(function(job) {
    return String(job.sourceType || "") === String(candidate.sourceType || "") &&
      String(job.sourceRef || "") === String(candidate.sourceRef || "");
  });
}

function bulkApprovalErrorMessage_(error) {
  return error && error.message ? String(error.message) : "一括承認に失敗しました。";
}

function findIntakeRejectionJob_(jobs, candidate) {
  if (!candidate) return null;
  var intakeId = String(candidate.id || "");
  var direct = (jobs || []).find(function(job) {
    return String(job.sourceType || "") === "intake" && String(job.sourceRef || "") === intakeId;
  });
  if (direct) return direct;

  // 旧 rejectIntake/approveIntake は候補の sourceType/sourceRef をそのまま保存した。
  // 既存案件も候補との紐付きを保護し、候補の削除で案件を孤立させない。
  if (!candidate.sourceRef) return null;
  return (jobs || []).find(function(job) {
    return String(job.sourceType || "") === String(candidate.sourceType || "") &&
      String(job.sourceRef || "") === String(candidate.sourceRef || "");
  }) || null;
}

function rejectionErrorMessage_(error) {
  return error && error.message ? String(error.message) : "取込候補の削除に失敗しました。";
}

/**
 * 取込候補を複数選択で非表示化する。候補行は物理削除せず、rejected 状態にする。
 * 承認済み候補や既存案件に紐づく候補は、誤操作や競合から保護する。
 */
function rejectIntakes(input) {
  requireEditorAccess_();
  ensureSystem_();
  var requested = input && Array.isArray(input.intakeIds) ? input.intakeIds : null;
  if (!requested || !requested.length || requested.length > 100) throw new Error("1〜100件を選択してください。");

  return withDocumentLock_(function() {
    var intakeItems = readIntake_();
    var jobs = readJobs_();
    var prepared = [];
    var validationErrors = [];
    var seen = {};

    for (var index = 0; index < requested.length; index += 1) {
      var rawIntakeId = requested[index];
      var intakeId = typeof rawIntakeId === "string" ? rawIntakeId.trim() : "";
      var duplicate = Object.prototype.hasOwnProperty.call(seen, intakeId);
      seen[intakeId] = true;
      var candidate = intakeItems.find(function(item) { return String(item.id || "") === intakeId; });
      var candidateStatus = candidate ? String(candidate.status || "pending") : "";
      var linkedJob = findIntakeRejectionJob_(jobs, candidate);
      var message = "";

      if (duplicate) message = "同じ取込候補が重複しています。";
      if (!intakeId || typeof rawIntakeId !== "string") message = message || "取込候補IDが不正です。";
      if (!candidate) message = message || "この候補は処理済みか、見つかりません。";
      if (candidateStatus === "approved") message = message || "承認済みの取込候補は削除できません。";
      if (linkedJob) message = message || "この候補に紐づく案件が存在するため削除できません。";
      if (candidate && ["pending", "rejected", "approved"].indexOf(candidateStatus) < 0) {
        message = message || "この候補は処理済みか、見つかりません。";
      }

      if (message) validationErrors.push({ intakeId: intakeId, message: message });
      prepared.push({ intakeId: intakeId, candidateStatus: candidateStatus, linkedJob: linkedJob });
    }

    // 入力検証に失敗した場合は全件を書き込まず、呼び出し側が安全に修正して再試行できるようにする。
    if (validationErrors.length) return { items: [], errors: validationErrors };

    var rejectedItems = [];
    var runtimeErrors = [];
    prepared.forEach(function(entry) {
      try {
        // rejected は状態更新を繰り返さず、途中失敗後の再試行を成功扱いにする。
        if (entry.candidateStatus === "pending") {
          updateIntakeStatus_(entry.intakeId, "rejected");
          appendLog_("intake.reject", "intake", entry.intakeId, {});
        }
        rejectedItems.push({ intakeId: entry.intakeId });
      } catch (error) {
        runtimeErrors.push({ intakeId: entry.intakeId, message: rejectionErrorMessage_(error) });
      }
    });
    return { items: rejectedItems, errors: runtimeErrors };
  });
}

function rejectIntake(input) {
  requireEditorAccess_();
  if (!input || !input.intakeId) throw new Error("取込候補を特定できません。");
  var result = rejectIntakes({ intakeIds: [input.intakeId] });
  if (result.errors && result.errors.length) throw new Error(result.errors[0].message);
  return { ok: true };
}

function appendLog_(action, entityType, entityId, detail) {
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.LOG);
  if (!sheet) return;
  var email = "";
  try { email = requireAppAccess_().email; } catch (error) { email = ""; }
  sheet.appendRow(sheetValues_([[new Date().toISOString(), action, entityType, entityId, email, JSON.stringify(detail || {})]])[0]);
}
