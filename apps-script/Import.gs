function createIntakeFromImage(input) {
  ensureSystem_();
  if (!input || !input.base64 || !input.mimeType) throw new Error("画像データがありません。");
  if (!["image/jpeg", "image/png", "image/gif", "image/bmp", "image/webp", "application/pdf"].includes(input.mimeType)) {
    throw new Error("JPEG・PNG・GIF・BMP・WEBP・PDFを選択してください。");
  }
  if (String(input.base64).length > 12 * 1024 * 1024) throw new Error("ファイルが大きすぎます。8 MB以下にしてください。");

  var bytes = Utilities.base64Decode(input.base64);
  var blob = Utilities.newBlob(bytes, input.mimeType, sanitizeText_(input.name, 200) || "order-image");
  var text = ocrBlob_(blob);
  return createIntakeFromExtractedText_(text, input);
}

function createIntakeFromPdfText(input) {
  ensureSystem_();
  if (!input || input.mimeType !== "application/pdf") throw new Error("PDFデータがありません。");
  var text = String(input.text || "").trim();
  if (!text) throw new Error("PDF内に文字を検出できませんでした。画像としてOCRを試してください。");
  if (text.length > 200000) throw new Error("PDF内の文字量が多すぎます。必要なページだけに分けてください。");
  return createIntakeFromExtractedText_(text, input);
}

/**
 * 貼り付けた注文本文を、Gmailや添付ファイルなしで確認候補にする。
 * 本文は保存時に原文を渡し、AIでも同じ確認キューを経由する。
 */
function createIntakeFromText(input) {
  var validated = validateTextIntakeInput_(input);
  ensureSystem_();
  var saveInput = { name: validated.name, sourceType: "text" };
  var results;
  if (validated.engine === "ai") {
    // Paste intake deliberately drops files/base64 so the text endpoint never
    // turns into an attachment or Gmail import path.
    results = runAiImport_({ name: validated.name, text: validated.text });
  } else {
    results = parsePastedOrderItems_(validated.text, { subject: validated.name });
  }
  return saveParsedIntake_(results, validated.text, saveInput);
}

function validateTextIntakeInput_(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("入力形式が不正です。");
  if (typeof input.text !== "string") throw new Error("本文は文字列で指定してください。");
  if (!input.text.trim()) throw new Error("本文を入力してください。");
  if (input.text.length > 30000) throw new Error("本文は30000文字以下にしてください。");

  var name = input.name === undefined || input.name === null ? "" : input.name;
  if (typeof name !== "string") throw new Error("名前は文字列で指定してください。");
  if (name.length > 200) throw new Error("名前は200文字以下にしてください。");

  var engine = input.engine === undefined ? "legacy" : input.engine;
  if (engine !== "legacy" && engine !== "ai") throw new Error("読取エンジンが不正です。従来の読取またはAIを選択してください。");
  return { name: name.trim(), text: input.text, engine: engine };
}

/**
 * 一般的なラベル形式の本文は、品名ラベルを明細境界として分割する。
 * 共通ヘッダー（得意先・納期など）は各明細へ複製し、実際の抽出は
 * 既存のparseOrderItems_へ委譲する。TC発注書は専用解析を優先する。
 */
function parsePastedOrderItems_(text, context) {
  var source = String(text || "");
  if (/\bTC[_\-\s]*[0-9]{2}[_\-\s]*[0-9]{3,5}\b/i.test(normalizeOrderText_(source))) {
    return parseOrderItems_(source, context || {});
  }

  var lines = source.replace(/\r\n?/g, "\n").split("\n");
  var productStarts = [];
  var productLabel = /^\s*(?:品名|商品名|製品名|器具名|注文品)\s*(?:(?:[:：].*)|(?:\s+.*))$/i;
  lines.forEach(function(line, index) {
    if (productLabel.test(line)) productStarts.push(index);
  });
  if (!productStarts.length) return parseOrderItems_(source, context || {});

  var prefix = lines.slice(0, productStarts[0]);
  var results = [];
  productStarts.forEach(function(start, index) {
    var end = index + 1 < productStarts.length ? productStarts[index + 1] : lines.length;
    // Put the item block first so an item-level label wins over a shared
    // header (for example, an item-specific 納期 after a common 納期).
    var block = lines.slice(start, end).concat(prefix).join("\n");
    parseOrderItems_(block, context || {}).forEach(function(result) { results.push(result); });
  });
  return results;
}

function createIntakeFromExtractedText_(text, input) {
  var parsedResults = parseOrderItems_(text, { subject: input.name || "" });
  return saveParsedIntake_(parsedResults, text, input);
}

function saveParsedIntake_(parsedResults, text, input) {
  input = input || {};
  var batchId = Utilities.getUuid();
  var receivedAt = new Date().toISOString();
  var fileName = sanitizeText_(input.name, 200);
  var sourceType = input.sourceType || "image";
  var items = withDocumentLock_(function() {
    return parsedResults.map(function(parsedResult, index) {
      var itemNumber = parsedResult.itemNumber || index + 1;
      var multiItem = parsedResults.length > 1;
      var sourceRef = sourceType === "text"
        ? "paste:" + batchId + (multiItem ? ":item:" + itemNumber : "") + ":" + (fileName || "pasted-text")
        : "upload:" + batchId + (multiItem ? ":item:" + itemNumber : "") + ":" + fileName;
      return appendIntake_({
        sourceType: sourceType,
        sourceRef: sourceRef,
        receivedAt: receivedAt,
        sender: "",
        subject: intakeSubject_(fileName, parsedResult, index, parsedResults.length),
        originalText: intakePreviewText_(text, parsedResult, index, parsedResults.length),
        parsed: parsedResult.parsed,
        confidence: parsedResult.confidence,
        status: "pending"
      });
    });
  });
  appendLog_("intake." + sourceType, "intake", "batch:" + batchId, { name: input.name, added: items.length });
  return { added: items.length, items: items };
}

function intakeSubject_(subject, parsedResult, index, total) {
  var base = sanitizeText_(subject, 440) || "注文情報";
  if (total <= 1) return base;
  var itemNumber = parsedResult.itemNumber || index + 1;
  return base + " · 品目" + itemNumber + "（" + (index + 1) + "/" + total + "）";
}

function intakePreviewText_(text, parsedResult, index, total) {
  if (parsedResult.parsed && parsedResult.parsed._ai) {
    var ai = parsedResult.parsed._ai;
    return "AI読取・要確認（精度を保証する数値ではありません）\n文書 " + ai.document + "（0は本文） / ページ " + ai.page + " / 明細 " + ai.row + "\n根拠: " + ai.evidence + "\n確認事項: " + (ai.warnings.join(" / ") || "原本と全項目を照合してください。") + "\n\n" + text;
  }
  if (total <= 1) return text;
  var itemNumber = parsedResult.itemNumber || index + 1;
  var product = parsedResult.parsed && parsedResult.parsed.product ? parsedResult.parsed.product : "品名未判定";
  return "この確認候補: 品目" + itemNumber + " " + product + "\n\n--- 発注書の読取全文 ---\n" + text;
}

function scanOrderEmails(input) {
  ensureSystem_();
  input = input || {};
  if (input.engine === "ai") return scanOrderEmailsWithAi_(input);
  var settings = readSettings_();
  var query = sanitizeText_(input.query || settings.gmailQuery || APP.DEFAULTS.gmailQuery, 1000);
  var requestedThreads = Number(input.maxThreads || settings.maxEmailThreads || 20);
  var maxThreads = isFinite(requestedThreads) ? Math.min(50, Math.max(1, Math.floor(requestedThreads))) : 20;
  var existingRefs = {};
  readIntake_().forEach(function(item) { if (item.status === "pending") existingRefs[item.sourceRef] = true; });
  readJobs_().forEach(function(job) { if (!job.archived) existingRefs[job.sourceRef] = true; });

  var threads = GmailApp.search(query, 0, maxThreads);
  var added = 0;
  var skipped = 0;
  var warnings = [];
  var stop = false;

  threads.forEach(function(thread) {
    if (stop) return;
    thread.getMessages().forEach(function(message) {
      if (stop) return;
      var baseSourceRef = "gmail:" + message.getId();
      if (existingRefs[baseSourceRef]) { skipped += 1; return; }

      var parts = [message.getPlainBody() || ""];
      var attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true })
        .filter(function(attachment) { return /^(image\/(?:jpeg|png|gif|bmp|webp)|application\/pdf)$/i.test(attachment.getContentType()); })
        .slice(0, 3);
      attachments.forEach(function(attachment) {
        try {
          parts.push("\n添付「" + attachment.getName() + "」の読取結果:\n" + ocrBlob_(attachment.copyBlob()));
        } catch (error) {
          warnings.push(attachment.getName() + "を読み取れませんでした: " + error.message);
        }
      });

      var text = parts.join("\n").slice(0, 45000);
      var results = parseOrderItems_(text, { sender: message.getFrom(), subject: message.getSubject() });
      results.forEach(function(result, index) {
        if (stop) return;
        var itemNumber = result.itemNumber || index + 1;
        var sourceRef = results.length > 1 ? baseSourceRef + ":item:" + itemNumber : baseSourceRef;
        if (existingRefs[sourceRef]) { skipped += 1; return; }
        var appended = appendIntakeIfNew_({
          sourceType: "email", sourceRef: sourceRef, receivedAt: message.getDate().toISOString(),
          sender: message.getFrom(), subject: intakeSubject_(message.getSubject(), result, index, results.length),
          originalText: intakePreviewText_(text, result, index, results.length),
          parsed: result.parsed, confidence: result.confidence, status: "pending"
        });
        if (!appended) { skipped += 1; return; }
        existingRefs[sourceRef] = true;
        added += 1;
        if (added >= 50) stop = true;
      });
    });
  });

  appendLog_("intake.email.scan", "intake", "batch", { query: query, added: added, skipped: skipped, warnings: warnings.length });
  return { added: added, skipped: skipped, warnings: warnings.slice(0, 10), scannedThreads: threads.length };
}

function ocrBlob_(blob) {
  var metadata = {
    name: "工程管理_OCR_" + new Date().getTime(),
    mimeType: "application/vnd.google-apps.document"
  };
  var file;
  try {
    file = Drive.Files.create(metadata, blob, { ocrLanguage: "ja", fields: "id" });
  } catch (error) {
    throw new Error("Drive OCRを開始できません。拡張サービスのDrive APIを有効にしてください。" + error.message);
  }

  try {
    var text = "";
    for (var attempt = 0; attempt < 4; attempt += 1) {
      try {
        text = DocumentApp.openById(file.id).getBody().getText();
        if (text) break;
      } catch (error) {
        if (attempt === 3) throw error;
      }
      Utilities.sleep(350);
    }
    if (!text.trim()) throw new Error("文字を検出できませんでした。明るい場所で正面から撮影した画像を使ってください。");
    return text.trim();
  } finally {
    try { Drive.Files.remove(file.id); } catch (ignore) { /* 一時OCR文書は次回手動削除可能 */ }
  }
}

function migrateLegacySheet(input) {
  ensureSystem_();
  var sheetName = sanitizeText_(input && input.sheetName, 200);
  if (!sheetName) throw new Error("読み込むシート名を入力してください。");
  if (Object.keys(APP.SHEETS).some(function(key) { return APP.SHEETS[key] === sheetName; })) throw new Error("アプリ管理用シートは移行元に指定できません。");

  var spreadsheet = getSpreadsheet_();
  var source = spreadsheet.getSheetByName(sheetName);
  if (!source) throw new Error("「" + sheetName + "」シートが見つかりません。");
  var values = source.getDataRange().getDisplayValues();
  if (!values.length) return { imported: 0, skipped: 0, sheetName: sheetName };

  var detection = detectLegacyHeaders_(values.slice(0, 6));
  if (detection.score < 3) throw new Error("見出しを判定できません。得意先・品名・納期などの見出しが上から6行以内にあるか確認してください。");
  var map = detection.map;
  if (map.customer === undefined || map.product === undefined) throw new Error("得意先と品名の列を特定できませんでした。");

  return withDocumentLock_(function() {
    var existingRefs = {};
    readJobs_().forEach(function(job) { existingRefs[job.sourceRef] = true; });
    var jobs = [];
    var skipped = 0;
    var now = new Date();
    for (var rowIndex = detection.row + 1; rowIndex < values.length; rowIndex += 1) {
      var row = values[rowIndex];
      var customer = cellAt_(row, map.customer);
      var product = cellAt_(row, map.product);
      if (!customer && !product) continue;
      var sourceRef = "legacy:" + sheetName + ":" + (rowIndex + 1);
      if (existingRefs[sourceRef]) { skipped += 1; continue; }
      var stageColumns = legacyStageColumns_(map);
      var stages = {};
      APP.STAGES.forEach(function(key, stageIndex) {
        stages[key] = { status: legacyStageStatus_(cellAt_(row, stageColumns[stageIndex])), assignee: "" };
      });
      var shippingText = cellAt_(row, map.shippingStatus);
      var shippingStatus = /済|完了|出荷済/.test(shippingText) ? "shipped" : /待/.test(shippingText) ? "waiting" : "not_ready";
      var inputJob = {
        customer: customer, product: product, dueDate: normalizeDate_(cellAt_(row, map.dueDate), now),
        quantity: parseQuantity_(cellAt_(row, map.quantity)), specLength: cellAt_(row, map.specLength),
        specShape: cellAt_(row, map.specShape), bladeWidth: cellAt_(row, map.bladeWidth),
        serialNo: cellAt_(row, map.serialNo), category: cellAt_(row, map.category), stages: stages, shippingStatus: shippingStatus,
        note: cellAt_(row, map.note), sourceType: "legacy", sourceRef: sourceRef, priority: "normal"
      };
      if (!inputJob.customer) inputJob.customer = "得意先未設定";
      if (!inputJob.product) inputJob.product = "品名未設定";
      var migratedJob = normalizeJobInput_(inputJob, null);
      migratedJob.completedAt = "";
      migratedJob.labelPrintStatus = "not_required";
      migratedJob.labelPrintedAt = "";
      jobs.push(migratedJob);
      existingRefs[sourceRef] = true;
    }

    if (jobs.length) {
      var target = spreadsheet.getSheetByName(APP.SHEETS.JOBS);
      target.getRange(target.getLastRow() + 1, 1, jobs.length, APP.JOB_HEADERS.length).setValues(jobs.map(jobToRow_));
      SpreadsheetApp.flush();
    }
    appendLog_("legacy.migrate", "sheet", sheetName, { imported: jobs.length, skipped: skipped, headerRow: detection.row + 1 });
    return { imported: jobs.length, skipped: skipped, sheetName: sheetName, headerRow: detection.row + 1 };
  });
}

function legacyStageColumns_(map) {
  var baseColumn = map.base === undefined ? (map.welding === undefined ? 9 : map.welding + 1) : map.base;
  return [
    map.welding === undefined ? baseColumn - 1 : map.welding,
    baseColumn,
    map.grinding === undefined ? baseColumn + 1 : map.grinding,
    map.heat === undefined ? baseColumn + 2 : map.heat,
    map.finish === undefined ? baseColumn + 3 : map.finish
  ];
}

function detectLegacyHeaders_(rows) {
  var aliases = legacyAliases_();
  var best = { row: 0, score: -1, map: {} };
  rows.forEach(function(row, rowIndex) {
    var map = {};
    row.forEach(function(value, columnIndex) {
      var normalized = normalizeHeader_(value);
      Object.keys(aliases).forEach(function(field) {
        if (map[field] !== undefined) return;
        if (aliases[field].some(function(alias) { return normalized === normalizeHeader_(alias) || normalized.indexOf(normalizeHeader_(alias)) >= 0; })) map[field] = columnIndex;
      });
    });
    var score = Object.keys(map).length;
    if (score > best.score) best = { row: rowIndex, score: score, map: map };
  });
  return best;
}

function legacyAliases_() {
  return {
    customer: ["得意先", "客先", "発注先", "顧客"], product: ["品名", "商品名", "製品名", "彫骨器"],
    dueDate: ["納期"], quantity: ["数量", "数"], specLength: ["全長"], specShape: ["型", "形状"],
    bladeWidth: ["刃幅", "刃巾"], serialNo: ["連番", "管理番号"], welding: ["溶接"],
    base: ["元作り", "元づくり", "元造り"], grinding: ["浮き止め～立ち上がり", "浮き止め〜立ち上がり", "すり上げ", "溶接すり上げ"],
    heat: ["厚みとり", "焼なとり", "焼なまし"], finish: ["仕上げ", "仕上"], note: ["備考"],
    shippingStatus: ["出荷状況", "出荷"], category: ["大分類", "分類", "製品分類"]
  };
}

function normalizeHeader_(value) {
  return String(value || "").replace(/[\s\n\r\t　・_\-]/g, "").toLowerCase();
}

function cellAt_(row, index) {
  return index === undefined ? "" : String(row[index] || "").trim();
}

function legacyStageStatus_(value) {
  var text = String(value || "").trim();
  return text ? "done" : "not_started";
}
