import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../apps-script/CastingStockSource.gs", import.meta.url), "utf8");
const header = ["", "", "1F", "2F", "保土田", "合計", "", ""];
const legacyId = "1hhiDA50fupxBHHPL6UnEePRYlMO70Z7tvxE7GVKoCCg";

function readSource(data, { formulas = [], headings = header, id = 741309899, name = "総合在庫数" } = {}) {
  const rows = [headings, ...data];
  const summary = {
    getSheetId: () => id,
    getName: () => name,
    getLastRow: () => rows.length + 1,
    getRange(...args) {
      assert.deepEqual(args, [2, 1, rows.length, 8]);
      return {
        getValues: () => rows,
        getDisplayValues: () => rows.map((row) => row.map(String)),
        getFormulas: () => rows.map((row, index) => formulas[index - 1] ?? row.map(() => "")),
      };
    },
  };
  const tab = (title, gid) => ({ getSheetId: () => gid, getName: () => title });
  const context = vm.createContext({
    SpreadsheetApp: { openById(value) {
      assert.equal(value, legacyId);
      return { getSheets: () => [tab("総合在庫数", 72), summary, tab("ヘルニア", 773), tab("色しっぽコットマン", 774)] };
    } },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (algorithm, value, encoding) => createHash(algorithm).update(value, encoding).digest(),
      base64EncodeWebSafe: (bytes) => bytes.toString("base64url"),
    },
  });
  return JSON.parse(JSON.stringify(vm.runInContext(`${source}\nreadCastingInventorySource_();`, context)));
}

test("imports 1F as raw and 2F and Hodota as processed while retaining the source counts", () => {
  const result = readSource([
    [1575, "ヘルニア　１８０以下で発注", 210, 11, 40, 261, "発注メモ", "入荷予定"],
    ["￥1,214", "コットマン", 251, "", 15, 266, "", ""],
    ["", "色しっぽコットマン", "-", "-", 21, 21, "", ""],
    ["", "西ハタ （キングパーツ）", 67, "-", 2, 69, "", ""],
    ["", "西ハタ(新潟精密）", 78, "-", 4, 82, "", ""],
    ["", "", "", "", "", 0, "", ""],
    [171, "旧部材A", "", 1, 0, 1, "削除", ""],
    [532, "旧部材B", 0, "-", "", 0, "削除", ""],
  ], { formulas: [["", "", "='ヘルニア'!$D$18", "", "='ヘルニア'!I18", "=SUM(C3:E3)", "", ""]] });
  const hernia = result.items.find((item) => item.id === "hernia");
  const cottonman = result.items.find((item) => item.id === "cottonman");
  const maeda = result.items.find((item) => item.id === "maeda-lever");
  const king = result.items.find((item) => item.id === "nishihata-king");
  const niigata = result.items.find((item) => item.id === "nishihata-niigata");
  assert.match(result.sourceUrl, /#gid=741309899$/);
  assert.match(hernia.legacyUrl, /#gid=773$/);
  assert.match(cottonman.legacyUrl, /#gid=741309899$/);
  assert.equal(hernia.note, "発注メモ ／ 入荷予定");
  assert.equal(hernia.variants.find((variant) => variant.id === "raw").threshold, 180);
  assert.equal(hernia.unitPrice, 1575);
  assert.ok(hernia.aliases.includes("ヘルニア　１８０以下で発注"));
  assert.equal(cottonman.unitPrice, 1214);
  assert.ok(cottonman.aliases.includes("色しっぽコットマン"));
  assert.deepEqual(cottonman.variants.map((variant) => variant.id), ["raw", "processed", "colored", "unclassified"]);
  assert.ok(king.aliases.includes("西端"));
  assert.ok(niigata.aliases.includes("西端"));
  assert.deepEqual(king.variants, [{ id: "single", label: "未加工のまま使用", threshold: 50 }]);
  assert.deepEqual(niigata.variants, [{ id: "single", label: "未加工のまま使用", threshold: null }]);
  assert.equal(maeda.openingUnconfirmed, true);
  assert.equal(maeda.variants[0].label, "未加工のまま使用");
  assert.equal(result.stock.some((row) => row.partId === maeda.id), false);
  assert.equal(result.items.some((item) => item.name === "旧部材B"), false);
  assert.equal(result.items.find((item) => item.name === "旧部材A").variants[0].label, "区分なし");
  assert.equal(result.stock.reduce((sum, row) => sum + row.quantity, 0), 700);
  assert.deepEqual(result.stock.filter((row) => row.partId === "hernia"), [
    { partId: "hernia", variant: "raw", location: "1F", quantity: 210 },
    { partId: "hernia", variant: "processed", location: "2F", quantity: 11 },
    { partId: "hernia", variant: "processed", location: "保土田", quantity: 40 },
  ]);
  assert.ok(result.stock.filter((row) => row.partId === king.id).every((row) => row.variant === "single"));
  assert.deepEqual(result.stock.filter((row) => row.partId === "cottonman" && row.variant === "colored"), [
    { partId: "cottonman", variant: "colored", location: "保土田", quantity: 21 },
  ]);
});

test("rejects malformed balances, subtotal mismatches, missing labels and duplicate product rows", () => {
  assert.throws(() => readSource([["", "ヘルニア", "#REF!", "-", "-", 0, "", ""]]), /3行目の1Fを数値で/);
  assert.throws(() => readSource([["", "ヘルニア", "9007199254740990.9", "-", "-", 9007199254740991, "", ""]]), /3行目の1Fを数値で/);
  assert.throws(() => readSource([["", "ヘルニア", 5, "-", "-", 6, "", ""]]), /保管場所別の数量と合計が一致しません/);
  assert.throws(() => readSource([["", "ヘルニア", 5, "-", "-", "", "", ""]]), /3行目の合計を数値で/);
  assert.throws(() => readSource([["", "", 5, "-", "-", 5, "", ""]]), /3行目に品名がありません/);
  const regular = ["", "ヘルニア", 0, "-", "-", 0, "", ""];
  assert.throws(() => readSource([regular, regular]), /4行目.*品目が重複/);
  assert.throws(() => readSource([regular], { headings: ["", "", "2F", "1F", "保土田", "合計", "", ""] }), /列見出し/);
  assert.throws(() => readSource([regular], { id: 10 }), /「総合在庫数」のデータが見つかりません/);
});

test("the opening revision changes with stock or notes but stays stable across legacy row rearrangement", () => {
  const item = ["", "部品甲", 8, "", "-", 8, "従来メモ", ""];
  const maeda = ["", "前田式レバー", "", "", "-", 0, "", ""];
  const first = readSource([item, maeda]);
  assert.equal(first.items.find((entry) => entry.id === "maeda-lever").openingUnconfirmed, undefined);
  assert.equal(first.sourceRevision, readSource([maeda, item]).sourceRevision);
  assert.notEqual(first.sourceRevision, readSource([item.with(2, 9).with(5, 9), maeda]).sourceRevision);
  assert.notEqual(first.sourceRevision, readSource([item.with(6, "追記"), maeda]).sourceRevision);
});

test("confirmed opening orders carry over only while their current memos still match", () => {
  const hernia = ["", "ヘルニア レバー", 5, "-", "-", 5, "10/13 500個発注", "12/24入荷"];
  const m1 = ["", "M1レバー", 8, "-", "-", 8, "10/13　300個発注", "12/24入荷"];
  const other = ["", "M2レバー", 8, "-", "-", 8, "10/13　300個発注", "12/24入荷"];
  const source = readSource([hernia, m1, other]);
  assert.deepEqual(source.openingOrders, [
    { id: "legacy-hernia-lever-20261013", partId: "hernia-lever", variant: "raw", quantity: 500, date: "2026-10-13", dueDate: "2026-12-24", note: "10/13 500個発注 ／ 12/24入荷" },
    { id: "legacy-m1-lever-20261013", partId: "m1-lever", variant: "raw", quantity: 300, date: "2026-10-13", dueDate: "2026-12-24", note: "10/13　300個発注 ／ 12/24入荷" },
  ]);
  assert.equal(source.sourceRevision, readSource([other, m1, hernia]).sourceRevision);
  const changed = readSource([hernia.with(7, "12/24入荷済"), m1, other]);
  assert.deepEqual(changed.openingOrders, [source.openingOrders[1]]);
  assert.match(changed.items.find((item) => item.id === "hernia-lever").note, /12\/24入荷済$/);
  assert.notEqual(changed.sourceRevision, source.sourceRevision);
});
