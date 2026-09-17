function readRows_(sheetName, headers) {
  var sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  return values.map(function(row, index) {
    return { row: row, rowNumber: index + 2 };
  }).filter(function(entry) {
    return entry.row.some(function(cell) { return cell !== ""; });
  }).map(function(entry) {
    var record = { _rowNumber: entry.rowNumber };
    headers.forEach(function(header, column) { record[header] = serializeCell_(entry.row[column]); });
    return record;
  });
}

function serializeCell_(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function readSettings_() {
  var spreadsheet;
  try { spreadsheet = getSpreadsheet_(); } catch (error) { return {}; }
  var sheet = spreadsheet.getSheetByName(APP.SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() < 2) return {};
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.SETTING_HEADERS.length).getDisplayValues();
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
    dueDate: normalizeStoredDate_(row.dueDate),
    quantity: row.quantity === "" ? "" : Number(row.quantity),
    specLength: inferredSpecs.specLength,
    specShape: inferredSpecs.specShape,
    bladeWidth: inferredSpecs.bladeWidth,
    serialNo: String(row.serialNo || ""),
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
    labelPrintStatus: normalizeLabelPrintStatus_(row.labelPrintStatus),
    labelPrintedAt: normalizeDateTime_(row.labelPrintedAt)
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

function normalizeLabelPrintStatus_(value) {
  var status = String(value || "");
  return ["waiting", "reprint", "printed", "not_required"].indexOf(status) >= 0 ? status : "not_required";
}

function labelContentChanged_(existing, next) {
  if (!existing) return false;
  return ["customer", "product", "dueDate", "quantity", "specLength", "specShape", "bladeWidth", "serialNo"]
    .some(function(key) { return String(existing[key] === undefined || existing[key] === null ? "" : existing[key]) !== String(next[key] === undefined || next[key] === null ? "" : next[key]); });
}

function normalizeJobInput_(input, existing) {
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
  var allStagesDone = APP.STAGES.every(function(key) { return stages[key].status === "done"; });
  if (shipping === "shipped" && !allStagesDone) {
    throw new Error("出荷完了にするには、すべての工程を完了にしてください。");
  }
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
    completedAt: completed ? (wasShipped && existing.completedAt ? existing.completedAt : now) : ""
  };
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
    completedAt: job.completedAt, category: job.category,
    labelPrintStatus: job.labelPrintStatus, labelPrintedAt: job.labelPrintedAt
  };
  APP.STAGES.forEach(function(key) {
    flat[key + "Status"] = job.stages[key].status;
    flat[key + "Assignee"] = job.stages[key].assignee;
  });
  return APP.JOB_HEADERS.map(function(header) { return flat[header] === undefined ? "" : flat[header]; });
}

function saveJob(input) {
  ensureSystem_();
  return withDocumentLock_(function() { return saveJobUnlocked_(input); });
}

function saveJobUnlocked_(input) {
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.JOBS);
  var rows = readRows_(APP.SHEETS.JOBS, APP.JOB_HEADERS);
  var row = rows.find(function(record) { return String(record.id) === String(input.id || ""); });
  if (!row && input.sourceRef) {
    var duplicate = rows.find(function(record) {
      return !isArchivedValue_(record.archived) && String(record.sourceRef || "") === String(input.sourceRef);
    });
    if (duplicate) return jobFromRow_(duplicate);
  }
  var existing = row ? jobFromRow_(row) : null;
  if (existing && Number(input.version || 0) !== Number(existing.version || 0)) {
    throw new Error("別の端末で先に更新されています。画面を更新して内容を確認してください。");
  }
  var job = normalizeJobInput_(input, existing);
  var values = [jobToRow_(job)];
  if (row) sheet.getRange(row._rowNumber, 1, 1, APP.JOB_HEADERS.length).setValues(values);
  else sheet.getRange(sheet.getLastRow() + 1, 1, 1, APP.JOB_HEADERS.length).setValues(values);
  SpreadsheetApp.flush();
  appendLog_(existing ? "job.update" : "job.create", "job", job.id, { version: job.version, sourceType: job.sourceType });
  return job;
}

/**
 * 案件はシートの行を物理削除せず、archivedフラグで一覧から外す。
 * 更新番号を検証するため、別端末の編集を誤って隠すこともない。
 */
function setJobArchived(input) {
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
    job.archived = input.archived === true;
    job.updatedAt = new Date().toISOString();
    job.version = Number(job.version || 1) + 1;
    sheet.getRange(row._rowNumber, 1, 1, APP.JOB_HEADERS.length).setValues([jobToRow_(job)]);
    SpreadsheetApp.flush();
    appendLog_(job.archived ? "job.delete" : "job.restore", "job", job.id, { version: job.version });
    return job;
  });
}

function markLabelsPrinted(input) {
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
      sheet.getRange(update.rowNumber, 1, 1, APP.JOB_HEADERS.length).setValues([jobToRow_(update.job)]);
      appendLog_("label.print", "job", update.job.id, { printedAt: now });
    });
    SpreadsheetApp.flush();
    return updates.map(function(update) { return update.job; });
  });
}

function withDocumentLock_(callback) {
  var lock = LockService.getDocumentLock();
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
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.INTAKE);
  var now = new Date().toISOString();
  var normalized = {
    id: item.id || Utilities.getUuid(), sourceType: sanitizeText_(item.sourceType, 40), sourceRef: sanitizeText_(item.sourceRef, 500),
    receivedAt: item.receivedAt || now, sender: sanitizeText_(item.sender, 240), subject: sanitizeText_(item.subject, 500),
    originalText: sanitizeText_(item.originalText, 45000), parsedJson: JSON.stringify(item.parsed || {}),
    confidence: Number(item.confidence || 0), status: item.status || "pending", createdAt: now, updatedAt: now
  };
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, APP.INTAKE_HEADERS.length)
    .setValues([APP.INTAKE_HEADERS.map(function(header) { return normalized[header] === undefined ? "" : normalized[header]; })]);
  return {
    id: normalized.id, sourceType: normalized.sourceType, sourceRef: normalized.sourceRef, receivedAt: normalized.receivedAt,
    sender: normalized.sender, subject: normalized.subject, originalText: normalized.originalText, parsed: item.parsed || {},
    confidence: normalized.confidence, status: normalized.status, createdAt: now, updatedAt: now
  };
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
  sheet.getRange(row._rowNumber, statusColumn).setValue(status);
  sheet.getRange(row._rowNumber, updatedColumn).setValue(new Date().toISOString());
}

function approveIntake(input) {
  ensureSystem_();
  if (!input || !input.intakeId) throw new Error("取込候補を特定できません。");
  return withDocumentLock_(function() {
    var item = readIntake_().find(function(entry) { return entry.id === input.intakeId && entry.status === "pending"; });
    if (!item) throw new Error("この取込候補は処理済みか、見つかりません。");
    input.order = input.order || {};
    if ((item.sourceType === "text" || (item.parsed && item.parsed._ai)) && (!Number.isInteger(Number(input.order.quantity)) || Number(input.order.quantity) <= 0 || Number(input.order.quantity) > 1000000)) {
      throw new Error("読み取った数量を原本と確認し、1以上の整数で入力してください。");
    }
    input.order.sourceType = item.sourceType;
    input.order.sourceRef = item.sourceRef;
    input.order.labelPrintStatus = "waiting";
    input.order.labelPrintedAt = "";
    var saved = saveJobUnlocked_(input.order);
    updateIntakeStatus_(input.intakeId, "approved");
    appendLog_("intake.approve", "intake", input.intakeId, { jobId: saved.id });
    return saved;
  });
}

/**
 * 確認済みの取込候補を複数案件へ反映する。
 *
 * 一括処理では、候補と案件の存在確認・入力検証を先に全件行う。
 * その後の保存は1つのドキュメントロック内で候補ごとに独立して行い、
 * 途中の行で失敗しても、成功した行を失わずに結果へ返す。
 */
function approveIntakes(input) {
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
          order = normalizeBulkIntakeOrder_(intakeId, request.order);
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
        order: order
      });
    });

    // 1件でも検証エラーがあれば、案件・候補のどちらにも書き込まない。
    if (validationErrors.length) return { items: [], errors: validationErrors };

    var savedItems = [];
    var runtimeErrors = [];
    prepared.forEach(function(entry) {
      try {
        var job = entry.existing;
        var alreadyApproved = entry.candidateStatus === "approved";
        if (!job) job = saveJobUnlocked_(entry.order);

        // approved + existing は完全な再試行なので、候補行・操作履歴も含めて書き込まない。
        if (!alreadyApproved) {
          updateIntakeStatus_(entry.intakeId, "approved");
          appendLog_("intake.approve", "intake", entry.intakeId, { jobId: job.id });
        }
        savedItems.push({ intakeId: entry.intakeId, job: job });
      } catch (error) {
        runtimeErrors.push({ intakeId: entry.intakeId, message: bulkApprovalErrorMessage_(error) });
      }
    });
    return { items: savedItems, errors: runtimeErrors };
  });
}

function normalizeBulkIntakeOrder_(intakeId, input) {
  var source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  var order = {};
  Object.keys(source).forEach(function(key) { order[key] = source[key]; });

  // クライアントから渡された案件の識別・状態・履歴は一括取込では採用しない。
  delete order.id;
  delete order.version;
  delete order.createdAt;
  delete order.updatedAt;
  order.sourceType = "intake";
  order.sourceRef = intakeId;
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
  if (!input || !input.intakeId) throw new Error("取込候補を特定できません。");
  var result = rejectIntakes({ intakeIds: [input.intakeId] });
  if (result.errors && result.errors.length) throw new Error(result.errors[0].message);
  return { ok: true };
}

function appendLog_(action, entityType, entityId, detail) {
  var sheet = getSpreadsheet_().getSheetByName(APP.SHEETS.LOG);
  if (!sheet) return;
  var email = "";
  try { email = Session.getActiveUser().getEmail() || ""; } catch (error) { email = ""; }
  sheet.appendRow([new Date().toISOString(), action, entityType, entityId, email, JSON.stringify(detail || {})]);
}
