var CASTING_SOURCE_ID_ = "1hhiDA50fupxBHHPL6UnEePRYlMO70Z7tvxE7GVKoCCg";
var CASTING_SOURCE_SHEET_ID_ = 741309899;
var CASTING_SOURCE_LOCATIONS_ = ["1F", "2F", "保土田"];

// These two entries were confirmed as outstanding. Their source memos must
// still match when the owner starts inventory in HAKOBI.
var CASTING_SOURCE_OPENING_ORDERS_ = [
  { id: "legacy-hernia-lever-20261013", partId: "hernia-lever", quantity: 500 },
  { id: "legacy-m1-lever-20261013", partId: "m1-lever", quantity: 300 }
];

// Match the legacy names explicitly where the prototype defines a processing
// variant or a reorder point. The prototype supplies no opening quantities.
var CASTING_SOURCE_CATALOG_ = [
  { id: "tm-stanche", name: "TMスタンチェ", aliases: ["TMスタンツェ"], raw: 100, processed: 5 },
  { id: "tm-stanche-lever", name: "TMスタンチェレバー", aliases: ["TMスタンツェ レバー"], raw: 100, processed: 5 },
  { id: "hernia", name: "ヘルニア", raw: 150, processed: 5 },
  { id: "hernia-lever", name: "ヘルニアレバー", raw: 150, processed: 5 },
  { id: "stepped-hernia", name: "段付きヘルニア", raw: 100, processed: 5 },
  { id: "stepped-hernia-lever", name: "段付きヘルニアレバー", raw: 100, processed: 5 },
  { id: "bent-lever", name: "くの字レバー", raw: 100, processed: 5 },
  { id: "long", name: "長型", raw: 100, processed: 5 },
  { id: "long-lever", name: "長型レバー", raw: 100, processed: 5 },
  { id: "m1-lever", name: "M1レバー", raw: 100, processed: 5 },
  { id: "m2-lever", name: "M2レバー", raw: 100, processed: 5 },
  { id: "stepped-kerrison", name: "段付きケリソン", raw: 150, processed: 5 },
  { id: "ring-lever", name: "輪付きレバー", aliases: ["輪レバー"], raw: 100, processed: 5 },
  { id: "cottonman", name: "コットマン", raw: 150, processed: 5, colored: 5 },
  { id: "nishihata-king", name: "西ハタ（キングパーツ）", searchAliases: ["西端"], single: 50, asIs: true },
  { id: "nishihata-lever-king", name: "西ハタレバー（キングパーツ）", searchAliases: ["西端レバー"], single: 50, asIs: true },
  { id: "nishihata-niigata", name: "西ハタ（新潟精密）", searchAliases: ["西端"], single: null, asIs: true },
  { id: "nishihata-lever-niigata", name: "西ハタレバー（新潟精密）", searchAliases: ["西端レバー"], single: null, asIs: true },
  { id: "maeda-lever", name: "前田式レバー", single: 50, asIs: true, needsOpeningCount: true },
  { id: "gruewald", name: "グリワルト", raw: 100, processed: 5 },
  { id: "gruewald-lever", name: "グリワルトレバー", single: 50, asIs: true },
  { id: "small-forceps", name: "小小鉗子", raw: 100, processed: 5 },
  { id: "small-forceps-lever", name: "小小鉗子レバー", single: 50, asIs: true },
  { id: "meniscus-lever", name: "メニスカスレバー", single: 50, asIs: true },
  { id: "meniscus-ratchet", name: "メニスカスラチェット", single: 50, asIs: true },
  { id: "meniscus-base", name: "メニスカス台座", single: 10, asIs: true },
  { id: "double-force-lever", name: "倍力レバー", raw: 50, processed: 50 },
  { id: "double-force-frame", name: "倍力フレーム", raw: 50, processed: 5 },
  { id: "push-link", name: "プッシュリンク", single: 10, asIs: true },
  { id: "link-nut", name: "リンクナッツ", single: 10, asIs: true }
];

function readCastingInventorySource_() {
  var tabs;
  try {
    tabs = SpreadsheetApp.openById(CASTING_SOURCE_ID_).getSheets();
  } catch (error) {
    throw new Error("現行の鋳物在庫表を開けません。スプレッドシートのアクセス権を確認してください。");
  }
  var summary = tabs.find(function(tab) { return tab.getSheetId() === CASTING_SOURCE_SHEET_ID_; });
  var lastRow = summary ? summary.getLastRow() : 0;
  if (!summary || summary.getName() !== "総合在庫数" || lastRow < 3) {
    throw new Error("現行の鋳物在庫表に「総合在庫数」のデータが見つかりません。");
  }
  var range = summary.getRange(2, 1, lastRow - 1, 8);
  var values = range.getValues();
  var expectedHeaders = CASTING_SOURCE_LOCATIONS_.concat("合計");
  if (!expectedHeaders.every(function(header, index) { return castingSourceKey_(values[0][index + 2]) === header; })) {
    throw new Error("現行の鋳物在庫表の列見出しを確認してください。C〜F列に1F・2F・保土田・合計が必要です。");
  }
  var displayed = range.getDisplayValues();
  var formulas = range.getFormulas();
  var groups = new Map();
  var tabIds = new Map(tabs.map(function(tab) { return [tab.getName(), tab.getSheetId()]; }));
  var catalog = new Map();
  CASTING_SOURCE_CATALOG_.forEach(function(item) {
    [item.name].concat(item.aliases || []).forEach(function(name) { catalog.set(castingSourceKey_(name), item); });
  });

  values.slice(1).forEach(function(row, index) {
    var rowNumber = index + 3;
    if (typeof row[1] !== "string" || /^#(REF!|VALUE!|N\/A|NAME\?|NUM!|ERROR!|DIV\/0!|NULL!)$/.test(row[1])) {
      throw new Error("総合在庫数の" + rowNumber + "行目の品名を確認してください。");
    }
    var original = row[1].trim();
    var notes = displayed[index + 1].slice(6, 8).map(function(note) { return note.trim(); }).filter(Boolean);
    if (!original) {
      if (notes.length || !castingSourceAbsent_(row[0]) || row.slice(2, 6).some(function(value) { return !castingSourceAbsent_(value) && value !== 0; })) {
        throw new Error("総合在庫数の" + rowNumber + "行目に品名がありません。現行表を確認してください。");
      }
      return;
    }
    var specified = original.match(/^(.*?)\s*([0-9０-９,，]+)\s*以下で発注$/);
    var originalName = specified ? specified[1].trim() : original;
    var key = castingSourceKey_(originalName);
    var isColored = key === "色しっぽコットマン";
    var definition = catalog.get(isColored ? "コットマン" : key) || {
      id: "legacy-" + castingSourceDigest_(key), name: originalName, single: null
    };
    var quantities = CASTING_SOURCE_LOCATIONS_.map(function(location, locationIndex) {
      var value = row[locationIndex + 2];
      return castingSourceAbsent_(value) ? 0 : castingSourceNumber_(value, rowNumber, location, true);
    });
    var total = castingSourceNumber_(row[5], rowNumber, "合計", true);
    if (quantities.reduce(function(sum, count) { return sum + count; }, 0) !== total) {
      throw new Error("総合在庫数の" + rowNumber + "行目「" + original + "」は保管場所別の数量と合計が一致しません。");
    }
    if (total === 0 && notes.length === 1 && notes[0] === "削除") return;
    var unitPrice = castingSourceAbsent_(row[0]) ? null : castingSourceNumber_(row[0], rowNumber, "単価", false);
    var threshold = specified ? castingSourceNumber_(specified[2], rowNumber, "発注点", true) : null;
    var phase = isColored ? "colored" : definition.raw === undefined ? "single" : "paired";
    var legacyUrl = castingSourceRowUrl_(formulas[index + 1], tabIds);
    var group = groups.get(definition.id);
    if (!group) {
      group = { definition: definition, rows: new Map() };
      groups.set(definition.id, group);
    }
    if (group.rows.has(phase)) {
      throw new Error("総合在庫数の" + rowNumber + "行目「" + original + "」は品目が重複しています。現行表を確認してください。");
    }
    group.rows.set(phase, { phase: phase, original: original, originalName: originalName, quantities: quantities, total: total, notes: notes, unitPrice: unitPrice, threshold: threshold, legacyUrl: legacyUrl });
  });

  if (!groups.size) throw new Error("現行の鋳物在庫表に引き継げる品目がありません。");
  CASTING_SOURCE_CATALOG_.forEach(function(definition) {
    if (definition.needsOpeningCount && !groups.has(definition.id)) {
      groups.set(definition.id, { definition: definition, rows: new Map() });
    }
  });
  var sourceUrl = castingSourceUrl_(CASTING_SOURCE_SHEET_ID_);
  var stock = [];
  var items = Array.from(groups.keys()).sort().map(function(id) {
    var group = groups.get(id);
    var definition = group.definition;
    var rows = Array.from(group.rows.keys()).sort().map(function(phase) { return group.rows.get(phase); });
    var main = group.rows.get("paired") || group.rows.get("single");
    var colored = group.rows.get("colored");
    var primary = main || colored;
    var threshold = main ? main.threshold : null;
    var variants = definition.raw === undefined
      ? [{ id: "single", label: definition.asIs ? "未加工のまま使用" : "区分なし", threshold: threshold == null ? definition.single : threshold }]
      : [
        { id: "raw", label: "未加工", threshold: threshold == null ? definition.raw : threshold },
        { id: "processed", label: definition.colored === undefined ? "加工済" : "加工済（通常）", threshold: definition.processed },
        { id: "unclassified", label: "区分未確認", threshold: null }
      ];
    if (definition.colored !== undefined) {
      variants.splice(2, 0, { id: "colored", label: "加工済（色しっぽ）", threshold: colored && colored.threshold != null ? colored.threshold : definition.colored });
    }
    if (!Number.isSafeInteger(rows.reduce(function(sum, row) { return sum + row.total; }, 0))) {
      throw new Error("現行表の「" + definition.name + "」の合計在庫が大きすぎます。");
    }
    var aliases = new Set((definition.aliases || []).concat(definition.searchAliases || []));
    var notes = [];
    rows.forEach(function(row) {
      aliases.add(row.original);
      aliases.add(row.originalName);
      row.quantities.forEach(function(quantity, index) {
        if (quantity === 0) return;
        var location = CASTING_SOURCE_LOCATIONS_[index];
        var variant = row.phase === "paired" ? castingOpeningVariant_(location) : row.phase;
        stock.push({ partId: id, variant: variant, location: location, quantity: quantity });
      });
      if (row !== primary && row.unitPrice != null) notes.push(row.originalName + "の単価 " + row.unitPrice + "円");
      if (row.notes.length) notes.push((row === primary ? "" : row.originalName + " ") + row.notes.join(" ／ "));
    });
    aliases.delete(definition.name);
    var item = { id: id, name: definition.name, aliases: Array.from(aliases).sort(), note: notes.join(" ／ "), unitPrice: primary ? primary.unitPrice : null, legacyUrl: primary ? primary.legacyUrl : sourceUrl, variants: variants };
    if (!primary) item.openingUnconfirmed = true;
    return item;
  });
  var openingOrders = CASTING_SOURCE_OPENING_ORDERS_.flatMap(function(order) {
    var group = groups.get(order.partId);
    var row = group && group.rows.get("paired");
    var expectedOrderMemo = "10/13" + order.quantity + "個発注";
    if (!row || row.notes.length !== 2 || castingSourceKey_(row.notes[0]) !== expectedOrderMemo || castingSourceKey_(row.notes[1]) !== "12/24入荷") return [];
    return [{ id: order.id, partId: order.partId, variant: "raw", quantity: order.quantity, date: "2026-10-13", dueDate: "2026-12-24", note: row.notes.join(" ／ ") }];
  });
  var snapshot = { sourceUrl: sourceUrl, items: items, stock: stock, openingOrders: openingOrders };
  snapshot.sourceRevision = castingSourceDigest_(JSON.stringify(snapshot));
  return snapshot;
}

function castingOpeningVariant_(location) {
  return location === "1F" ? "raw" : "processed";
}

function castingSourceKey_(value) {
  return String(value == null ? "" : value).normalize("NFKC").replace(/\s+/g, "");
}

function castingSourceAbsent_(value) {
  return value == null || (typeof value === "string" && ["", "-"].includes(castingSourceKey_(value)));
}

function castingSourceNumber_(value, rowNumber, label, integer) {
  var number = value;
  if (typeof value === "string") {
    var normalized = value.normalize("NFKC").trim();
    if (!integer) normalized = normalized.replace(/^¥\s*/, "");
    var decimal = integer ? "(?:\\.0+)?" : "(?:\\.\\d+)?";
    if (new RegExp("^(?:\\d+|\\d{1,3}(?:,\\d{3})+)" + decimal + "$").test(normalized)) number = Number(normalized.replace(/,/g, ""));
  }
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(number))) {
    throw new Error("総合在庫数の" + rowNumber + "行目の" + label + "を数値で確認してください。");
  }
  return number;
}

function castingSourceRowUrl_(formulas, tabIds) {
  var linked = new Set();
  formulas.slice(2, 5).forEach(function(formula) {
    var match = formula.match(/^=\s*(?:'((?:[^']|'')+)'|([^'!]+))!\$?[A-Z]+\$?\d+\s*$/i);
    if (!match) return;
    var name = match[1] ? match[1].replace(/''/g, "'") : match[2].trim();
    if (tabIds.has(name)) linked.add(tabIds.get(name));
  });
  return castingSourceUrl_(linked.size === 1 ? linked.values().next().value : CASTING_SOURCE_SHEET_ID_);
}

function castingSourceUrl_(gid) {
  return "https://docs.google.com/spreadsheets/d/" + CASTING_SOURCE_ID_ + "/edit?gid=" + gid + "#gid=" + gid;
}

function castingSourceDigest_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}
