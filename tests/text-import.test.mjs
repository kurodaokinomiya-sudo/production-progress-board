import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parseLocalOrderText } from "../tools/local-text-parser.mjs";

const [parserSource, importSource, aiSource] = await Promise.all(
  ["Parser.gs", "Import.gs", "AiImport.gs"].map((name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8")),
);

const mailText = [
  "件名: ご注文の件",
  "得意先: 田中商事",
  "品名: ケリソン18cm上向3mm",
  "数量: 10",
  "納期: 2026-11-30",
  "連番: 26-1790-1",
].join("\n");

const twoItemText = [
  "得意先: 田中",
  "品名: ケリソン18cm上向3mm",
  "数量: 10",
  "納期: 2026-11-30",
  "連番: 26-1790-1",
  "",
  "品名: 鋭匙鉗子21cm直4mm",
  "数量: 5",
  "納期: 2026-11-30",
  "連番: 26-1790-2",
].join("\n");

function harness({ withAi = false, properties = new Map() } = {}) {
  const saved = [];
  const logs = [];
  const calls = [];
  const context = vm.createContext({ Date, Math, Number, Object, RegExp, String, JSON });
  vm.runInContext(withAi ? `${parserSource}\n${importSource}\n${aiSource}` : `${parserSource}\n${importSource}`, context);
  Object.assign(context, {
    ensureSystem_: () => {},
    sanitizeText_: (value, max) => String(value === undefined || value === null ? "" : value).trim().slice(0, max || 500),
    withDocumentLock_: (fn) => fn(),
    appendIntake_: (item) => {
      const savedItem = { ...item, id: `INTAKE-${saved.length + 1}` };
      saved.push(savedItem);
      return savedItem;
    },
    appendLog_: (...args) => logs.push(args),
    Utilities: { getUuid: () => "paste-batch" },
  });
  if (withAi) {
    Object.assign(context, {
      PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => properties.get(key) }) },
      Utilities: { getUuid: () => "paste-batch", formatDate: () => "2026-09-10" },
      UrlFetchApp: { fetch: () => { throw new Error("network must not be called"); } },
    });
  }
  return { context, saved, logs, calls };
}

test("Apps Scriptの貼り付け本文は従来 parser で1件の確認候補になる", () => {
  const { context, saved, logs } = harness();
  const result = context.createIntakeFromText({ name: "注文メール", text: mailText });

  assert.equal(result.added, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sourceType, "text");
  assert.match(saved[0].sourceRef, /^paste:/);
  assert.equal(saved[0].parsed.customer, "田中商事");
  assert.equal(saved[0].parsed.quantity, 10);
  assert.equal(saved[0].status, "pending");
  assert.equal(saved[0].originalText, mailText);
  assert.equal(logs[0][0], "intake.text");
});

test("行頭の品名ラベル2ブロックを個別候補にし、共通得意先を引き継ぐ", () => {
  const { context, saved } = harness();
  const result = context.createIntakeFromText({ name: "2品目の注文", text: twoItemText });

  assert.equal(result.added, 2);
  assert.deepEqual(saved.map((item) => item.parsed.product), ["ケリソン18cm上向3mm", "鋭匙鉗子21cm直4mm"]);
  assert.deepEqual(saved.map((item) => item.parsed.quantity), [10, 5]);
  assert.deepEqual(saved.map((item) => item.parsed.customer), ["田中", "田中"]);
  assert.ok(saved.every((item) => item.sourceType === "text" && item.status === "pending"));
  assert.equal(new Set(saved.map((item) => item.sourceRef)).size, 2);
  assert.ok(saved.every((item) => item.originalText.includes(twoItemText)));
});

test("複数品目では共通ラベルより明細ブロックのラベルを優先する", () => {
  const { context, saved } = harness();
  const text = [
    "得意先: 田中",
    "納期: 2026-12-31",
    "品名: ケリソン18cm上向3mm",
    "数量: 10",
    "納期: 2026-11-30",
    "連番: 26-1790-1",
    "品名: 鋭匙鉗子21cm直4mm",
    "数量: 5",
    "納期: 2026-12-15",
    "連番: 26-1790-2",
  ].join("\n");
  context.createIntakeFromText({ text });
  assert.deepEqual(saved.map((item) => item.parsed.dueDate), ["2026-11-30", "2026-12-15"]);
});

test("単一品目でも明細ブロックのラベルを共通ヘッダーより優先する", () => {
  const { context, saved } = harness();
  const text = [
    "得意先: 田中",
    "納期: 2026-12-31",
    "品名: ケリソン18cm上向3mm",
    "数量: 10",
    "納期: 2026-11-30",
    "連番: 26-1790-1",
  ].join("\n");
  context.createIntakeFromText({ text });
  assert.equal(saved[0].parsed.dueDate, "2026-11-30");
});

test("貼り付け本文で数量不明を1にせず空欄の確認候補に残す", () => {
  const { context, saved } = harness();
  const text = "得意先: 田中\n品名: ケリソン18cm上向3mm\n納期: 2026-11-30\n連番: 26-1790-1";
  context.createIntakeFromText({ text });
  assert.equal(saved[0].parsed.quantity, "");
  assert.notEqual(saved[0].parsed.quantity, 1);
  assert.equal(saved[0].status, "pending");
});

test("貼り付け本文の形式・空欄・上限・エンジンを検証する", () => {
  const { context } = harness();
  assert.throws(() => context.createIntakeFromText({ text: 10 }), /本文は文字列/);
  assert.throws(() => context.createIntakeFromText({ text: " \n\t" }), /本文を入力/);
  assert.throws(() => context.createIntakeFromText({ text: "x".repeat(30001) }), /30000文字以下/);
  assert.throws(() => context.createIntakeFromText({ name: "x".repeat(201), text: "注文" }), /名前は200文字以下/);
  assert.throws(() => context.createIntakeFromText({ text: "注文", engine: "unknown" }), /読取エンジン/);
});

test("貼り付けAIは原文だけを既存 runAiImport_ に渡し、原文を確認候補へ残す", () => {
  const { context, saved, calls } = harness();
  context.runAiImport_ = (input) => {
    calls.push(input);
    return [{ parsed: { customer: "田中", product: "ケリソン", quantity: "", _ai: { warnings: ["確認"] } }, confidence: 0, itemNumber: 1 }];
  };
  context.createIntakeFromText({ name: "貼り付けAI", text: mailText, engine: "ai", files: [{ base64: "MUST_IGNORE" }] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "貼り付けAI");
  assert.equal(calls[0].text, mailText);
  assert.equal(saved[0].sourceType, "text");
  assert.match(saved[0].originalText, /AI読取・要確認/); // AI review marker
  assert.match(saved[0].originalText, /得意先: 田中商事/);
});

test("Apps Scriptの貼り付けAIはキー未設定なら送信も候補保存もしない", () => {
  const { context, saved } = harness({ withAi: true });
  assert.throws(() => context.createIntakeFromText({ text: mailText, engine: "ai" }), /AI取込は未設定/);
  assert.equal(saved.length, 0);
});

test("ローカル本文 parser は同じ2件契約を返し、AIテストは注入parserだけを使う", async () => {
  const parsed = await parseLocalOrderText({ name: "ローカル2品目", text: twoItemText });
  assert.equal(parsed.engineVersion, 2);
  assert.equal(parsed.text, twoItemText);
  assert.deepEqual(parsed.results.map((result) => result.parsed.quantity), [10, 5]);

  const calls = [];
  const ai = await parseLocalOrderText(
    { name: "ローカルAI", text: mailText, engine: "ai", files: [{ base64: "MUST_IGNORE" }] },
    { aiParser: async (input) => { calls.push(input); return { results: [{ parsed: { quantity: "" }, confidence: 0 }] }; } },
  );
  assert.deepEqual(calls, [{ name: "ローカルAI", text: mailText }]);
  assert.equal(ai.engineVersion, 2);
  assert.equal(ai.text, mailText);
  assert.equal(ai.results[0].parsed.quantity, "");
});

test("ローカル本文 parser も空欄・上限・未知エンジン・AI未設定をネットワークなしで拒否する", async () => {
  await assert.rejects(() => parseLocalOrderText({ text: " " }), /本文を入力/);
  await assert.rejects(() => parseLocalOrderText({ text: "x".repeat(30001) }), /30000文字以下/);
  await assert.rejects(() => parseLocalOrderText({ text: "注文", engine: "unknown" }), /読取エンジン/);
  await assert.rejects(
    () => parseLocalOrderText({ text: mailText, engine: "ai" }, { aiParser: async () => { throw new Error("AI取込は未設定です。"); } }),
    /AI取込は未設定/,
  );
});
