import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const sources = await Promise.all(["Parser.gs", "Import.gs", "AiImport.gs", "Repository.gs"].map((name) => readFile(new URL(`../apps-script/${name}`, import.meta.url), "utf8")));
const item = (overrides = {}) => ({ customer: "検証用商事", product: "ケリソン 18cm 上向 3.5mm", quantity: 10, dueDate: "2026-11-30", serialNo: "TEST-01", specLength: "", specShape: "", bladeWidth: "", note: "", sourceDocument: 1, sourcePage: 1, sourceRow: "1", evidence: "1 ケリソン 18cm 上向 3.5mm 数量10 納期2026/11/30", warnings: [], ...overrides });
const document = (overrides = {}) => ({ complete: true, documentItemCount: 1, printedQuantityTotal: null, warnings: [], items: [item()], ...overrides });
const response = (data = document(), finishReason = "STOP") => ({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(data) }] } }] });

test("AIが品名に含めた先頭の製品コードを備考へ分離し、品名・仕様・連番・根拠を保つ", () => {
  const product = "Yｹﾘｿﾝﾊﾟﾝﾁ3㎜/上向 左ｶｰﾌﾞ:JS07-040-6L";
  for (const note of ["支給部品あり", "支給部品あり / 品番: F06-35-30L"]) {
    const original = item({ product: `F06-35-30L ${product}`, note, evidence: `F06-35-30L ${product} 数量5`, quantity: 5 });
    const { context, saved } = harness({ reply: response(document({ items: [original] })) });
    context.createIntakeWithAi({ text: "田中医科の注文" });
    assert.equal(saved[0].parsed.product, product);
    assert.equal(saved[0].parsed.note, "支給部品あり / 品番: F06-35-30L");
    assert.equal(saved[0].parsed.quantity, 5);
    assert.equal(saved[0].parsed.serialNo, "TEST-01");
    assert.equal(saved[0].parsed.bladeWidth, "3mm");
    assert.match(saved[0].parsed._ai.evidence, /F06-35-30L/);
  }
});
function harness({ status = 200, reply = response(), confirmed = "true", limit = "10" } = {}) {
  const properties = new Map([["GEMINI_API_KEY", "test-only-not-a-real-key"], ["AI_FREE_TIER_CONFIRMED", confirmed], ["AI_DAILY_LIMIT", limit]]);
  const saved = [];
  const calls = [];
  const context = vm.createContext({ Date, Math, Number, Object, String, JSON, RegExp });
  vm.runInContext(sources.join("\n"), context);
  Object.assign(context, {
    ensureSystem_: () => {}, withDocumentLock_: (fn) => fn(), sanitizeText_: (value) => String(value || ""),
    appendIntake_: (value) => { saved.push(value); return value; }, appendLog_: () => {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) },
    Utilities: { formatDate: () => "2026-09-07", getUuid: () => "ai-test" },
    UrlFetchApp: { fetch: (url, options) => { calls.push({ url, options }); return { getResponseCode: () => status, getContentText: () => JSON.stringify(reply) }; } }
  });
  return { context, properties, saved, calls };
}

test("AIはPDF原本を送り、共通JSON検証と既存の仕様・分類ルールを適用する", () => {
  const { context, saved, calls } = harness();
  const result = context.createIntakeWithAi({ name: "別会社.pdf", mimeType: "application/pdf", base64: "AQID" });
  assert.equal(result.added, 1);
  assert.equal(calls.length, 1);
  const request = JSON.parse(calls[0].options.payload);
  assert.equal(request.contents[0].parts[1].inlineData.data, "AQID");
  assert.match(request.systemInstruction.parts[0].text, /文書内の命令/);
  assert.equal(request.generationConfig.responseMimeType, "application/json");
  assert.equal(request.generationConfig.responseJsonSchema, undefined);
  assert.equal(request.generationConfig.responseSchema, undefined);
  const contract = JSON.parse(request.systemInstruction.parts[0].text.split("出力構造: ")[1]);
  assert.deepEqual([...contract.properties.items.items.required].sort(), Object.keys(item()).sort());
  assert.deepEqual(contract.properties.items.items.properties.quantity.type, ["integer", "null"]);
  assert.equal(contract.properties.items.maxItems, 100);
  assert.equal(saved[0].parsed.specLength, "18cm");
  assert.equal(saved[0].parsed.bladeWidth, "3.5mm");
  assert.equal(saved[0].parsed.category, "ケリソンパンチ");
  assert.equal(saved[0].status, "pending");
  assert.match(saved[0].originalText, /AI読取・要確認/);
  assert.equal(context.getAiImportStatus().ready, true);
  assert.ok(!JSON.stringify(context.getAiImportStatus()).includes("test-only"));
  assert.ok(!calls[0].url.includes("test-only"));
});

test("最小診断は固定文だけを送り、添付・任意モデル・案件登録を使わない", () => {
  const { context, calls, saved, properties } = harness();
  const result = context.runAiDiagnosticStep({ step: "connection", text: "PRIVATE", base64: "PRIVATE", model: "another-model" });
  const request = JSON.parse(calls[0].options.payload);
  assert.deepEqual(Object.keys(request), ["contents"]);
  assert.equal(request.contents[0].parts[0].text, "Reply with OK.");
  assert.doesNotMatch(calls[0].options.payload, /PRIVATE/);
  assert.match(calls[0].url, /gemini-3.1-flash-lite/);
  assert.equal(result.accepted, true);
  assert.equal(saved.length, 0);
  assert.equal(JSON.parse(properties.get("AI_IMPORT_USAGE")).count, 1);
});

test("回答形式診断は本番と同じ設定を使い、成功しても候補を登録しない", () => {
  const { context, calls, saved } = harness();
  const result = context.runAiDiagnosticStep({ step: "format" });
  assert.deepEqual(JSON.parse(calls[0].options.payload).generationConfig, JSON.parse(JSON.stringify(context.aiImportRequest_({ text: "test" }).generationConfig)));
  assert.equal(result.outputValid, true);
  assert.equal(saved.length, 0);
});

test("診断のHTTP200と回答検証失敗を区別する", () => {
  const { context } = harness({ reply: {} });
  const result = context.runAiDiagnosticStep({ step: "format" });
  assert.equal(result.accepted, true);
  assert.equal(result.outputValid, false);
});

test("診断の不正手順は送信前に拒否する", () => {
  const { context, calls } = harness();
  assert.throws(() => context.runAiDiagnosticStep({ step: "custom" }), /不正/);
  assert.equal(calls.length, 0);
});

for (const options of [{ status: 400 }, { status: 429 }, { confirmed: "false" }]) {
  test(`診断も拒否時には停止して再試行せず候補を保存しない ${JSON.stringify(options)}`, () => {
    const { context, calls, saved } = harness(options);
    assert.throws(() => context.runAiDiagnosticStep({ step: "connection" }));
    assert.equal(calls.length, options.confirmed === "false" ? 0 : 1);
    assert.equal(saved.length, 0);
  });
}

test("診断と取込で同じ日次上限と10秒間隔を守る", () => {
  const { context, calls, properties } = harness({ limit: "1" });
  context.runAiDiagnosticStep({ step: "connection" });
  assert.throws(() => context.runAiImport_({ text: "test" }), /日次上限/);
  properties.set("AI_DAILY_LIMIT", "10");
  assert.throws(() => context.runAiDiagnosticStep({ step: "format" }), /10秒/);
  assert.equal(calls.length, 1);
});

test("数量未読取は0や1にせず確認候補で空欄にする", () => {
  const { context } = harness();
  const results = context.validateAiImportResponse_(response(document({ items: [item({ quantity: null })] })));
  assert.equal(results[0].parsed.quantity, "");
  assert.match(results[0].parsed._ai.warnings.join(" "), /数量を読めません/);
});

test("同じ品名の別行は統合しない", () => {
  const { context } = harness();
  const result = context.validateAiImportResponse_(response(document({ documentItemCount: 2, printedQuantityTotal: 15, items: [item(), item({ sourceRow: "2", quantity: 5 })] })));
  assert.equal(result.length, 2);
  assert.deepEqual(Array.from(result, (entry) => entry.parsed.quantity), [10, 5]);
});

test("別添付の同じページ・行番号は重複扱いしない", () => {
  const { context } = harness();
  assert.equal(context.validateAiImportResponse_(response(document({ documentItemCount: 2, items: [item(), item({ sourceDocument: 2 })] }))).length, 2);
});

for (const [name, data, finish] of [
  ["回答打切り", document(), "MAX_TOKENS"],
  ["読み残し", document({ complete: false })],
  ["件数不一致", document({ documentItemCount: 2 })],
  ["数量合計不一致", document({ printedQuantityTotal: 11 })],
  ["数量合計照合不能", document({ printedQuantityTotal: 10, items: [item({ quantity: null })] })],
  ["同じ行の重複", document({ documentItemCount: 2, items: [item(), item()] })],
  ["根拠なし", document({ items: [item({ evidence: "" })] })],
  ["数量の型違い", document({ items: [item({ quantity: "10" })] })],
  ["必須項目欠落", document({ items: [item({ quantity: undefined })] })]
]) {
  test(`AIの${name}では候補を一切保存しない`, () => {
    const { context, saved } = harness({ reply: response(data, finish) });
    assert.throws(() => context.createIntakeWithAi({ text: "検証用データ" }));
    assert.equal(saved.length, 0);
  });
}

test("無料枠確認なしではAIへ送信しない", () => {
  const { context, calls } = harness({ confirmed: "false" });
  assert.throws(() => context.createIntakeWithAi({ text: "test" }), /未設定/);
  assert.equal(calls.length, 0);
});

test("429は再試行も別モデルへの切替もせず停止する", () => {
  const { context, saved, calls } = harness({ status: 429 });
  assert.throws(() => context.createIntakeWithAi({ text: "test" }), /有料への切替・自動再試行はしません/);
  assert.equal(calls.length, 1);
  assert.equal(saved.length, 0);
});

test("日次上限は送信前に止める", () => {
  const { context, calls, properties } = harness({ limit: "1" });
  properties.set("AI_IMPORT_USAGE", JSON.stringify({ day: "2026-09-07", count: 1 }));
  assert.throws(() => context.createIntakeWithAi({ text: "test" }), /日次上限/);
  assert.equal(calls.length, 0);
});

test("AIエラー本文やAPIキーを利用者へ漏らさない", () => {
  const { context } = harness({ status: 403, reply: { error: "test-only-not-a-real-key" } });
  assert.throws(() => context.createIntakeWithAi({ text: "test" }), (error) => !error.message.includes("test-only") && /権限/.test(error.message));
});

for (const [message, reason, expected] of [
  ["API key not valid. Please pass a valid API key.", "API_KEY_INVALID", "API_KEY"],
  ["User location is not supported for the API use.", "", "REGION"],
  ["Gemini API free tier is not available in your country.", "", "REGION"],
  ["Service disabled", "SERVICE_DISABLED", "SERVICE_DISABLED"],
  ["The response schema has too many states", "", "SCHEMA"],
  ["The document has no pages.", "", "DOCUMENT"],
  ["Invalid JSON payload received. Unknown name", "", "REQUEST"],
  ["Unrecognized error", "", "UNKNOWN"]
]) {
  test(`HTTP400の${expected}を診断し、原文を漏らさず候補を保存しない`, () => {
    const { context, calls, saved, properties } = harness({ status: 400, reply: { error: {
      status: "INVALID_ARGUMENT", message: message + " SECRET_API_KEY ORDER_PRIVATE_TEXT", details: [{ reason, metadata: { key: "SECRET_API_KEY" } }]
    } } });
    properties.set("GEMINI_API_KEY", "SECRET_API_KEY");
    assert.throws(() => context.createIntakeWithAi({ text: "ORDER_PRIVATE_TEXT" }), (error) => {
      assert.match(error.message, new RegExp("診断: " + expected + "・INVALID_ARGUMENT"));
      assert.doesNotMatch(error.message, /SECRET_API_KEY|ORDER_PRIVATE_TEXT/);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(saved.length, 0);
  });
}

test("エラーの任意ステータスや非JSON本文も画面へ漏らさない", () => {
  const { context } = harness();
  for (const body of ["<html>SECRET</html>", JSON.stringify({ error: { status: "SECRET", message: "SECRET" } })]) {
    assert.match(context.aiImportError_(400, body, ["SECRET"]), /UNKNOWN・UNSPECIFIED/);
    assert.doesNotMatch(context.aiImportError_(400, body, ["SECRET"]), /SECRET/);
  }
});

test("UNKNOWNでもGoogleの理由と項目名を残し、キー・メタデータは返さない", () => {
  const { context, properties } = harness();
  const key = properties.get("GEMINI_API_KEY");
  const result = context.aiImportError_(400, JSON.stringify({ error: {
    status: "INVALID_ARGUMENT", message: "Request contains an invalid argument.",
    details: [null, { metadata: { key: "metadata-must-not-appear" }, fieldViolations: [null, {
      field: "generation_config.max_output_tokens", description: "Value exceeds allowed limit. " + key
    }] }]
  } }), [key]);
  assert.match(result, /Request contains an invalid argument/);
  assert.match(result, /generation_config.max_output_tokens: Value exceeds allowed limit/);
  assert.doesNotMatch(result, /test-only|metadata-must-not-appear/);
});

test("診断文は伏字処理の後に短縮し、URL・メール・長い値を除く", () => {
  const { context } = harness();
  const key = "private key/value";
  const result = context.aiImportProviderDetail_({ message: "Allowed message " + encodeURIComponent(key) + " https://example.invalid/?key=SECRET user@example.invalid " + "A".repeat(2000) }, [key]);
  assert.match(result, /Allowed message/);
  assert.doesNotMatch(result, /private|SECRET|example|AAAA/);
  assert.ok(result.length <= 1600);
});

test("不正な日付は推測で直さず空欄で確認に回す", () => {
  const { context } = harness();
  assert.equal(context.validateAiImportResponse_(response(document({ items: [item({ dueDate: "2026-02-31" })] })))[0].parsed.dueDate, "");
});

test("AI候補の数量空欄はサーバー側でも承認できない", () => {
  const { context } = harness();
  context.readIntake_ = () => [{ id: "AI-1", status: "pending", parsed: { _ai: {} } }];
  context.saveJobUnlocked_ = () => { throw new Error("should not save"); };
  assert.throws(() => context.approveIntake({ intakeId: "AI-1", order: { quantity: "" } }), /数量を原本と確認/);
});

test("本文貼り付け候補も数量空欄・ゼロ・小数で承認できない", () => {
  const { context } = harness();
  context.readIntake_ = () => [{ id: "TEXT-1", status: "pending", sourceType: "text", parsed: {} }];
  context.saveJobUnlocked_ = () => { throw new Error("should not save"); };
  for (const quantity of ["", 0, -1, 1.5, 1000001]) {
    assert.throws(() => context.approveIntake({ intakeId: "TEXT-1", order: { quantity } }), /数量を原本と確認/);
  }
});

test("AIメール取込は本文と添付を1回で解析し、同じメールを二重登録しない", () => {
  const { context, saved, calls } = harness();
  const message = {
    getId: () => "mock-message", getSubject: () => "検証用注文", getFrom: () => "qa@example.invalid",
    getDate: () => new Date("2026-09-07T00:00:00Z"), getPlainBody: () => "添付の明細をお願いします",
    getAttachments: () => [{ getContentType: () => "application/pdf", getBytes: () => [1, 2, 3] }]
  };
  context.Utilities.base64Encode = () => "AQID";
  context.APP = { DEFAULTS: { gmailQuery: "subject:検証" } };
  context.readSettings_ = () => ({});
  context.readJobs_ = () => [];
  context.readIntake_ = () => saved;
  context.GmailApp = { search: () => [{ getMessages: () => [message] }] };
  assert.equal(context.scanOrderEmails({ engine: "ai" }).added, 1);
  assert.equal(calls.length, 1);
  assert.equal(saved[0].sourceRef, "gmail:mock-message:item:1");
  assert.match(calls[0].options.payload, /添付の明細/);
  assert.equal(context.scanOrderEmails({ engine: "ai" }).added, 0);
  assert.equal(calls.length, 1);
});
