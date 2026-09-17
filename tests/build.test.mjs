import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, sourceHtml, css, tokens, script, config, repository, importer] = await Promise.all([
  readFile(new URL("../dist/Index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../tokens.css", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../apps-script/Config.gs", import.meta.url), "utf8"),
  readFile(new URL("../apps-script/Repository.gs", import.meta.url), "utf8"),
  readFile(new URL("../apps-script/Import.gs", import.meta.url), "utf8"),
]);

test("Apps Script用HTMLはCSSとJSを内包する", () => {
  assert.match(html, /data-bundle="tokens"/);
  assert.match(html, /data-bundle="styles"/);
  assert.match(html, /data-bundle="app"/);
});

test("Hallmarkのレスポンシブ最低条件を満たす", () => {
  assert.match(css, /html,[\s\S]*body[\s\S]*overflow-x:\s*clip/);
  assert.match(css, /white-space:\s*nowrap/);
  assert.match(css, /@media \(min-width: 40rem\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /transition:\s*all/);
  assert.doesNotMatch(css, /width:\s*100vw/);
});

test("テーマはトークン経由で利用する", () => {
  assert.match(tokens, /macrostructure: Index-First/);
  assert.match(tokens, /designed-as-app: yes/);
  assert.match(tokens, /Big Shoulders Display/);
  assert.match(tokens, /--color-accent-ink:/);
  assert.match(tokens, /--font-display:/);
  assert.match(tokens, /html\[data-theme="dark"\]/);
  assert.match(tokens, /--color-dark-surface:/);
  assert.match(script, /production-board-theme/);
  assert.match(html, /data-theme-choice="auto"/);
  assert.match(html, /data-theme-choice="dark"/);
  assert.doesNotMatch(css.replace('@import url("../tokens.css");', ""), /#[0-9a-f]{3,8}/i);
});

test("今月完了と工程専用ダイアログのボタン担当選択を表示・保存する", () => {
  assert.match(html, /今月完了/);
  assert.doesNotMatch(html, /本日完了/);
  assert.match(html, /id="completed-period"/);
  assert.match(html, /<option value="current">今月<\/option>/);
  assert.match(script, /period: "current"/);
  assert.match(script, /showCompleted\("current"\)/);
  assert.match(html, /工程と担当/);
  assert.match(html, /id="process-dialog"/);
  assert.match(html, /id="process-stage-editor"/);
  assert.match(script, /data-action="open-process"/);
  assert.match(script, /data-action="edit-order"/);
  assert.match(script, /isInCurrentMonth\(job\.completedAt\)/);
  assert.match(script, /const ASSIGNEES = \["豊", "幹", "望", "鈴", "河", "誠", "小", "保", "大", "順"\]/);
  assert.match(script, /class="assignee-trigger"/);
  assert.match(script, /class="assignee-option/);
  assert.match(script, /stage-assignee-input/);
  assert.match(script, /stage-assignee-input" type="hidden"/);
  assert.doesNotMatch(script, /stage-assignee-input" type="text"/);
  assert.match(script, /const assignee = qs\("\.stage-assignee-input", row\)/);
  assert.match(script, /stages\[row\.dataset\.stageKey\] = \{ status:[^}]+assignee \}/);
  assert.match(script, /label: "元作り"/);
  assert.match(script, /label: "浮き止め～立ち上がり"/);
  assert.match(script, /label: "厚みとり"/);
  assert.match(script, /label: "仕上げ"/);
  assert.match(html, /<span>刃幅<\/span>/);
  assert.match(repository, /completedAt:\s*completed \?/);
  assert.match(importer, /migratedJob\.completedAt = ""/);
  assert.match(config, /"version", "completedAt"/);
});

test("出荷完了した案件を終了リストへ分離し、進行中へ戻せる", () => {
  assert.match(html, /data-view="completed"/);
  assert.match(html, /data-view-panel="completed"/);
  assert.match(html, /id="process-lifecycle-action"/);
  assert.match(script, /form\.dataset\.shippingStatus = "shipped"/);
  assert.match(script, /form\.dataset\.shippingStatus = "waiting"/);
  assert.match(script, /form\.dataset\.afterSaveView = "completed"/);
  assert.match(script, /completedScope !== \(job\.shippingStatus === "shipped"\)/);
  assert.match(script, /renderCompletedWorkspace\(\)/);
  assert.match(script, /shipped \? "進行中へ戻す" : "出荷完了・終了へ"/);
  assert.doesNotMatch(script, /全工程完了後に使用/);
  assert.match(script, /formatDateTime\(job\.completedAt \|\| job\.updatedAt\)/);
  assert.match(script, /orderCards\(jobs, \{ completed: true \}\)/);
});

test("仕様と5工程を省略せず、各工程から直接更新できる一覧を表示する", () => {
  assert.match(sourceHtml, /<th>全長<\/th><th>型<\/th><th>刃幅<\/th>/);
  for (const field of ["specLength", "specShape", "bladeWidth", "note"]) assert.ok(script.includes(`escapeHtml(job.${field} || "—")`));
  assert.match(script, /STAGES\.map\(\(stage\) => `<td class="cell-stage">\$\{stageCellButton\(job, stage\)\}/);
  assert.match(script, /data-stage-key="\$\{stage.key\}"/);
  assert.match(script, /class="order-specs"/);
  assert.match(script, /class="order-stage-grid"/);
});

test("状況台帳は重複一覧を持たず、対象案件の一覧へ直接つながる", () => {
  assert.match(html, /data-action="show-production-orders"/);
  assert.match(html, /data-action="show-due-orders"/);
  assert.match(html, /data-action="show-current-completed"/);
  assert.match(html, /data-action="show-shipping-orders"/);
  assert.match(html, /id="orders-attention-filter"/);
  assert.match(script, /showOrders\(\{ attention: "due" \}\)/);
  assert.match(script, /allJobs\.length > jobs\.length/);
  assert.doesNotMatch(html, /id="urgent-title"/);
  assert.doesNotMatch(script, /function renderUrgent/);
  assert.doesNotMatch(css, /\.urgent-panel|\.urgent-list|\.urgent-item/);
  assert.equal((sourceHtml.match(/data-action="open-label-print"/g) || []).length, 2);
});

test("業務日付と納期判定は端末設定に依存せず日本時間へ統一する", () => {
  assert.match(script, /const BUSINESS_TIME_ZONE = "Asia\/Tokyo"/);
  assert.match(script, /function businessDateKey/);
  assert.match(script, /timeZone: BUSINESS_TIME_ZONE/);
  assert.match(script, /daysUntil\(job\.dueDate\) <= 2/);
  assert.doesNotMatch(script, /getTimezoneOffset/);
  assert.match(repository, /Asia\/Tokyo/);
});

test("タブレットの状況台帳は5項目を均等配置する", () => {
  assert.match(css, /@media \(min-width: 40rem\) and \(max-width: 59\.999rem\)[\s\S]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)[\s\S]*\.summary-item-label \{[\s\S]*grid-column: auto/);
});

test("新旧の工程見出しと刃幅を移行時に読み込める", () => {
  assert.match(importer, /bladeWidth: \["刃幅", "刃巾"\]/);
  assert.match(importer, /base: \["元作り", "元づくり", "元造り"\]/);
  assert.match(importer, /"浮き止め～立ち上がり"/);
  assert.match(importer, /heat: \["厚みとり", "焼なとり", "焼なまし"\]/);
  assert.match(importer, /finish: \["仕上げ", "仕上"\]/);
});

test("旧版の案件シートには完了日時・大分類などの新列だけを末尾追加できる", () => {
  assert.match(config, /var prefixMatches = current\.every/);
  assert.match(config, /var additions = headers\.slice\(current\.length\)/);
  assert.match(config, /sheet\.getRange\(1, current\.length \+ 1, 1, additions\.length\)\.setValues/);
});

test("品名から大分類と仕様を補完し、未判定は確認可能なまま残す", () => {
  assert.match(html, /<span>大分類<\/span><select name="category">/);
  assert.match(html, /未分類（要確認）/);
  assert.match(html, /鋭匙鉗子/);
  assert.match(html, /ケリソンパンチ/);
  assert.match(script, /function classifyProductCategory\(product\)/);
  assert.match(script, /ケリソン\|ケリパンチ\|スタンツェ\|スタンチェ[\s\S]*彫骨器/);
  assert.match(script, /if \(\/鉗子\/\.test\(name\)\) return "鋭匙鉗子"/);
  assert.match(script, /function inferSpecsFromProductName\(product, existing = \{\}\)/);
  assert.match(script, /Object\.assign\(values, inferOrderMetadata\(values\.product, values\)\)/);
  assert.match(repository, /category:\s*normalizeCategory_/);
  assert.match(config, /"completedAt", "category"/);
  assert.match(importer, /category: \["大分類", "分類", "製品分類"\]/);
});

test("案件削除は物理削除せず、更新番号付きの非表示化と復元を行う", () => {
  assert.match(html, /id="order-delete-action"/);
  assert.match(html, /data-action="delete-order"/);
  assert.match(script, /api\.setJobArchived\(\{ id, version, archived: true \}\)/);
  assert.match(script, /label: "元に戻す"/);
  assert.match(script, /archived: false/);
  assert.match(repository, /function setJobArchived\(input\)/);
  assert.match(repository, /job\.archived = input\.archived === true/);
  assert.match(repository, /!isArchivedValue_\(record\.archived\)/);
  assert.match(repository, /!job\.archived && job\.sourceRef === item\.sourceRef/);
  assert.doesNotMatch(repository, /deleteRow\(/);
});

test("大分類・連番などをPCとタブレットで同じ操作から並び替えられる", () => {
  assert.match(html, /id="dashboard-sort"/);
  assert.match(html, /id="orders-sort"/);
  assert.match(html, /id="completed-sort"/);
  assert.match(html, /<option value="category">大分類<\/option>/);
  assert.match(html, /<option value="serial">連番<\/option>/);
  assert.match(html, /class="filter-field-label">並び順<\/span>/);
  assert.match(script, /new Intl\.Collator\("ja", \{ numeric: true/);
  assert.match(script, /function sortedJobs\(scope\)/);
  assert.match(script, /category:\s*compareCategory/);
  assert.match(script, /serial:\s*\(a, b\) => compareTextBlankLast/);
  assert.match(script, /renderSortState/);
  assert.match(script, /aria-sort/);
  assert.match(script, /class="category-chip"/);
});

test("最大9件の製品ラベルを15cm×3cmでA4縦へ一括印刷できる", () => {
  assert.match(html, /id="label-dialog"/);
  assert.match(html, /A4縦・最大9枚/);
  assert.match(html, /data-action="open-label-print"/);
  assert.match(html, /id="label-print-sheet"/);
  assert.match(script, /const LABEL_PRINT_LIMIT = 9/);
  assert.match(script, /function productLabelMarkup\(job\)/);
  assert.match(script, /function formatLabelLength\(value\)/);
  assert.match(script, /return \[\.\.\.pendingJobs\(\)\]/);
  assert.match(script, /input:not\(\[type='hidden'\]\):not\(:disabled\)/);
  assert.match(script, /requestAnimationFrame\([\s\S]*window\.print\(\)/);
  assert.match(css, /@page\s*\{[\s\S]*size:\s*A4 portrait;[\s\S]*margin:\s*13\.5mm 30mm;/);
  assert.match(css, /grid-auto-rows:\s*30mm/);
  assert.match(css, /width:\s*150mm;[\s\S]*height:\s*30mm;/);
  assert.match(tokens, /--color-label-band:/);
  assert.match(tokens, /print delta: single-order view→maximum-nine 150mm-by-30mm product labels on A4 portrait/);
});

test("取込承認後の印刷待ち・印刷済み確認・ラベル変更時の再印刷を全端末で同期する", () => {
  assert.match(config, /"labelPrintStatus", "labelPrintedAt"/);
  assert.match(repository, /input\.order\.labelPrintStatus = "waiting"/);
  assert.match(repository, /function markLabelsPrinted\(input\)/);
  assert.match(repository, /job\.labelPrintStatus = "printed"/);
  assert.match(repository, /existing\.labelPrintStatus === "printed" && next\.labelPrintStatus !== "not_required" && labelContentChanged_/);
  assert.match(repository, /next\.labelPrintStatus = "reprint"/);
  assert.match(importer, /migratedJob\.labelPrintStatus = "not_required"/);
  assert.match(html, /id="metric-label"/);
  assert.match(html, /id="label-status-filter"/);
  assert.match(html, /id="label-print-result"/);
  assert.match(html, /印刷済みにする/);
  assert.match(script, /state\.labelPrintSelection = new Set\(labelQueueJobs\(\)\.slice\(0, LABEL_PRINT_LIMIT\)/);
  assert.match(script, /api\.markLabelsPrinted\(\{ jobs \}\)/);
  assert.match(script, /state\.labelPrintConfirmationVisible/);
});

test("自動補完値だけを品名変更時に更新し、ダイアログと取込タブをキーボード操作できる", () => {
  assert.match(script, /dataset\.autoFilled === "true"/);
  assert.match(script, /field\.dataset\.autoFilled = "true"/);
  assert.match(script, /value\[name\] === productInference\[name\]/);
  assert.match(script, /value === productInference\[name\]/);
  assert.match(script, /delete event\.target\.dataset\.autoFilled/);
  assert.match(script, /dialog\._returnFocus = document\.activeElement/);
  assert.match(script, /addEventListener\("cancel", \(event\) => \{ if \(!event.defaultPrevented\) restoreAfterDialogClose\(dialog\); \}\)/);
  assert.match(script, /addEventListener\("close", \(\) => restoreAfterDialogClose\(dialog\)\)/);
  assert.match(script, /focusTarget\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(html, /id="import-email-tab"[^>]+tabindex="-1"/);
  assert.match(script, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.doesNotMatch(script, /<tr data-order-id="\$\{escapeHtml\(job\.id\)\}" tabindex="0">/);
});

test("取込は確認キューを経由する", () => {
  assert.match(script, /createIntakeFromImage/);
  assert.match(script, /approveIntake/);
  assert.match(html, /自動で本登録しません/);
});

test("TC発注書の複数品目を個別の確認候補へ分割する", () => {
  assert.match(importer, /parseOrderItems_\(text/);
  assert.match(importer, /function createIntakeFromPdfText/);
  assert.match(importer, /createIntakeFromExtractedText_/);
  assert.match(importer, /":item:" \+ itemNumber/);
  assert.match(importer, /return \{ added: items\.length, items: items \}/);
  assert.match(importer, /intakeSubject_/);
  assert.match(script, /result\?\.added \|\| 1/);
  assert.match(script, /fetch\(isText \? "\/api\/local\/parse-order-text" : useAi \? "\/api\/local\/parse-order-ai" : "\/api\/local\/parse-order-pdf"/);
  assert.match(script, /LOCAL_PDF_ENGINE_VERSION/);
  assert.match(script, /古いローカル解析サーバーが動いています/);
  assert.match(script, /item\.importFileName !== payload\.name/);
  assert.match(script, /extractPdfTextInBrowser/);
  assert.match(script, /createIntakeFromPdfText/);
  assert.doesNotMatch(script, /ローカルプレビューではOCRを実行しません/);
});

test("Apps Script版へPDF.js本体とWorkerを同梱する", () => {
  assert.match(html, /data-bundle="pdfjs"/);
  assert.match(html, /pdfjsLib/);
  assert.match(html, /pdfjs-ready/);
  assert.match(html, /bundledPdfWorkerSource/);
});

test("複数端末からの更新と取込重複をサーバー側で止める", () => {
  assert.match(repository, /withDocumentLock_\(function\(\) \{ return saveJobUnlocked_\(input\); \}\)/);
  assert.match(repository, /row: row, rowNumber: index \+ 2/);
  assert.match(repository, /record\.sourceRef[\s\S]*input\.sourceRef/);
  assert.match(importer, /appendIntakeIfNew_/);
  assert.match(importer, /return withDocumentLock_\(function\(\) \{/);
});
