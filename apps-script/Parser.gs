function parseOrderText_(text, context) {
  context = context || {};
  var source = normalizeOrderText_(text);
  var result = {
    customer: extractLabeledValue_(source, ["得意先", "客先", "顧客名", "発注元", "注文元", "会社名"]),
    product: extractLabeledValue_(source, ["品名", "商品名", "製品名", "器具名", "注文品"]),
    dueDate: normalizeDate_(extractLabeledValue_(source, ["納期", "希望納期", "希望日", "出荷予定日", "納品日"])),
    quantity: parseQuantity_(extractLabeledValue_(source, ["数量", "注文数", "個数", "本数"])),
    serialNo: extractLabeledValue_(source, ["連番", "製造番号", "管理番号", "品番", "型番"]),
    specLength: extractLabeledValue_(source, ["全長", "長さ"]),
    specShape: extractLabeledValue_(source, ["型", "形状", "曲がり"]),
    bladeWidth: extractLabeledValue_(source, ["刃幅", "刃巾", "幅"]),
    note: extractLabeledValue_(source, ["備考", "特記事項", "注意事項"])
  };

  if (!result.customer && context.sender) result.customer = senderDisplayName_(context.sender);
  if (!result.product && context.subject) result.product = productFromSubject_(context.subject);
  separateImportedProductCode_(result);

  var inferred = inferSpecsFromProductName_(result.product, result);
  result.specLength = inferred.specLength;
  result.specShape = inferred.specShape;
  result.bladeWidth = inferred.bladeWidth;
  result.category = classifyProductCategory_(result.product);

  var confidence = calculateConfidence_(result);
  return { parsed: result, confidence: confidence };
}

/**
 * 1通・1ファイルに複数品目がある注文書は、品目ごとの確認候補へ分割する。
 * 判定できない形式は従来どおり1件として解析し、既存メール形式を壊さない。
 */
function parseOrderItems_(text, context) {
  var tableItems = parseTcPurchaseOrderItems_(text, context || {});
  if (tableItems.length) {
    assertCompleteTcPurchaseOrder_(text, tableItems);
    return tableItems;
  }
  return [parseOrderText_(text, context || {})];
}

/**
 * TC発注書は行番号が連続し、全品目に数量があることを成功条件にする。
 * OCRや古い解析処理が一部の行だけを返した場合、誤った候補を保存しない。
 */
function assertCompleteTcPurchaseOrder_(text, results) {
  var source = normalizeOrderText_(text);
  if (!/\bTC[_\-\s]*[0-9]{2}[_\-\s]*[0-9]{3,5}\b/i.test(source)) return;

  var actualNumbers = results.map(function(result, index) {
    return Number(result.itemNumber || index + 1);
  }).filter(function(value) { return isFinite(value) && value > 0; });
  var maximum = actualNumbers.length ? Math.max.apply(Math, actualNumbers) : 0;
  var missingNumbers = [];
  for (var itemNumber = 1; itemNumber <= maximum; itemNumber += 1) {
    if (actualNumbers.indexOf(itemNumber) < 0) missingNumbers.push(itemNumber);
  }
  var missingQuantities = results.filter(function(result) {
    var quantity = result && result.parsed ? result.parsed.quantity : "";
    return quantity === "" || quantity === null || quantity === undefined;
  }).map(function(result, index) {
    return Number(result.itemNumber || index + 1);
  });

  if (!missingNumbers.length && !missingQuantities.length) return;
  var details = [];
  if (missingNumbers.length) details.push("欠落した品目番号: " + missingNumbers.join(", "));
  if (missingQuantities.length) details.push("数量未読取: 品目" + missingQuantities.join(", "));
  throw new Error("TC発注書の読取結果が不完全です（" + details.join(" / ") + "）。不完全な候補は保存していません。PDFを再読取してください。");
}

function purchaseOrderCustomer_(source, context) {
  if (/田中医科器械製作所/.test(source)) return "田中";
  var issuer = source.match(/発注致します[。.]?\s*((?:株式会社|有限会社|合同会社)[^\n]{2,80})/);
  if (issuer) return issuer[1].replace(/\s*(?:〒|TEL|電話).*$/, "").trim();
  return context && context.sender ? senderDisplayName_(context.sender) : "";
}

/** Separate only a leading catalogue-code token; keep model numbers inside the name. */
function splitLeadingProductCode_(value) {
  var text = String(value || "").trim();
  var match = text.match(/^([A-ZＡ-Ｚ]?[0-9０-９]{2}(?:[-－‐‑–−][A-ZＡ-Ｚ0-9０-９]+){1,4})[\s\u3000]+([\s\S]+)$/i);
  // A leading size range is part of the product description, not a catalogue code.
  if (!match || /^(?:mm|cm|㎜|㎝|ミリ|センチ)(?:\b|\s|[\u3040-\u9fff])/i.test(match[2])) return { product: text, catalogCode: "" };
  return { product: match[2].trim(), catalogCode: match[1].normalize("NFKC").replace(/[‐‑–−]/g, "-") };
}

function separateImportedProductCode_(parsed) {
  var split = splitLeadingProductCode_(parsed.product);
  parsed.product = split.product;
  if (split.catalogCode && String(parsed.note || "").indexOf(split.catalogCode) < 0) {
    parsed.note = [parsed.note, "品番: " + split.catalogCode].filter(Boolean).join(" / ");
  }
  return parsed;
}

function splitTcProductLine_(value) {
  var text = normalizeOrderText_(value).replace(/\n/g, " ")
    .replace(/-\s+([A-Z])$/i, "-$1")
    .replace(/\s+/g, " ")
    .trim();
  var split = splitLeadingProductCode_(text);
  var catalogCode = split.catalogCode;
  var product = split.product;
  var inlineNote = "";
  var noteIndex = product.indexOf("※");
  if (noteIndex >= 0) {
    inlineNote = product.slice(noteIndex + 1).trim();
    product = product.slice(0, noteIndex).trim();
  }
  product = product.replace(/\s*([<>/:])\s*/g, "$1").replace(/\s+/g, " ").trim();
  var notes = [];
  if (catalogCode) notes.push("品番: " + catalogCode);
  if (inlineNote) notes.push(inlineNote);
  return { product: product, catalogCode: catalogCode, note: notes.join(" / ") };
}

function splitTcRowColumns_(value) {
  var text = normalizeOrderText_(value).replace(/\n/g, " ").trim();
  var inline = text.match(/^(.*?)(20\d{2}[-\/]\d{1,2}[-\/]\d{1,2})\s+(\d+(?:[.,]\d+)?)\s*(?:個|本|丁|組|セット)(?:\s|$)/);
  if (!inline) return { product: text, dueDate: "", quantity: "" };
  return {
    product: inline[1].trim(),
    dueDate: normalizeDate_(inline[2]),
    quantity: parseQuantity_(inline[3])
  };
}

/**
 * 田中医科のTC発注書を解析する。
 * PDF→Google Docs変換では品目、納期、数量が列ごとの塊になるため、行番号を基準に再結合する。
 */
function parseTcPurchaseOrderItems_(text, context) {
  var source = normalizeOrderText_(text);
  var purchaseNo = source.match(/\bTC[_\-\s]*([0-9]{2})[_\-\s]*([0-9]{3,5})\b/i);
  if (!purchaseNo) return [];

  var lines = source.split("\n").map(function(line) { return line.trim(); });
  var rows = [];
  var current = null;
  var firstRowIndex = -1;
  var tableEndIndex = -1;

  for (var lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    var line = lines[lineIndex];
    var rowMatch = line.match(/^(\d{1,2})\s*[_＿]\s*(.{4,})$/);
    if (rowMatch) {
      var rowNumber = Number(rowMatch[1]);
      if (!rows.length || rowNumber > rows[rows.length - 1].number) {
        var rowColumns = splitTcRowColumns_(rowMatch[2]);
        current = {
          number: rowNumber,
          rawProduct: rowColumns.product,
          dueDate: rowColumns.dueDate,
          quantity: rowColumns.quantity
        };
        rows.push(current);
        if (firstRowIndex < 0) firstRowIndex = lineIndex;
        if (rowColumns.dueDate && rowColumns.quantity !== "") current = null;
        continue;
      }
    }
    if (!current) continue;
    if (/^20\d{2}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(line)) {
      tableEndIndex = lineIndex;
      break;
    }
    if (!line) continue;
    if (/^(?:希望納期|数量|単位|単価|金額|備考|※納品書|発注書受領後|Powered by)/.test(line)) {
      current = null;
      continue;
    }
    current.rawProduct += /[-/:]$/.test(current.rawProduct) ? line : " " + line;
  }

  if (!rows.length) return [];
  if (tableEndIndex < 0) tableEndIndex = lines.length;

  var dueDates = [];
  var quantities = [];
  var quantityStartIndex = tableEndIndex;
  for (var dueIndex = tableEndIndex; dueIndex < lines.length && dueDates.length < rows.length; dueIndex += 1) {
    if (!/^20\d{2}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(lines[dueIndex])) continue;
    dueDates.push(normalizeDate_(lines[dueIndex]));
    quantityStartIndex = dueIndex + 1;
  }
  for (var quantityIndex = quantityStartIndex; quantityIndex < lines.length && quantities.length < rows.length; quantityIndex += 1) {
    if (!/^\d+(?:[.,]\d+)?$/.test(lines[quantityIndex])) continue;
    quantities.push(parseQuantity_(lines[quantityIndex]));
  }

  var headerDates = source.slice(0, source.indexOf(lines[firstRowIndex])).match(/20\d{2}[-\/]\d{1,2}[-\/]\d{1,2}/g) || [];
  var fallbackDueDate = headerDates.length ? normalizeDate_(headerDates[headerDates.length - 1]) : "";
  var customer = purchaseOrderCustomer_(source, context || {});
  var serialBase = purchaseNo[1] + "-" + purchaseNo[2];

  return rows.map(function(row, rowIndex) {
    var productLine = splitTcProductLine_(row.rawProduct);
    var parsed = {
      customer: customer,
      product: productLine.product,
      dueDate: row.dueDate || dueDates[rowIndex] || fallbackDueDate,
      quantity: row.quantity !== "" ? row.quantity : (quantities[rowIndex] === undefined ? "" : quantities[rowIndex]),
      serialNo: serialBase + "-" + row.number,
      specLength: "",
      specShape: "",
      bladeWidth: "",
      note: productLine.note
    };
    var inferred = inferSpecsFromProductName_(parsed.product, parsed);
    parsed.specLength = inferred.specLength;
    parsed.specShape = inferred.specShape;
    parsed.bladeWidth = inferred.bladeWidth;
    parsed.category = classifyProductCategory_(parsed.product);
    return {
      parsed: parsed,
      confidence: calculateConfidence_(parsed),
      itemNumber: row.number,
      purchaseNo: "TC_" + purchaseNo[1] + "_" + purchaseNo[2]
    };
  });
}

function normalizeOrderText_(text) {
  var normalized = String(text || "");
  try { normalized = normalized.normalize("NFKC"); } catch (ignore) { /* Apps Script旧環境では従来表記のまま続行 */ }
  return normalized
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLabeledValue_(text, labels) {
  var labelPattern = labels.map(escapeRegExp_).join("|");
  var linePattern = new RegExp("(?:^|\\n)\\s*(?:" + labelPattern + ")\\s*[:：]?\\s*([^\\n]{1,160})", "i");
  var match = text.match(linePattern);
  if (!match) {
    var inlinePattern = new RegExp("(?:" + labelPattern + ")\\s*[:：]\\s*([^\\n、,;；]{1,120})", "i");
    match = text.match(inlinePattern);
  }
  if (!match) return "";
  return match[1].replace(/\s*(?:よろしく|以上|です|となります)[。.]?$/i, "").trim();
}

function parseQuantity_(value) {
  if (!value) return "";
  var match = String(value).replace(/[,，]/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : "";
}

function normalizeDate_(value, now) {
  if (!value) return "";
  var text = String(value).trim().replace(/[（(].*?[）)]/g, "");
  var reference = now || new Date();
  var year;
  var month;
  var day;
  var full = text.match(/(20\d{2})\s*[年\/-]\s*(\d{1,2})\s*[月\/-]\s*(\d{1,2})\s*日?/);
  if (full) {
    year = Number(full[1]); month = Number(full[2]); day = Number(full[3]);
  } else {
    var short = text.match(/(\d{1,2})\s*[月\/]\s*(\d{1,2})\s*日?/);
    if (!short) return "";
    year = reference.getFullYear(); month = Number(short[1]); day = Number(short[2]);
    var candidate = new Date(year, month - 1, day);
    var ninetyDaysAgo = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - 90);
    if (candidate < ninetyDaysAgo) year += 1;
  }
  var date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return [year, String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
}

function senderDisplayName_(sender) {
  var text = String(sender || "").trim();
  var angle = text.match(/^\s*"?([^"<]+?)"?\s*</);
  if (angle && angle[1].trim()) return angle[1].trim().slice(0, 160);
  return "";
}

function productFromSubject_(subject) {
  var value = String(subject || "")
    .replace(/[\[【].*?[\]】]/g, " ")
    .replace(/^(?:Re|Fwd|Fw)\s*:\s*/i, "")
    .replace(/(?:ご?注文|発注|製作依頼|見積依頼|依頼|の件)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value.length >= 2 && value.length <= 120 ? value : "";
}

/**
 * 製品名に含まれる分類語を、画面や注文書の表記揺れを吸収して大分類へ変換する。
 * ケリソン系の語は「鉗子」より先に判定する（例: ケリソン鉗子）。
 */
function classifyProductCategory_(product) {
  var text = normalizeOrderText_(product).replace(/[\s　]+/g, "");
  if (/ケリソン|ケリパンチ|スタンツェ|スタンチェ|スタンツエ|スタッツェ|彫骨器/.test(text)) return "ケリソンパンチ";
  if (/鉗子/.test(text)) return "鋭匙鉗子";
  return "";
}

function normalizeCategory_(value, product, rejectInvalid) {
  var text = String(value || "").trim();
  if (text === "鋭匙鉗子" || text === "ケリソンパンチ") return text;
  if (!text) return classifyProductCategory_(product);
  if (rejectInvalid) throw new Error("大分類の値が不正です。鋭匙鉗子またはケリソンパンチを選択してください。");
  return "";
}

function normalizeMeasurementNumber_(value) {
  return String(value || "")
    .replace(/[０-９]/g, function(character) { return String.fromCharCode(character.charCodeAt(0) - 0xfee0); })
    .replace(/[．。]/g, ".")
    .replace(/[，,]/g, "")
    .trim();
}

function formatMeasurement_(number, unit) {
  var normalizedNumber = normalizeMeasurementNumber_(number);
  var normalizedUnit = String(unit || "").replace(/\s+/g, "").toLowerCase();
  if (normalizedUnit === "センチ") normalizedUnit = "cm";
  if (normalizedUnit === "ミリ") normalizedUnit = "mm";
  return normalizedNumber + normalizedUnit;
}

function labeledMeasurement_(text, labels) {
  var labelPattern = labels.map(escapeRegExp_).join("|");
  var pattern = new RegExp("(?:" + labelPattern + ")\\s*[:：]?\\s*(\\d+(?:[．.]\\d+)?)(?:\\s*(cm|mm|センチ|ミリ))?", "i");
  var match = pattern.exec(text);
  if (!match) return null;
  return {
    value: formatMeasurement_(match[1], match[2]),
    index: match.index,
    end: match.index + match[0].length
  };
}

function inferShapeFromProductName_(text) {
  var compact = String(text || "").replace(/\s+/g, "");
  var jawMatch = compact.match(/[<〈]([^<>〈〉]{1,20}爪)[>〉]/);
  if (jawMatch) return jawMatch[1];
  if (/上向(?:き)?左(?:カーブ|曲)/.test(compact)) return "上曲左";
  if (/上向(?:き)?右(?:カーブ|曲)/.test(compact)) return "上曲右";
  if (/下向(?:き)?左(?:カーブ|曲)/.test(compact)) return "下曲左";
  if (/下向(?:き)?右(?:カーブ|曲)/.test(compact)) return "下曲右";
  var candidates = [
    "斜刃上向", "斜刃下向", "直上向", "直下向", "上曲左", "上曲右", "下曲左", "下曲右",
    "強弯", "弱弯", "強湾", "弱湾", "強彎", "弱彎", "上曲", "下曲", "上向", "下向", "左", "右", "直"
  ];
  for (var index = 0; index < candidates.length; index += 1) {
    if (text.indexOf(candidates[index]) >= 0) return candidates[index].replace(/[湾彎]/g, "弯");
  }
  return "";
}

/**
 * 製品名の寸法は、明示ラベル値を優先したうえで補完する。
 * 単独の mm は 20mm 以下なら刃幅、20mm を超える場合は全長候補とし、
 * 「全長120mm」の数値を刃幅として誤採用しない。
 */
function inferSpecsFromProductName_(product, fields) {
  fields = fields || {};
  var result = {
    specLength: String(fields.specLength || "").trim(),
    specShape: String(fields.specShape || "").trim(),
    bladeWidth: String(fields.bladeWidth || "").trim()
  };
  var text = normalizeOrderText_(product).replace(/[０-９]/g, function(character) {
    return String.fromCharCode(character.charCodeAt(0) - 0xfee0);
  }).replace(/[．。]/g, ".")
    .replace(/[ｃＣ]/g, "c")
    .replace(/[ｍＭ]/g, "m");
  if (!text) return result;

  var labeledLength = labeledMeasurement_(text, ["全長", "長さ"]);
  var labeledBlade = labeledMeasurement_(text, ["刃幅", "刃巾", "刃の幅"]);
  if (!result.specLength && labeledLength) result.specLength = labeledLength.value;
  if (!result.bladeWidth && labeledBlade) result.bladeWidth = labeledBlade.value;
  if (!result.specShape) result.specShape = inferShapeFromProductName_(text);

  var cmMatch = /(\d+(?:[.]\d+)?)\s*(cm|センチ)/i.exec(text);
  if (!result.specLength && cmMatch) result.specLength = formatMeasurement_(cmMatch[1], cmMatch[2]);

  var mmPattern = /(\d+(?:[.]\d+)?)\s*(mm|ミリ)/ig;
  var mmCandidates = [];
  var mmMatch;
  while ((mmMatch = mmPattern.exec(text)) !== null) {
    var mmNumber = Number(normalizeMeasurementNumber_(mmMatch[1]));
    if (!isFinite(mmNumber)) continue;
    if (labeledLength && mmMatch.index >= labeledLength.index && mmMatch.index < labeledLength.end) continue;
    if (labeledBlade && mmMatch.index >= labeledBlade.index && mmMatch.index < labeledBlade.end) {
      if (!result.bladeWidth) result.bladeWidth = formatMeasurement_(mmMatch[1], mmMatch[2]);
      continue;
    }
    mmCandidates.push({ number: mmNumber, value: formatMeasurement_(mmMatch[1], mmMatch[2]) });
  }

  if (!result.specLength) {
    var longMm = mmCandidates.find(function(candidate) { return candidate.number >= 50; });
    if (longMm) result.specLength = longMm.value;
  }
  if (!result.bladeWidth) {
    var widthMm = mmCandidates.find(function(candidate) { return candidate.number > 0 && candidate.number <= 20; });
    if (widthMm) result.bladeWidth = widthMm.value;
  }
  return result;
}

function calculateConfidence_(parsed) {
  var weights = { customer: 0.25, product: 0.30, dueDate: 0.15, quantity: 0.10, serialNo: 0.10, specLength: 0.025, specShape: 0.025, bladeWidth: 0.025, note: 0.025 };
  var score = Object.keys(weights).reduce(function(total, key) {
    return total + (parsed[key] !== "" && parsed[key] !== null && parsed[key] !== undefined ? weights[key] : 0);
  }, 0);
  return Math.round(score * 100) / 100;
}
