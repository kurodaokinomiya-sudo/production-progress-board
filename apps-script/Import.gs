function createIntakeFromImage(input) {
  requireEditorAccess_();
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
  requireEditorAccess_();
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
  requireEditorAccess_();
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
    requireEditorAccess_();
    var learningRules = typeof readIntakeLearningRules_ === "function" ? readIntakeLearningRules_() : [];
    var saved = parsedResults.map(function(parsedResult, index) {
      var itemNumber = parsedResult.itemNumber || index + 1;
      var multiItem = parsedResults.length > 1;
      var sourceRef = sourceType === "text"
        ? "paste:" + batchId + (multiItem ? ":item:" + itemNumber : "") + ":" + (fileName || "pasted-text")
        : "upload:" + batchId + (multiItem ? ":item:" + itemNumber : "") + ":" + fileName;
      // Each upload remains a separate review candidate. Keep available source
      // identities so approval can compare repeat uploads across routes.
      var parsed = parsedResult.parsed || {};
      if (!parsed.externalOrderNo && parsedResult.purchaseNo) parsed.externalOrderNo = sanitizeText_(parsedResult.purchaseNo, 240);
      if (!parsed.externalLineNo && parsedResult.purchaseNo && parsedResult.itemNumber) parsed.externalLineNo = String(parsedResult.itemNumber);
      if (typeof IntakeLearning !== "undefined") parsed = IntakeLearning.apply({ parsed: parsed, rules: learningRules }).parsed;
      return appendIntake_({
        sourceType: sourceType,
        sourceRef: sourceRef,
        receivedAt: receivedAt,
        sender: "",
        subject: intakeSubject_(fileName, parsedResult, index, parsedResults.length),
        originalText: intakePreviewText_(text, parsedResult, index, parsedResults.length),
        parsed: parsed,
        confidence: parsedResult.confidence,
        status: "pending"
      });
    });
    appendLog_("intake." + sourceType, "intake", "batch:" + batchId, { name: input.name, added: saved.length });
    return saved;
  });
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
  requireOwnerAccess_();
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

  withDocumentLock_(function() {
    requireOwnerAccess_();
    appendLog_("intake.email.scan", "intake", "batch", { query: query, added: added, skipped: skipped, warnings: warnings.length });
  });
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
  requireOwnerAccess_();
  input = input || {};
  var sheetName = sanitizeText_(input.sheetName, 200);
  if (!sheetName) throw new Error("読み込むシート名を入力してください。");
  if (Object.keys(APP.SHEETS).some(function(key) { return APP.SHEETS[key] === sheetName; })) throw new Error("アプリ管理用シートは移行元に指定できません。");
  var csvMode = Object.prototype.hasOwnProperty.call(input, "csvText");
  var dryRun = input.dryRun === true;
  var sourceIdentity = null;
  if (csvMode) {
    if (typeof input.csvText !== "string" || !input.csvText.trim()) throw new Error("読み込むCSVを指定してください。");
    if (input.csvText.length > 250000) throw new Error("CSVは250000文字以内にしてください。");
    sourceIdentity = legacyCsvSource_(input.sourceUrl);
    if (!dryRun && !input.expectedFingerprint) throw new Error("CSVを先にプレビューしてから取り込んでください。");
  }

  return withDocumentLock_(function() {
    requireOwnerAccess_();
    var spreadsheet = getSpreadsheet_();
    var values;
    if (csvMode) {
      try { values = Utilities.parseCsv(input.csvText.replace(/^\uFEFF/, "")); }
      catch (error) { throw new Error("CSVを読み取れません。CSV形式と引用符を確認してください。"); }
    } else {
      var source = spreadsheet.getSheetByName(sheetName);
      if (!source) throw new Error("「" + sheetName + "」シートが見つかりません。");
      values = source.getDataRange().getDisplayValues();
    }
    var existingJobs = readJobs_();
    var fingerprint = legacyImportFingerprint_({
      source: sourceIdentity, sheetName: sheetName, values: values,
      target: spreadsheet.getId(), existing: existingJobs.map(jobToRow_)
    });
    if (input.expectedFingerprint && String(input.expectedFingerprint) !== fingerprint) {
      throw new Error("プレビュー後に取込元または案件が変更されています。もう一度プレビューしてください。");
    }
    var detection = values.length ? detectLegacyHeaders_(values.slice(0, 6)) : { row: -1, score: 0, map: {} };
    var map = detection.map;
    if (values.length && detection.score < 3) throw new Error("見出しを判定できません。得意先・品名・納期などの見出しが上から6行以内にあるか確認してください。");
    if (values.length && (map.customer === undefined || map.product === undefined)) throw new Error("得意先と品名の列を特定できませんでした。");
    if (csvMode && APP.STAGES.some(function(key) { return map[key] === undefined; })) throw new Error("CSVに溶接・元作り・浮き止め～立ち上がり・厚みとり・仕上げの見出しが必要です。");
    var mappedHeaders = {};
    Object.keys(map).forEach(function(key) { mappedHeaders[key] = { column: map[key] + 1, header: String(values[detection.row][map[key]] || "") }; });
    var existingRefs = Object.create(null);
    var existingOrders = Object.create(null);
    existingJobs.forEach(function(job) {
      if (job.sourceRef) existingRefs[job.sourceRef] = true;
      if (!job.archived) existingOrders[legacyOrderKey_(job)] = true;
    });
    var seenSourceRows = Object.create(null);
    var jobs = [];
    var skipped = 0;
    var total = 0;
    var now = new Date();
    var stageColumns = csvMode ? APP.STAGES.map(function(key) { return map[key]; }) : legacyStageColumns_(map);
    for (var rowIndex = detection.row + 1; rowIndex < values.length; rowIndex += 1) {
      var row = values[rowIndex];
      var customer = cellAt_(row, map.customer);
      var product = cellAt_(row, map.product);
      if (legacyStructuralRow_(customer, product)) continue;
      total += 1;
      var sourceRow = rowIndex + 1;
      try {
        if (!customer || !product) throw new Error("得意先と品名の両方が必要です。");
        if (map.sourceRow !== undefined) {
          var sourceRowText = cellAt_(row, map.sourceRow);
          if (!/^[1-9]\d*$/.test(sourceRowText) || !Number.isSafeInteger(Number(sourceRowText))) throw new Error("元行番号は1以上の整数にしてください。");
          sourceRow = Number(sourceRowText);
        }
        if (seenSourceRows[sourceRow]) throw new Error("元行番号が重複しています。");
        seenSourceRows[sourceRow] = true;
        var sourceRef = csvMode
          ? "legacy:" + sourceIdentity.spreadsheetId + ":" + sourceIdentity.sheetId + ":" + sourceRow
          : "legacy:" + sheetName + ":" + sourceRow;
        var stages = {};
        APP.STAGES.forEach(function(key, stageIndex) {
          try { stages[key] = legacyStageInput_(cellAt_(row, stageColumns[stageIndex])); }
          catch (error) { throw new Error("工程「" + key + "」: " + error.message); }
        });
        var rawDate = cellAt_(row, map.dueDate);
        if (csvMode && rawDate && !isValidIsoDate_(rawDate)) throw new Error("CSVの納期はYYYY-MM-DD形式の正しい日付で指定してください。");
        var dueDate = normalizeDate_(rawDate, now);
        if (csvMode && rawDate && !dueDate) throw new Error("納期を正しい日付で指定してください。");
        var rawQuantity = cellAt_(row, map.quantity);
        if (csvMode && rawQuantity && !/^\d+(?:\.\d+)?$/.test(rawQuantity.normalize("NFKC").replace(/[,，]/g, ""))) throw new Error("数量は0以上の数値で指定してください。");
        var inputJob = {
          customer: customer, product: product, productCode: cellAt_(row, map.productCode), dueDate: dueDate,
          quantity: parseQuantity_(rawQuantity.normalize("NFKC")), specLength: cellAt_(row, map.specLength),
          specShape: cellAt_(row, map.specShape), bladeWidth: cellAt_(row, map.bladeWidth),
          serialNo: cellAt_(row, map.serialNo), category: cellAt_(row, map.category), stages: stages,
          shippingStatus: legacyShippingStatus_(cellAt_(row, map.shippingStatus)),
          note: cellAt_(row, map.note), sourceType: "legacy", sourceRef: sourceRef, priority: "normal"
        };
        var migratedJob = normalizeJobInput_(inputJob, null, { historicalImport: true });
        if (typeof prepareJobMaterials_ === "function" && typeof MaterialInventory !== "undefined") migratedJob.materials = prepareJobMaterials_(null, migratedJob, null, { baselineOnly: true });
        if (migratedJob.shippingStatus !== "shipped") migratedJob.completedAt = "";
        migratedJob.labelPrintStatus = "not_required";
        migratedJob.labelPrintedAt = "";
      } catch (error) {
        throw new Error("元表 " + sourceRow + "行目: " + error.message);
      }
      if (existingRefs[sourceRef] || existingOrders[legacyOrderKey_(migratedJob)]) { skipped += 1; continue; }
      jobs.push(migratedJob);
      existingRefs[sourceRef] = true;
    }
    var result = { imported: dryRun ? 0 : jobs.length, skipped: skipped, total: total, sheetName: sheetName,
      headerRow: detection.row + 1, fingerprint: fingerprint, mappedHeaders: mappedHeaders };
    if (dryRun) { result.jobs = jobs; return result; }
    ensureSystem_();
    if (jobs.length) {
      var target = spreadsheet.getSheetByName(APP.SHEETS.JOBS);
      target.getRange(target.getLastRow() + 1, 1, jobs.length, APP.JOB_HEADERS.length).setValues(sheetValues_(jobs.map(jobToRow_)));
      SpreadsheetApp.flush();
    }
    appendLog_("legacy.migrate", "sheet", sheetName, { imported: jobs.length, skipped: skipped, total: total, headerRow: detection.row + 1,
      sourceUrl: sourceIdentity ? sourceIdentity.url : "" });
    return result;
  });
}

function legacyCsvSource_(value) {
  var text = String(value || "").trim();
  var match = text.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)\/edit(?:\?[^#\s]*)?(?:#[^\s]*)?$/);
  var gids = text.match(/[?&#]gid=\d+(?=[&#]|$)/g) || [];
  if (!match || !gids.length) throw new Error("取込元のGoogleスプレッドシートURL（gid付き）を指定してください。");
  var sheetId = gids[0].replace(/^[?&#]gid=/, "");
  if (gids.some(function(gid) { return gid.replace(/^[?&#]gid=/, "") !== sheetId; })) throw new Error("取込元URLのgidが一致していません。");
  return { spreadsheetId: match[1], sheetId: sheetId, url: "https://docs.google.com/spreadsheets/d/" + match[1] + "/edit?gid=" + sheetId };
}

function legacyImportFingerprint_(value) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8);
  return digest.map(function(byte) { return ((byte + 256) % 256).toString(16).padStart(2, "0"); }).join("");
}

function legacyOrderKey_(job) {
  return JSON.stringify(["customer", "product", "productCode", "dueDate", "quantity", "specLength", "specShape", "bladeWidth", "serialNo", "category"]
    .map(function(key) { return String(job[key] === undefined || job[key] === null ? "" : job[key]).normalize("NFKC").trim(); }));
}

function legacyStructuralRow_(customer, product) {
  if (!customer && !product) return true;
  if (/^(?:得意先|客先|顧客)$/.test(customer) && /^(?:品名|製品名|商品名|彫骨器)$/.test(product)) return true;
  var labels = [customer, product].filter(function(value) { return value; });
  return labels.every(function(value) { return /^(?:合計|総合計|小計|計|備考|注意事項|凡例|以上)(?:\s*[:：]?\s*[\d,，]+\s*(?:丁|個|本)?)?$/.test(value); });
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
    [true, false].forEach(function(exact) {
      row.forEach(function(value, columnIndex) {
        var normalized = normalizeHeader_(value);
        Object.keys(aliases).forEach(function(field) {
          if (map[field] !== undefined) return;
          if (aliases[field].some(function(alias) {
            var expected = normalizeHeader_(alias);
            return exact ? normalized === expected : expected.length > 1 && normalized.indexOf(expected) >= 0;
          })) map[field] = columnIndex;
        });
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
    base: ["元作り", "元づくり", "元造り"], grinding: ["浮き止め～立ち上がり", "浮き止め〜立ち上がり", "浮き止め立上り", "浮き止め立ち上り", "立ち上り", "立上り", "すり上げ", "溶接すり上げ"],
    heat: ["厚みとり", "焼なとり", "焼なまし", "頭付け巾取り", "頭付け幅取り"], finish: ["仕上げ", "仕上"], note: ["備考"],
    shippingStatus: ["出荷状況", "出荷"], category: ["大分類", "分類", "製品分類"], productCode: ["品番", "製品番号"], sourceRow: ["元行番号"]
  };
}

function normalizeHeader_(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\n\r\t　・_\-～〜~]/g, "").toLowerCase();
}

function cellAt_(row, index) {
  return index === undefined || row[index] === undefined || row[index] === null ? "" : String(row[index]).trim();
}

function legacyStageStatus_(value) {
  return legacyStageInput_(value).status;
}

function legacyStageInput_(value) {
  var text = String(value || "").normalize("NFKC").replace(/[\s　・･:：()（）\[\]【】]/g, "");
  var statusOnly = {
    "": "not_started", "未着手": "not_started", "未開始": "not_started", "未": "not_started", "not_started": "not_started",
    "進行中": "working", "作業中": "working", "着手": "working", "研": "working", "working": "working",
    "済": "done", "完": "done", "完了": "done", "完成": "done", "done": "done", "○": "done", "〇": "done",
    "保留": "hold", "中止": "hold", "止": "hold", "待": "hold", "hold": "hold"
  };
  if (Object.prototype.hasOwnProperty.call(statusOnly, text)) return { status: statusOnly[text], assignee: "" };
  var assignee = APP.ASSIGNEES.find(function(name) { return text.indexOf(name) === 0; });
  if (assignee) {
    var suffix = text.slice(assignee.length);
    if (!suffix) return { status: "working", assignee: assignee };
    if (Object.prototype.hasOwnProperty.call(statusOnly, suffix)) return { status: statusOnly[suffix], assignee: assignee };
  }
  throw new Error("工程欄「" + String(value || "").slice(0, 80) + "」を判定できません。担当名・済・研・未着手・作業中・完了・保留を確認してください。");
}

function legacyShippingStatus_(value) {
  var text = String(value || "").normalize("NFKC").replace(/[\s　]/g, "");
  if (/^(?:済|完了|出荷済|出荷済み|出荷完了|shipped)$/.test(text)) return "shipped";
  if (/^(?:待|待ち|出荷待|出荷待ち|waiting)$/.test(text)) return "waiting";
  if (/^(?:保留|中止|止|hold)$/.test(text)) return "hold";
  if (/^(?:|未|未出荷|未完了|未着手|準備中|not_ready)$/.test(text)) return "not_ready";
  throw new Error("出荷状況「" + String(value || "").slice(0, 80) + "」を判定できません。");
}
