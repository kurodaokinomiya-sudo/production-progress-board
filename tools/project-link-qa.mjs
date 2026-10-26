import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, qaBaseUrl } from "./browser-runtime.mjs";
const scriptId = "synthetic-qa-script";
const expected = `https://script.google.com/home/projects/${scriptId}/edit`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
await context.route(/https:\/\/fonts\./, (route) => route.fulfill({ body: "" }));
await context.route("**/api/local/project-info", (route) => route.fulfill({ json: { scriptEditorUrl: expected } }));
// Confirm the navigation target without modifying or authenticating to Google.
await context.route("https://script.google.com/**", (route) => route.fulfill({ body: "Editor navigation target verified (mock page)." }));
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const url = await qaBaseUrl("/dist/Index.html");
try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator("[data-view='settings']").click();
  const link = page.locator("#script-editor-link");
  assert.equal(await link.getAttribute("href"), expected);
  assert.equal(await link.isVisible(), true);
  const popupEvent = page.waitForEvent("popup");
  await link.click();
  const popup = await popupEvent;
  await popup.waitForLoadState();
  assert.equal(popup.url(), expected);
  assert.equal(page.url(), url);
  await popup.close();
  await mkdir("output/playwright", { recursive: true });
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(dimensions.scroll <= dimensions.client);
    assert.equal(await link.isVisible(), true);
    await page.screenshot({ path: `output/playwright/project-link-${width}.png`, fullPage: true });
  }
  await page.route("**/api/local/project-info", (route) => route.fulfill({ json: { scriptEditorUrl: "javascript:alert(1)" } }));
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await link.getAttribute("href"), null);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator("[data-view='settings']").click();
  assert.equal(await link.isVisible(), false);
  assert.equal(await page.locator("#script-editor-unavailable").isVisible(), true);
  assert.deepEqual(errors, []);
  console.log("Project link QA PASS: synthetic project target, separate tab (navigation mocked), invalid URL hidden, 320/768/1280px, no page errors.");
} finally { await browser.close(); }
