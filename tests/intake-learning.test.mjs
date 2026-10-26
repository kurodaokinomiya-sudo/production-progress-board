import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../src/intake-learning.js", import.meta.url), "utf8");
const context = vm.createContext({ Date, JSON, Math, Number, Object, String, RegExp, Array });
vm.runInContext(source, context);
const learning = context.IntakeLearning;

function record(overrides = {}) {
  return {
    customer: "甲医科",
    product: "左向 ケリソンパンチ 3mm",
    productCode: "K-03-L",
    category: "ケリソンパンチ",
    specLength: "18cm",
    specShape: "左向",
    bladeWidth: "3 mm",
    quantity: 4,
    dueDate: "2026-11-12",
    serialNo: "SER-1",
    externalOrderNo: "ORDER-1",
    externalLineNo: "2",
    note: "納期厳守",
    stages: { heatStatus: "done" },
    ...overrides,
  };
}

function learnOne({ intakeId = "intake-1", parsed = record(), order = record({ product: "左向 ケリソンパンチ 3 mm" }), rules = [], includeNote = false } = {}) {
  return learning.learn({ rules, parsed, order, intakeId, includeNote, updatedAt: "2026-10-14T00:00:00.000Z" });
}

test("sanitizes identity without erasing left/right, material, or size distinctions", () => {
  const result = learnOne({
    parsed: record({ product: " 左向　ケリソンパンチ 白銅 3mm " }),
    order: record({ product: "左向 ケリソンパンチ 白銅 3mm", category: "鋭匙鉗子" }),
  });
  assert.equal(result.changed, true);
  assert.match(result.message, /次回の取り込みに覚えました/);
  assert.equal(result.rule.key, JSON.stringify(["甲医科", "K-03-L", "左向 ケリソンパンチ 白銅 3mm"]));
  assert.deepEqual([...result.rule.fields], ["category"]);
  assert.equal(learning.apply({ parsed: record({ product: "左向 ケリソンパンチ 白銅 3mm" }), rules: result.rules }).status, "applied");
  assert.equal(learning.apply({ parsed: record({ product: "右向 ケリソンパンチ 白銅 3mm", productCode: "" }), rules: result.rules }).status, "none");
});

test("repeated approval with the same intake id is idempotent", () => {
  const first = learnOne({ parsed: record(), order: record({ category: "鋭匙鉗子" }) });
  const retry = learnOne({ rules: first.rules, parsed: record(), order: record({ category: "鋭匙鉗子" }) });
  assert.equal(retry.changed, false);
  assert.equal(retry.rules.length, 1);
  assert.equal(retry.message, "");
});

test("merges corrections from the original baseline and allows a fresh approval to remove one", () => {
  const first = learnOne({ parsed: record(), order: record({ category: "鋭匙鉗子" }), intakeId: "first" });
  const second = learnOne({ rules: first.rules, parsed: record(), order: record({ category: "鋭匙鉗子", specShape: "右向" }), intakeId: "second" });
  assert.deepEqual([...second.rule.fields].sort(), ["category", "specShape"]);
  assert.equal(second.rule.source.specShape, "左向");
  assert.equal(second.rule.target.specShape, "右向");
  const applied = learning.apply({ parsed: record(), rules: second.rules });
  const reset = learnOne({ rules: second.rules, parsed: applied.parsed, order: record(), intakeId: "third" });
  assert.equal(reset.changed, true);
  assert.equal(reset.rules.length, 0);
  assert.equal(reset.removedKey, first.rule.key);
  const emptyBaseline = learnOne({ intakeId: "empty-baseline", parsed: record({ specLength: "" }), order: record({ specLength: "21cm" }) });
  const prefilled = learning.apply({ parsed: record({ specLength: "" }), rules: emptyBaseline.rules });
  assert.equal(prefilled.status, "applied");
  const cleared = learnOne({ rules: emptyBaseline.rules, intakeId: "clear-empty", parsed: prefilled.parsed, order: record({ specLength: "" }) });
  assert.equal(cleared.changed, true);
  assert.equal(cleared.removedKey, emptyBaseline.rule.key);
});

test("does not relearn unchanged applied values, even after the rule was forgotten", () => {
  const learned = learnOne({ intakeId: "missing-length", parsed: record({ specLength: "" }), order: record({ specLength: "18cm" }) });
  const applied = learning.apply({ parsed: record({ specLength: "" }), rules: learned.rules });
  assert.equal(applied.parsed.specLength, "18cm");
  const unchanged = learnOne({ intakeId: "unchanged-again", parsed: applied.parsed, order: applied.parsed, rules: learned.rules });
  assert.equal(unchanged.changed, false);
  const forgotten = learnOne({ intakeId: "forgotten", parsed: applied.parsed, order: applied.parsed, rules: [] });
  assert.equal(forgotten.changed, false);
  assert.equal(forgotten.rules.length, 0);
});

test("a new manual field edit does not relearn an untouched prior suggestion", () => {
  const learned = learnOne({ intakeId: "missing-length", parsed: record({ specLength: "" }), order: record({ specLength: "18cm" }) });
  const applied = learning.apply({ parsed: record({ specLength: "" }), rules: learned.rules });
  const edited = learnOne({ intakeId: "new-shape", rules: [], parsed: applied.parsed,
    order: record({ specLength: "18cm", specShape: "右向" }) });
  assert.deepEqual([...edited.rule.fields], ["specShape"]);
  assert.equal(edited.rule.source.specLength, "");
  assert.equal(edited.rule.target.specLength, "");
});

test("matches code aliases or exact names, and normalizes dimensions semantically", () => {
  const learned = learnOne({ parsed: record({ product: "X型 鋭匙鉗子 左 2mm", productCode: "06-04-08", specLength: "210mm" }),
    order: record({ product: "X型 鋭匙鉗子 左 2mm", productCode: "06－04－08", specLength: "21cm", category: "鋭匙鉗子" }) });
  const byCode = learning.apply({ parsed: record({ product: "別表記", productCode: "06-04-08", specLength: "21 cm" }), rules: learned.rules });
  assert.equal(byCode.status, "applied");
  assert.equal(byCode.parsed.category, "鋭匙鉗子");
  const noCodeRules = learnOne({ parsed: record({ productCode: "", product: "X型 鋭匙鉗子 左 2mm" }),
    order: record({ productCode: "", product: "X型 鋭匙鉗子 左 2mm", category: "鋭匙鉗子" }) });
  const byName = learning.apply({ parsed: record({ productCode: "", product: "X型 鋭匙鉗子 左 2mm" }), rules: noCodeRules.rules });
  assert.equal(byName.status, "applied");
});

test("relearning a canonical alias reuses its prior rule key and learns only the new correction", () => {
  const first = learnOne({ intakeId: "first-alias", parsed: record({
    product: "Old model left 3mm", productCode: "", specLength: "", specShape: "", bladeWidth: "",
  }), order: record({ product: "Canonical model left 3mm", productCode: "CK021", specLength: "", specShape: "", bladeWidth: "", category: "鋭匙鉗子" }) });
  assert.equal(first.rules.length, 1);
  const incoming = record({ product: "Canonical model left 3mm", productCode: "ck021", specLength: "", specShape: "", bladeWidth: "" });
  const applied = learning.apply({ parsed: incoming, rules: first.rules });
  assert.equal(applied.status, "applied");
  const second = learnOne({ rules: first.rules, intakeId: "second-alias", parsed: applied.parsed,
    order: record({ product: "Canonical model left 3mm", productCode: "ck021", specLength: "21cm", specShape: "", bladeWidth: "", category: "鋭匙鉗子" }) });
  assert.equal(second.rules.length, 1);
  assert.equal(second.rule.key, first.rule.key);
  assert.deepEqual([...second.rule.fields].sort(), ["category", "product", "productCode", "specLength"]);
  const next = learning.apply({ parsed: record({ product: "Canonical model left 3mm", productCode: "CK021", specLength: "210mm", specShape: "", bladeWidth: "", category: "鋭匙鉗子" }), rules: second.rules });
  assert.equal(next.status, "none");
  assert.equal(next.ruleKeys[0], first.rule.key);
});

test("refuses ambiguous rules, conflicting dimensions, conflicting codes, and customer mismatches", () => {
  const a = learnOne({ parsed: record({ productCode: "", specShape: "" }), order: record({ productCode: "", specShape: "", category: "鋭匙鉗子" }), intakeId: "a" });
  const conflictingRule = { ...a.rules[0], target: { ...a.rules[0].target, category: "別分類" }, intakeId: "different" };
  assert.equal(learning.apply({ parsed: record({ productCode: "", specShape: "" }), rules: [...a.rules, conflictingRule] }).status, "ambiguous");

  const learned = learnOne({ parsed: record(), order: record({ category: "鋭匙鉗子" }) });
  const dimensions = learning.apply({ parsed: record({ specShape: "右向" }), rules: learned.rules });
  assert.equal(dimensions.status, "conflict");
  const code = learning.apply({ parsed: record({ productCode: "OTHER", product: record().product }), rules: learned.rules });
  assert.equal(code.status, "conflict");
  const customer = learning.apply({ parsed: record({ customer: "乙医科" }), rules: learned.rules });
  assert.equal(customer.status, "none");
});

test("unknown stored dimensions do not block an otherwise exact identity", () => {
  const learned = learnOne({ parsed: record({ productCode: "UNKNOWN-SPEC", specShape: "", specLength: "", bladeWidth: "" }),
    order: record({ productCode: "UNKNOWN-SPEC", specShape: "", specLength: "", bladeWidth: "", category: "鋭匙鉗子" }) });
  const result = learning.apply({ parsed: record({ productCode: "unknown-spec", specShape: "右向", specLength: "21cm", bladeWidth: "3mm" }), rules: learned.rules });
  assert.equal(result.status, "applied");
  assert.equal(result.parsed.category, "鋭匙鉗子");
});

test("does not overwrite a conflicting nonblank field and keeps target values already applied", () => {
  const learned = learnOne({ parsed: record(), order: record({ category: "鋭匙鉗子" }) });
  const conflict = learning.apply({ parsed: record({ category: "別分類" }), rules: learned.rules });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.parsed.category, "別分類");
  const target = learning.apply({ parsed: record({ category: "鋭匙鉗子" }), rules: learned.rules });
  assert.equal(target.status, "none");
  assert.equal(target.parsed.category, "鋭匙鉗子");
});

test("refuses generic names without a code and does not learn order-specific fields", () => {
  const generic = learnOne({ parsed: record({ product: "ケリソンパンチ", productCode: "" }), order: record({ product: "ケリソンパンチ", productCode: "", category: "鋭匙鉗子" }) });
  assert.equal(generic.changed, false);
  const unchanged = learnOne({ parsed: record(), order: record({ dueDate: "2027-01-01", quantity: 90, serialNo: "OTHER", externalOrderNo: "OTHER", note: "secret" }) });
  assert.equal(unchanged.changed, false);
  const withCode = learnOne({ parsed: record({ product: "ケリソンパンチ", productCode: "K-1" }), order: record({ product: "ケリソンパンチ", productCode: "K-1", dueDate: "2027-01-01", quantity: 90, serialNo: "OTHER", externalOrderNo: "OTHER", category: "鋭匙鉗子" }) });
  assert.deepEqual(Object.keys(withCode.rule.source).sort(), ["bladeWidth", "category", "product", "productCode", "specLength", "specShape"].sort());
  assert.equal(JSON.stringify(withCode.rules).includes("2027-01-01"), false);
  assert.equal(JSON.stringify(withCode.rules).includes("OTHER"), false);
});

test("captures only opted-in appended note and applies it once without losing other fields", () => {
  const parsed = record({ note: "納期厳守", privateField: "keep", stages: { baseStatus: "done" } });
  const finalOrder = record({ note: "納期厳守 / 左向を確認", category: "鋭匙鉗子" });
  const withoutOptIn = learnOne({ parsed, order: finalOrder });
  assert.equal(withoutOptIn.rule.note, undefined);
  const learned = learnOne({ parsed, order: finalOrder, includeNote: true });
  assert.equal(learned.rule.note, "左向を確認");
  const applied = learning.apply({ parsed: record({ note: "通常備考", privateField: "keep", stages: { baseStatus: "done" } }), rules: learned.rules });
  assert.equal(applied.parsed.note, "通常備考 / 左向を確認");
  assert.equal(applied.parsed.privateField, "keep");
  assert.deepEqual(applied.parsed.stages, { baseStatus: "done" });
  const repeated = learning.apply({ parsed: applied.parsed, rules: learned.rules });
  assert.equal(repeated.parsed.note, "通常備考 / 左向を確認");
  const long = "長い備考".repeat(300);
  const withLongNote = learning.apply({ parsed: record({ note: long }), rules: learned.rules });
  assert.equal(withLongNote.status, "applied");
  assert.equal(withLongNote.parsed.note, long + " / 左向を確認");
  const tooLong = learning.apply({ parsed: record({ note: "長い備考".repeat(500) }), rules: learned.rules });
  assert.equal(tooLong.status, "conflict");
  assert.equal(tooLong.parsed.note, "長い備考".repeat(500));
});

test("does not duplicate a two-part learned note and preserves the full existing note", () => {
  const original = record({ note: "通常の注文備考" });
  const learned = learnOne({ parsed: original, order: record({ note: "通常の注文備考 / 追加A / 追加B", category: "鋭匙鉗子" }), includeNote: true });
  assert.equal(learned.rule.note, "追加A / 追加B");
  const candidate = record({ note: "長い通常備考を維持 / 追加A / 追加B" });
  const first = learning.apply({ parsed: candidate, rules: learned.rules });
  assert.equal(first.parsed.note, candidate.note);
  const repeated = learning.apply({ parsed: first.parsed, rules: learned.rules });
  assert.equal(repeated.parsed.note, candidate.note);

  const partial = learning.apply({ parsed: record({ note: "通常 / prefix追加A / 追加Bsuffix" }), rules: learned.rules });
  assert.equal(partial.parsed.note, "通常 / prefix追加A / 追加Bsuffix / 追加A / 追加B");
});

test("merges appended common notes, replaces or clears them explicitly, and exposes rule intake provenance", () => {
  const first = learnOne({ intakeId: "note-first", parsed: record({ note: "" }), order: record({ note: "追加A" }), includeNote: true });
  assert.equal(first.rule.note, "追加A");
  const applied = learning.apply({ parsed: record({ note: "注文固有" }), rules: first.rules });
  assert.equal(applied.parsed.note, "注文固有 / 追加A");
  assert.equal(applied.ruleIntakeIds[first.rule.key], "note-first");
  assert.equal(applied.parsed._learning.ruleIntakeIds[first.rule.key], "note-first");

  const appended = learnOne({ intakeId: "note-second", rules: first.rules, parsed: applied.parsed,
    order: record({ note: "注文固有 / 追加A / 追加B" }), includeNote: true });
  assert.equal(appended.rule.note, "追加A / 追加B");
  const future = learning.apply({ parsed: record({ note: "別注文の固有備考" }), rules: appended.rules });
  assert.equal(future.parsed.note, "別注文の固有備考 / 追加A / 追加B");
  assert.equal(future.ruleIntakeIds[appended.rule.key], "note-second");

  const replacement = learnOne({ intakeId: "note-replace", rules: appended.rules, parsed: future.parsed,
    order: record({ note: "新共通" }), includeNote: true });
  assert.equal(replacement.rule.note, "新共通");
  const shownReplacement = learning.apply({ parsed: record({ note: "注文固有" }), rules: replacement.rules });
  const cleared = learnOne({ intakeId: "note-clear", rules: replacement.rules, parsed: shownReplacement.parsed,
    order: record({ note: "" }), includeNote: true });
  assert.equal(cleared.changed, true);
  assert.equal(cleared.removedKey, replacement.rule.key);
});

test("sanitizes malicious shapes, bounds values, filters prompt examples, and removes by key", () => {
  const learned = learnOne({ parsed: record(), order: record({ category: "鋭匙鉗子" }) });
  const hostile = JSON.parse('{"key":"x","customer":"甲医科","source":{"product":"x","__proto__":{"polluted":true}},"target":{},"fields":["product", "constructor"],"intakeId":"x"}');
  const sanitized = learning.sanitizeRules([...learned.rules, hostile, null]);
  assert.equal(sanitized.length, 1);
  assert.equal({}.polluted, undefined);
  const examples = learning.promptExamples({ rules: sanitized, text: "甲医科 左向 ケリソンパンチ 3mm", limit: 80 });
  assert.equal(examples.length, 1);
  assert.equal(JSON.stringify(examples).includes("納期厳守"), false);
  assert.equal(learning.promptExamples({ rules: sanitized, text: "乙医科 左向 ケリソンパンチ 3mm" }).length, 0);
  assert.deepEqual([...learning.remove({ rules: sanitized, key: sanitized[0].key })], []);
  const tooLong = learnOne({ parsed: record(), order: record({ category: "x".repeat(601) }) });
  assert.equal(tooLong.changed, false);
  assert.match(tooLong.message, /長すぎる/);
});
