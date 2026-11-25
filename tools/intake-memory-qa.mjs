import assert from "node:assert/strict";
import path from "node:path";
import { runBrowserQa, selectQaView } from "./browser-runtime.mjs";

const customer = "記憶QA商事";
const product = "ケリソン18cm上向3mm";
const firstText = [
  `得意先: ${customer}`,
  `品名: ${product}`,
  "数量: 3",
  "納期: 2026-12-15",
  "連番: MEM-QA-ORIGINAL",
].join("\n");
const repeatedText = [
  `得意先: ${customer}`,
  `品名: ${product}`,
  "数量: 11",
  "納期: 2027-01-06",
  "連番: MEM-QA-2A",
  "",
  `品名: ${product}`,
  "数量: 4",
  "納期: 2027-02-06",
  "連番: MEM-QA-2B",
].join("\n");

await runBrowserQa("intake-memory", async ({ page, output, label, origin }) => {
  const externalRequests = [];
  page.on("request", request => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("production-board-demo-v2")));
  const openTextImport = async () => {
    await page.locator("[data-action='open-import']").first().click();
    await page.locator("#import-text-tab").click();
  };
  const assertNoOverflow = async (dialog) => {
    assert.ok(await page.locator(dialog).evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${label} ${dialog} overflow`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label} root overflow at ${await page.evaluate(() => innerWidth)}px`);
  };

  await openTextImport();
  const subject = page.locator("#text-import-subject");
  await subject.focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "text-import-body", "Tab moves from subject to the body");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "text-import-engine", "Tab reaches the engine selector");
  await page.locator("#text-import-engine").selectOption("legacy");
  await subject.fill("記憶QA 初回確認");
  await page.locator("#text-import-body").fill(firstText);
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 1024 });
    await assertNoOverflow("#import-dialog");
    await page.screenshot({ path: path.join(output, `${label}-import-${width}.png`), fullPage: true });
  }
  await page.locator("#text-import-form button[type='submit']").click();
  await page.locator("#import-dialog").waitFor({ state: "hidden" });
  await page.locator(".intake-card").filter({ hasText: "記憶QA 初回確認" }).waitFor();
  let data = await saved();
  assert.equal(data.intake.filter(item => item.parsed?.serialNo === "MEM-QA-ORIGINAL").length, 1);
  assert.equal(data.intake.find(item => item.parsed?.serialNo === "MEM-QA-ORIGINAL").parsed.quantity, 3);

  const initialCard = page.locator(".intake-card").filter({ hasText: "記憶QA 初回確認" });
  await initialCard.getByRole("button", { name: "内容を確認する" }).click();
  assert.equal(await page.locator("#intake-form [name='learnProduct']").isChecked(), true);
  assert.equal(await page.locator("#intake-form [name='product']").inputValue(), product);
  assert.equal(await page.locator("#intake-form [name='specLength']").inputValue(), "18cm");
  await page.locator("#intake-form button[type='submit']").click();
  await page.locator("#intake-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction((serial) => JSON.parse(localStorage.getItem("production-board-demo-v2")).jobs.some(job => job.serialNo === serial), "MEM-QA-ORIGINAL");
  data = await saved();
  const memoryRaw = data.settings.intakeLearningRules;
  const memoryRules = typeof memoryRaw === "string" ? JSON.parse(memoryRaw) : memoryRaw;
  assert.equal(memoryRules.length, 1, "approval remembers the unchanged confirmed product");
  assert.equal(memoryRules[0].confirmed, true);
  assert.equal(memoryRules[0].customer, customer);
  assert.equal(memoryRules[0].target.specLength, "18cm");
  assert.equal(memoryRules[0].target.bladeWidth, "3mm");
  assert.equal(JSON.stringify(memoryRules).includes("MEM-QA-ORIGINAL"), false, "order serial is not remembered");

  await selectQaView(page, "intake");
  await openTextImport();
  await page.locator("#text-import-engine").selectOption("auto");
  assert.equal(await page.locator("#text-import-engine").inputValue(), "auto");
  await page.locator("#text-import-subject").fill("記憶QA 再注文2行");
  await page.locator("#text-import-body").fill(repeatedText);
  await page.locator("#text-import-form button[type='submit']").click();
  await page.locator("#import-dialog").waitFor({ state: "hidden" });
  const repeatCards = page.locator(".intake-card").filter({ hasText: "記憶QA 再注文2行" });
  await repeatCards.first().waitFor();
  assert.equal(await repeatCards.count(), 2, "same product stays as two separate candidates");
  for (const [serial, quantity, dueDate] of [["MEM-QA-2A", "11", "2027-01-06"], ["MEM-QA-2B", "4", "2027-02-06"]]) {
    const item = (await saved()).intake.find(candidate => candidate.parsed?.serialNo === serial);
    assert.ok(item, `${serial} exists`);
    assert.equal(item.status, "pending");
    assert.equal(item.parsed.quantity, Number(quantity));
    assert.equal(item.parsed.dueDate, dueDate);
    assert.equal(item.parsed._memory.version, 1);
    assert.match(item.originalText, /品名: ケリソン18cm上向3mm/);
  }
  assert.equal(await repeatCards.getByText("AIなし・要確認", { exact: true }).count(), 2);

  await repeatCards.first().getByRole("button", { name: "内容を確認する" }).click();
  assert.match(await page.locator("#intake-learning-feedback").innerText(), /AIなしで読み取りました/);
  assert.match(await page.locator("#intake-source-preview").innerText(), /数量: 11/);
  await page.locator("[data-action='close-intake-dialog']").click();
  await page.locator("#intake-dialog").waitFor({ state: "hidden" });

  await openTextImport();
  await page.locator("[data-action='open-intake-learning']").click();
  const memoryDialog = page.locator("#intake-learning-dialog");
  await memoryDialog.waitFor({ state: "visible" });
  assert.match(await page.locator("#intake-learning-list").innerText(), /18cm/);
  assert.match(await page.locator("#intake-learning-list").innerText(), /3mm/);
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 1024 });
    await assertNoOverflow("#intake-learning-dialog");
    await page.screenshot({ path: path.join(output, `${label}-memory-${width}.png`), fullPage: true });
  }
  await page.locator("[data-action='forget-intake-learning']").click();
  await page.getByText("覚えた製品の補完はありません。", { exact: true }).waitFor();
  assert.equal(JSON.parse((await saved()).settings.intakeLearningRules).length, 0);
  await memoryDialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await memoryDialog.waitFor({ state: "hidden" });

  await page.locator("#text-import-subject").fill("記憶QA 解除後");
  await page.locator("#text-import-body").fill(repeatedText);
  await page.locator("#text-import-form button[type='submit']").click();
  await page.locator("#text-import-error").waitFor({ state: "visible" });
  assert.match(await page.locator("#text-import-error").innerText(), /QAでは外部AIを呼び出せません/);
  assert.equal(await page.locator("#text-import-body").inputValue(), repeatedText, "failed fallback retains the pasted order");
  assert.equal(await page.locator("#import-dialog").evaluate(el => el.open), true);
  assert.equal(await page.locator(".intake-card").filter({ hasText: "記憶QA 解除後" }).count(), 0);
  assert.deepEqual(externalRequests, [], "no external network request occurred");
  await page.screenshot({ path: path.join(output, `${label}-fallback-error.png`), fullPage: true });
}, { paths: ["/src/index.html", "/dist/Index.html"] });
