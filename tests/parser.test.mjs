import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../apps-script/Parser.gs", import.meta.url), "utf8");
const tanakaTcPurchaseOrder = await readFile(new URL("./fixtures/tanaka-tc-purchase-order.txt", import.meta.url), "utf8");
const context = vm.createContext({ Date, Math, Number, Object, RegExp, String });
vm.runInContext(source, context);

test("ラベル付きの日本語注文メールを解析する", () => {
  const result = context.parseOrderText_(
    "得意先：田中商事\n品名：Yカーブドケリパンチ\n納期：2026年8月31日\n数量：10本\n連番：26-1101-1\n全長：18cm\n刃幅：2mm",
    {},
  );
  assert.equal(result.parsed.customer, "田中商事");
  assert.equal(result.parsed.product, "Yカーブドケリパンチ");
  assert.equal(result.parsed.dueDate, "2026-08-31");
  assert.equal(result.parsed.quantity, 10);
  assert.equal(result.parsed.serialNo, "26-1101-1");
  assert.equal(result.parsed.bladeWidth, "2mm");
  assert.ok(result.confidence >= 0.85);
});

test("年のない日付を基準日から補う", () => {
  assert.equal(context.normalizeDate_("8/31", new Date(2026, 7, 22)), "2026-08-31");
  assert.equal(context.normalizeDate_("1月5日", new Date(2026, 7, 22)), "2027-01-05");
});

test("本文に品名がない場合は件名から候補を作る", () => {
  const result = context.parseOrderText_("数量：3\n納期：9/15", { sender: "松井製作所 <orders@example.test>", subject: "【注文】慈穴式 彫骨器の件" });
  assert.equal(result.parsed.customer, "松井製作所");
  assert.equal(result.parsed.product, "慈穴式 彫骨器");
  assert.equal(result.parsed.quantity, 3);
});

test("田中医科TC発注書の複数品目を案件候補へ分割する", () => {
  const results = context.parseOrderItems_(tanakaTcPurchaseOrder, { subject: "発注書_2026年11月納入分_TC_26_1790_260831田中医科.pdf" });
  assert.equal(results.length, 6);
  assert.deepEqual(
    Array.from(results, (result) => result.parsed.serialNo),
    ["26-1790-1", "26-1790-2", "26-1790-3", "26-1790-4", "26-1790-5", "26-1790-6"],
  );
  assert.deepEqual(Array.from(results, (result) => result.parsed.quantity), [10, 10, 10, 5, 5, 5]);
  assert.ok(results.every((result) => result.parsed.customer === "田中"));
  assert.ok(results.every((result) => result.parsed.dueDate === "2026-11-30"));

  assert.equal(results[0].parsed.product, "千葉大式鋭匙鉗子<直/6mm>18cm");
  assert.equal(results[0].parsed.category, "鋭匙鉗子");
  assert.equal(results[0].parsed.specLength, "18cm");
  assert.equal(results[0].parsed.specShape, "直");
  assert.equal(results[0].parsed.bladeWidth, "6mm");
  assert.match(results[0].parsed.note, /品番: 06-56-60S/);

  assert.equal(results[2].parsed.product, "メニスカス鉗子Cl.<2-3爪>16.5cm");
  assert.equal(results[2].parsed.specShape, "2-3爪");
  assert.match(results[2].parsed.note, /支給部品あり/);
  assert.equal(results[3].parsed.product, "Yケリソンパンチ2mm/上向 左カーブ:JS07-040-3L-J");
  assert.equal(results[3].parsed.category, "ケリソンパンチ");
  assert.equal(results[3].parsed.bladeWidth, "2mm");
  assert.equal(results[3].parsed.specShape, "上曲左");
  assert.equal(results[5].parsed.specShape, "上曲右");
  assert.ok(results.every((result) => result.confidence >= 0.85));
});

test("品名前の製品コードだけを分離し、品名内の型番や寸法は保持する", () => {
  const name = "Yｹﾘｿﾝﾊﾟﾝﾁ3㎜/上向 左ｶｰﾌﾞ:JS07-040-6L";
  for (const code of ["F06-35-30L", "Ｆ０６－３５－３０Ｌ", "F06‐35‐30L"]) {
    const parsed = context.separateImportedProductCode_({ product: `${code} ${name}`, note: "既存の備考" });
    assert.equal(parsed.product, name);
    assert.equal(parsed.note, "既存の備考 / 品番: F06-35-30L");
    context.separateImportedProductCode_(parsed);
    assert.equal(parsed.note, "既存の備考 / 品番: F06-35-30L");
  }
  for (const product of ["18-20 cm 鉗子", "3M テープ", "JS07-040-6L Yケリソンパンチ", "F06-35-30L", name]) {
    assert.equal(context.splitLeadingProductCode_(product).product, product);
  }
  const result = context.parseOrderText_("得意先: 田中\n品名: F06-35-30L Yケリソンパンチ3mm/上向 左カーブ:JS07-040-6L\n数量: 5", {});
  assert.equal(result.parsed.product, "Yケリソンパンチ3mm/上向 左カーブ:JS07-040-6L");
  assert.equal(result.parsed.note, "品番: F06-35-30L");
});

test("TC発注書を行内の納期・数量が保持されたOCR結果からも分割する", () => {
  const text = [
    "下記のとおり、発注致します。 株式会社田中医科器械製作所",
    "有限会社興之宮医科工業 TC_26_1790",
    "2026-08-31",
    "2026-11-30",
    "1 _ 06-56-60S 千葉大式鋭匙鉗子<直/6㎜>18㎝ 2026-11-30 10 個 50,000 500,000",
    "2 _ F06-35-20L Yｹﾘｿﾝﾊﾟﾝﾁ2㎜/上向 左ｶｰﾌﾞ:JS07-040-3L-J 2026-11-30 5 個 73,000 365,000",
    "※納品書に必ず弊社購買Noを記載ください",
  ].join("\n");
  const results = context.parseOrderItems_(text, {});
  assert.equal(results.length, 2);
  assert.equal(results[0].parsed.product, "千葉大式鋭匙鉗子<直/6mm>18cm");
  assert.equal(results[0].parsed.dueDate, "2026-11-30");
  assert.equal(results[0].parsed.quantity, 10);
  assert.equal(results[1].parsed.product, "Yケリソンパンチ2mm/上向 左カーブ:JS07-040-3L-J");
  assert.equal(results[1].parsed.quantity, 5);
});

test("TC発注書は品目番号の欠落や数量未読取を成功扱いにしない", () => {
  const text = [
    "株式会社田中医科器械製作所",
    "有限会社興之宮医科工業 TC_26_1790",
    "2026-08-31",
    "2026-11-30",
    "1 _ 06-56-60S 千葉大式鋭匙鉗子<直/6mm>18cm",
    "3 _ 15-09 メニスカス鉗子Cl.<2-3爪>16.5cm",
  ].join("\n");
  assert.throws(
    () => context.parseOrderItems_(text, {}),
    /欠落した品目番号: 2.*数量未読取: 品目1, 3/,
  );
});

test("不正な日付は空欄にして確認へ回す", () => {
  assert.equal(context.normalizeDate_("2026年2月30日", new Date(2026, 0, 1)), "");
  assert.equal(context.normalizeDate_("8月末", new Date(2026, 7, 22)), "");
});

test("製品名の語から大分類を自動判定する", () => {
  assert.equal(context.classifyProductCategory_("ケリソンパンチ 18cm"), "ケリソンパンチ");
  assert.equal(context.classifyProductCategory_("ケリパンチ"), "ケリソンパンチ");
  assert.equal(context.classifyProductCategory_("スタンツェ 上向"), "ケリソンパンチ");
  assert.equal(context.classifyProductCategory_("スタンチェ"), "ケリソンパンチ");
  assert.equal(context.classifyProductCategory_("スタンツエ"), "ケリソンパンチ");
  assert.equal(context.classifyProductCategory_("スタッツェ"), "ケリソンパンチ");
  assert.equal(context.classifyProductCategory_("慈穴式 彫骨器"), "ケリソンパンチ");
  assert.equal(context.classifyProductCategory_("ケリソン鉗子"), "ケリソンパンチ");
  assert.equal(context.classifyProductCategory_("鋭匙鉗子 直"), "鋭匙鉗子");
  assert.equal(context.classifyProductCategory_("鋭匙"), "");
});

test("製品名にある寸法を仕様へ補完し、明示値を優先する", () => {
  const inferred = context.inferSpecsFromProductName_("スタンツェ 18cm 弱弯 2mm", {});
  assert.equal(inferred.specLength, "18cm");
  assert.equal(inferred.bladeWidth, "2mm");
  assert.equal(inferred.specShape, "弱弯");

  const labeled = context.inferSpecsFromProductName_("全長120mm 刃幅2mm", {
    specLength: "18cm",
    bladeWidth: "3.5mm",
    specShape: "直上向",
  });
  assert.equal(labeled.specLength, "18cm");
  assert.equal(labeled.bladeWidth, "3.5mm");
  assert.equal(labeled.specShape, "直上向");
});

test("全長のmm表記を刃幅として誤採用しない", () => {
  const inferred = context.inferSpecsFromProductName_("鋭匙鉗子 全長120mm 刃幅3.5mm", {});
  assert.equal(inferred.specLength, "120mm");
  assert.equal(inferred.bladeWidth, "3.5mm");
});

test("未ラベルmmは50mm以上を全長、20mm以下を刃幅として補完する", () => {
  const length = context.inferSpecsFromProductName_("製品 50mm", {});
  assert.equal(length.specLength, "50mm");
  assert.equal(length.bladeWidth, "");

  const width = context.inferSpecsFromProductName_("製品 20mm", {});
  assert.equal(width.specLength, "");
  assert.equal(width.bladeWidth, "20mm");

  const ambiguous = context.inferSpecsFromProductName_("製品 35mm", {});
  assert.equal(ambiguous.specLength, "");
  assert.equal(ambiguous.bladeWidth, "");
});

test("全角数字・単位・空白を含む製品名の寸法も補完する", () => {
  const inferred = context.inferSpecsFromProductName_("スタッツェ　１８ｃｍ　３．５ｍｍ", {});
  assert.equal(inferred.specLength, "18cm");
  assert.equal(inferred.bladeWidth, "3.5mm");
});

test("4桁の全長と複合形状を画面側と同じ粒度で補完する", () => {
  const inferred = context.inferSpecsFromProductName_("鋭匙鉗子 上曲左 全長1200mm 刃幅3.5mm", {});
  assert.equal(inferred.specLength, "1200mm");
  assert.equal(inferred.specShape, "上曲左");
  assert.equal(inferred.bladeWidth, "3.5mm");
});

test("大分類は空欄なら品名から補完し、不正な明示値は拒否できる", () => {
  assert.equal(context.normalizeCategory_("", "ケリパンチ"), "ケリソンパンチ");
  assert.equal(context.normalizeCategory_("不正な分類", "ケリパンチ"), "");
  assert.throws(
    () => context.normalizeCategory_("不正な分類", "ケリパンチ", true),
    /大分類の値が不正/
  );
});
