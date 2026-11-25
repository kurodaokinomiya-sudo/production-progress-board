/** Capture the saved release bundle with fictional data and no live network. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { selectQaView, waitForQaReady } from './browser-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const edition = '2026-11-20';
const release = 'output/release-2026-11-20-stock-width';
const bundleDir = path.join(root, release, 'deployed-version/download');
const entries = ['/Index.html', '/Access.html'];
const bundles = new Map(await Promise.all(entries.map(async (entry) => [entry, await readFile(path.join(bundleDir, entry.slice(1)))])));
const { versionNumber: version } = JSON.parse(await readFile(path.join(root, release, 'version.json'), 'utf8'));
const captureFolder = `${edition}-v${version}`;
const bundleSha256 = createHash('sha256').update(bundles.get('/Index.html')).digest('hex');
const accessSha256 = createHash('sha256').update(bundles.get('/Access.html')).digest('hex');
const viewport = { width: 1180, height: 940 };
const deviceScaleFactor = 2;
const origin = 'http://127.0.0.1:4173';
const fixturePath = 'tools/manual-screenshots-fixture.js';
const fixture = await readFile(path.join(root, fixturePath), 'utf8');
const out = path.join(root, 'docs/manual-screenshots', captureFolder);
await mkdir(out, { recursive: true });
const captureOnly = new Set((process.env.MANUAL_CAPTURE_ONLY || '').split(',').map(name => name.trim()).filter(Boolean));
const manifestPath = path.join(out, 'manifest.json');
const previous = captureOnly.size ? JSON.parse(await readFile(manifestPath, 'utf8')) : null;
if (previous && (previous.bundleSha256 !== bundleSha256 || previous.accessSha256 !== accessSha256)) {
  throw new Error('The saved release changed. Regenerate all screenshots together.');
}
const manifest = previous?.images || {};
const channel = process.env.MANUAL_BROWSER_CHANNEL || 'chrome';
const browser = await chromium.launch(channel === 'chromium' ? {} : { channel });
const context = await browser.newContext({
  viewport, deviceScaleFactor, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: 'light', serviceWorkers: 'block',
});
await context.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
  if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
    return route.fulfill({ status: 200, body: '', contentType: 'text/css' });
  }
  if (url.origin !== origin) return route.abort('blockedbyclient');
  if (bundles.has(url.pathname)) {
    return route.fulfill({ body: bundles.get(url.pathname), contentType: 'text/html; charset=utf-8' });
  }
  if (url.pathname.startsWith('/api/local/')) return route.fulfill({ json: {} });
  return route.fulfill({ status: 404 });
});
await context.addInitScript(() => localStorage.setItem('production-board-theme', 'light'));
const page = await context.newPage();
await page.clock.setFixedTime(new Date(`${edition}T01:00:00Z`));
page.setDefaultTimeout(12000);
const errors = [];
let captureRole = null;
page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack);});
async function load(role='editor',extra='') {
  await page.goto(`${origin}/Index.html?role=${role}${extra}`,{waitUntil:'domcontentloaded'});
  await waitForQaReady(page);
  await page.addScriptTag({content:fixture});
  await page.waitForFunction(r=>document.documentElement.dataset.manualReady===r,role);
  assert.equal(await page.evaluate(() => state.access.role), role);
  captureRole = role;
  await page.evaluate(()=>window.scrollTo(0,0));
}
async function shot(name, selector, caption, markers = []) {
  if (captureOnly.size && !captureOnly.has(name)) return;
  const target = selector ? page.locator(selector).first() : null;
  if (target) await target.scrollIntoViewIfNeeded();
  else await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  const bounds = target ? await target.boundingBox() : { x: 0, y: 0, ...page.viewportSize() };
  const focus = [];
  for (const [step, locator] of markers) {
    const element = page.locator(locator).first();
    const { x, y, width, height } = await element.boundingBox();
    const box = [x - bounds.x, y - bounds.y, x + width - bounds.x, y + height - bounds.y];
    if (box[0] < -1 || box[1] < -1 || box[2] > bounds.width + 1 || box[3] > bounds.height + 1) {
      throw new Error(`Marker ${step} is outside ${name}: ${box}`);
    }
    focus.push({ step, box: box.map(point => Math.round(point * deviceScaleFactor)) });
  }
  const file = `${name}.jpg`;
  const options = { path: path.join(out, file), type: 'jpeg', quality: 92, animations: 'disabled' };
  if (target) await target.screenshot(options);
  else await page.screenshot(options);
  manifest[name] = { file: `${captureFolder}/${file}`, caption, ...(captureRole && { role: captureRole }) };
  if (focus.length) manifest[name].focus = focus;
  console.log(`captured ${name}`);
}
try {
  await load('worker');
  assert.deepEqual(
    await page.locator('#main-navigation [data-view]:visible').evaluateAll(tabs => tabs.map(tab => tab.dataset.view)),
    ['orders', 'completed', 'distribution', 'settings'],
  );
  await shot('ledger',null,'工程一覧　作業員の画面');
  await shot('worker-navigation', '#main-navigation', '作業者（作業員）のタブ');
  await shot('ledger-toolbar', '[data-view-panel="orders"] .ledger-toolbar', '工程一覧のタブと表示倍率');
  await page.locator('[data-view-panel="orders"] .ledger-filters summary').click();
  await shot('filters','[data-view-panel="orders"] .ledger-filters .filter-row','検索と並び順は一覧ごとに設定');
  await shot('filters-focus', '[data-view-panel="orders"] .workspace-sort', '第1から第3条件と昇順・降順');
  await page.locator('[data-view-panel="orders"] .ledger-filters summary').click();
  await page.locator('[data-view-panel="orders"] [data-ledger-zoom="progress"]').click();
  await shot('zoom',null,'品名と連番と5工程を160%で表示');
  await shot('ledger-focus', '#orders-workspace .ledger-category-group', '品名・連番と各工程の担当・状態');
  await page.locator('[data-view-panel="orders"] [data-ledger-rows="33"]').click();
  await page.evaluate(()=>openProcessDialog(state.jobs.find(j=>j.id==='SAMPLE-001'),'welding'));
  await shot('process','#process-dialog','工程ごとの状態と担当を選び、工程を保存', [
    [1, '#process-dialog .stage-edit-row[data-stage-key="welding"] [data-status="working"]'],
    [2, '#process-dialog .stage-edit-row[data-stage-key="welding"] [data-assignee="豊"]'],
    [3, '#process-form button[type="submit"]'],
  ]);
  const bulkButton = page.locator('#process-dialog [data-assignee="豊"]').first();
  await bulkButton.hover(); await page.mouse.down(); await page.waitForTimeout(750);
  await shot('bulk-held','#process-dialog','押したまま上の全へ移動して離す');
  await page.mouse.up();
  await page.locator('#process-dialog [data-assignee="豊"]').first().press('Alt+ArrowUp');
  await shot('bulk','#process-dialog','全工程への反映と 直前の一括変更を戻す');
  await page.getByRole('button',{name:'工程画面を閉じる',exact:true}).click();
  await shot('discard','#discard-dialog','入力を変更して閉じるときの3つの選択肢');
  await page.getByRole('button',{name:'編集を続ける',exact:true}).click();
  await page.locator('#process-form').getByRole('button',{name:'工程を保存',exact:true}).click();
  await page.locator('#process-dialog').waitFor({state:'hidden'});
  await page.evaluate(()=>openProcessDialog(state.jobs.find(j=>j.id==='SAMPLE-004'),'finish'));
  await shot('final-finish','#process-dialog','全数戻り後に最終仕上げの完了を選ぶ');
  await page.getByRole('button',{name:'工程画面を閉じる',exact:true}).click();
  await selectQaView(page,'distribution');
  await page.locator('#distribution-month').fill('2026-11');
  await page.locator('#distribution-end-month').fill('2026-11');
  await page.locator('#distribution-end-month').press('Tab');
  await page.locator('#distribution-sort').selectOption('serial');
  await shot('distribution',null,'月→連番順で鋭匙鉗子の配布担当を確認', [
    [1, '.distribution-month-control'],
    [2, '#distribution-sort'],
    [3, '#distribution-workspace [data-distribution-assignee]:not([data-distribution-assignee=""])'],
    [4, '#distribution-print-button'],
  ]);
  await shot('distribution-controls', '.distribution-toolbar', '納期の期間と月→連番順');
  await selectQaView(page,'settings');
  await shot('theme','[data-view-panel="settings"] .settings-panel:has(.theme-options)','表示モードはこの端末に保存');
  await load('editor');
  assert.deepEqual(
    await page.locator('#main-navigation [data-view]:visible').evaluateAll(tabs => tabs.map(tab => tab.dataset.view)),
    ['dashboard', 'orders', 'completed', 'distribution', 'polishing', 'materials', 'finishedStock', 'intake', 'settings'],
  );
  if (!captureOnly.size || captureOnly.has('editor-navigation')) {
    await page.setViewportSize({ ...viewport, width: 1480 });
    await page.waitForFunction(() => {
      const nav = document.getElementById('main-navigation');
      return nav.scrollWidth <= nav.clientWidth;
    });
    await shot('editor-navigation', '#main-navigation', '編集者のタブ');
    manifest['editor-navigation'].viewport = page.viewportSize();
    await page.setViewportSize(viewport);
  }
  await selectQaView(page,'dashboard');
  await shot('dashboard',null,'概況から納期注意や出荷待ちへ進む');
  await selectQaView(page,'completed');
  await page.locator('[data-view-panel="completed"] [data-ledger-scale]').fill('90');
  await page.locator('[data-view-panel="completed"] [data-ledger-scale]').press('Tab');
  await shot('completed',null,'完成品リストの上段は出荷待ち 下段は出荷済み');
  await page.evaluate(()=>openProcessDialog(state.jobs.find(j=>j.id==='SAMPLE-005'),'finish'));
  await shot('shipping','#process-dialog','最終仕上げと出荷の状態を確認');
  await page.getByRole('button',{name:'工程画面を閉じる',exact:true}).click();
  await selectQaView(page,'orders');
  await page.getByRole('button',{name:'案件を追加',exact:true}).click();
  await shot('new-order','#order-dialog','案件の追加画面');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>openOrderDialog(state.jobs.find(j=>j.id==='SAMPLE-T01')));
  await shot('order-stock','#order-dialog','数量は製造総数 うち在庫予定はその内数');
  await page.keyboard.press('Escape');
  await page.locator('[data-action="open-import"]').first().click();
  assert.equal(await page.locator('#import-email-tab').isVisible(), false);
  assert.equal(await page.locator('[data-action="diagnose-ai"]').isVisible(), false);
  await shot('import','#import-dialog','注文の取り込み方法を選ぶ');
  await page.keyboard.press('Escape');
  await selectQaView(page,'intake');
  await shot('intake',null,'取込キューで内容を確認してから案件へ反映');
  await page.evaluate(()=>openIntakeDialog(state.intake[0]));
  await shot('intake-review','#intake-dialog','原文と読み取った得意先・品名・数量・納期を照合');
  await page.locator('#intake-dialog .intake-learning-options').scrollIntoViewIfNeeded();
  await shot('intake-learning','#intake-dialog .intake-learning-options','数量や納期は毎回確認し 製品に共通する修正だけを覚える');
  await page.keyboard.press('Escape');
  await page.locator('[data-action="open-label-print"]').first().click();
  await page.locator('[data-action="clear-label-selection"]').click();
  await page.locator('#label-job-list [data-label-job-id="SAMPLE-001"]').check();
  await page.locator('#label-job-list [data-label-job-id="SAMPLE-007"]').check();
  await shot('labels','#label-dialog','印刷対象とプレビューを確認');
  await shot('labels-detail', '#label-preview-list .product-label', '品名・型・刃幅などを印刷プレビューで確認');
  await page.locator('[data-action="print-labels"]').click();
  await page.locator('#label-print-result').waitFor({state:'visible'});
  await shot('labels-confirm','#label-print-result','印刷できたことを確認してから待ちから外す');
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => document.body.classList.add('is-printing-labels'));
  await shot('labels-print', '#label-print-sheet', 'A4縦に配置する実際のラベル印刷用レイアウト');
  await page.evaluate(() => document.body.classList.remove('is-printing-labels'));
  await page.emulateMedia({ media: 'screen' });
  await page.keyboard.press('Escape');
  await selectQaView(page,'polishing');
  await page.locator('[data-polishing-select-id="SAMPLE-002"]').check();
  await shot('polishing',null,'研磨屋にある製品と戻り日の指定');
  await page.locator('#polishing-filter').selectOption('all');
  await page.locator('[data-polishing-row="SAMPLE-004"] .polishing-history summary').click();
  await shot('polishing-history','[data-polishing-row="SAMPLE-004"]','戻り取消と日付編集を履歴から選ぶ');
  await page.locator('[data-polishing-row="SAMPLE-004"] [data-action="edit-polishing-date"]').first().click();
  await shot('polishing-date','#polishing-dialog','発送日と戻り日は履歴から訂正');
  await page.keyboard.press('Escape');
  await page.locator('[data-polishing-row="SAMPLE-002"] .polishing-history summary').click();
  await page.locator('[data-action="cancel-polishing-send"][data-order-id="SAMPLE-002"]').click();
  await shot('polishing-cancel','#polishing-dialog','発送取消の数量と対象を確認');
  await page.keyboard.press('Escape');
  await page.locator('#polishing-billing-month').fill('2026-10');
  await page.locator('#polishing-billing-month').press('Tab');
  await page.getByText(/2026-10 の戻り/).waitFor();
  assert.equal(await page.locator('#polishing-rate-settings').isVisible(), false);
  await shot('polishing-billing','.polishing-billing','戻り月ごとの研磨代');
  await page.locator('[data-polishing-row="SAMPLE-008"] [data-polishing-class-id]').selectOption('自由設定');
  await shot('polishing-custom','[data-polishing-row="SAMPLE-008"]','自由設定では製品ごとに江部と嘉代の単価を保存');
  await load('editor');
  await selectQaView(page,'materials');
  await page.evaluate(() => refreshMaterialInventory());
  await page.locator('[data-material-action="receive"]').first().waitFor();
  await shot('materials',null,'現在庫と発注残を確認');
  await page.locator('[data-material-action="order"]').first().click();
  await shot('material-order','#material-dialog','発注数と入庫予定日を記録');
  await page.keyboard.press('Escape');
  await shot('material-orders','.material-panel:has(#material-order-rows)','同じ発注に分納履歴と残数をまとめて表示');
  await page.locator('[data-material-action="receive"]').first().click();
  await shot('material-receive','#material-dialog','実際に届いた数量だけを入庫');
  await page.keyboard.press('Escape');
  await page.locator('[data-material-action="adjust"]').first().click();
  await shot('material-adjust','#material-dialog','棚卸差は増減数量と理由を残して調整');
  await page.keyboard.press('Escape');
  await page.locator('[data-material-action="editOrder"]').first().click();
  await shot('material-order-edit', '#material-dialog', '入庫済数を確認して発注数量と入庫予定日を直す');
  await page.keyboard.press('Escape');
  await page.locator('[data-material-stock-note]').first().fill('保管棚B');
  await shot('material-note', '.material-note-editor', '材料の行で備考を入力し、保存');
  await page.locator('[data-material-action="stockNote"]').first().click();
  await page.locator('[data-material-action="stockNote"]').first().waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    await api.saveJob({
      id: 'SAMPLE-M01', requestId: 'manual-material-exclusion-job', customer: '見本医科',
      product: '慈大式彫骨器 試作', productCode: 'CK099', quantity: 2, serialNo: '見本-M01',
      dueDate: '2026-11-27', category: '鋭匙鉗子',
    });
    await refreshData();
  });
  await page.locator('[data-material-action="exclude"][data-material-job="SAMPLE-M01"]').click();
  await shot('material-exclusion-dialog', '#material-dialog', '得意先・品名・仕様を確認して対象外として登録');
  await page.locator('#material-submit').click();
  await page.locator('#material-dialog').waitFor({ state: 'hidden' });
  await page.locator('#material-exclusions summary').click();
  await shot('material-exclusions', '#material-exclusions', '登録した碓井材料の対象外製品と、登録を取り消す操作');
  await selectQaView(page,'finishedStock');
  await shot('stock-overview',null,'Tezoeの現在庫と出荷見込');
  await page.locator('[data-stock-action="note"][data-product-id="26001"]').click();
  await page.locator('#finished-stock-dialog textarea[name="note"]').fill('保管棚C\n次回の出荷前に検品');
  await shot('stock-note', '#finished-stock-dialog', 'Tezoe製品ごとの備考を保存', [
    [2, '#finished-stock-dialog textarea[name="note"]'],
    [3, '#finished-stock-submit'],
  ]);
  await page.locator('#finished-stock-submit').click();
  await page.locator('#finished-stock-dialog').waitFor({ state: 'hidden' });
  await shot('stock-orders','.material-panel:has(#finished-stock-order-rows)','受注ごとに在庫分と製造分を確認');
  await page.locator('[data-stock-action="schedule"]').first().click();
  await shot('stock-schedule','#finished-stock-dialog','注文数量と在庫から出す累計数量を設定');
  await page.keyboard.press('Escape');
  await shot('stock-plans','.material-panel:has(#finished-stock-plan-rows)','製造総数と受注分と在庫追加分を確認');
  await page.locator('[data-stock-action="receive"]:enabled').first().click();
  await shot('stock-receive','#finished-stock-dialog','完成した在庫分をロットとして入庫');
  await page.keyboard.press('Escape');
  await page.locator('[data-stock-action="ship"][data-order-job-id="SAMPLE-T01"]').click();
  await shot('stock-ship','#finished-stock-dialog','対象の受注とロットと実際の出荷数量を確認');
  await page.keyboard.press('Escape');
  await page.locator('[data-stock-action="reverse"]').first().click();
  await shot('stock-reverse','#finished-stock-dialog','元の記録と取消理由を確認');
  await page.keyboard.press('Escape');
  await shot('stock-history','.material-panel:has(#finished-stock-history-rows)','履歴から元の記録を確認して取り消す');
  await page.evaluate(async()=>{
    let job=await api.saveJob({id:'SAMPLE-T03',requestId:'manual-stock-only-job',customer:'見本医科',product:'Tezoe スタンツェ 直・上向',productCode:'26001',quantity:1,stockPlannedQuantity:0,serialNo:'見本-T03',dueDate:'2026-11-03'});
    await api.saveFinishedStockSchedule({requestId:'manual-stock-only-schedule',expectedVersion:(await api.getFinishedStock()).version,jobId:job.id,jobVersion:job.version,orderQuantity:2,stockQuantity:2,shipmentMode:'split',shipDate:'2026-10-30'});
    job=await api.saveJob({...job,requestId:'manual-stock-only-zero',quantity:0});
    await api.shipFinishedStock({requestId:'manual-stock-only-ship',expectedVersion:(await api.getFinishedStock()).version,productId:'26001',orderJobId:job.id,jobVersion:job.version,quantity:2,date:'2026-10-30',purpose:'sale'});
    await refreshData(); await finishedStockUi.refresh();
  });
  await shot('stock-only','.material-panel:has(#finished-stock-order-rows)','全数在庫で出荷し製造総数が0の受注は受注履行完了');
  const customId = await page.evaluate(async () => {
    const job = await api.saveJob({
      id: 'SAMPLE-C01', requestId: 'manual-stock-custom-job', customer: '見本医科',
      product: 'Tezoe 特注スタンツェ', productCode: '26031', category: 'ケリソンパンチ', specLength: '21cm',
      specShape: '側弯・上向', quantity: 4, stockPlannedQuantity: 0, dueDate: '2026-11-27', serialNo: '見本-C01',
    });
    await refreshData();
    await finishedStockUi.refresh();
    return FinishedStock.productFor(job).id;
  });
  await page.locator('[data-stock-action="opening"]').first().click();
  await page.locator('#finished-stock-dialog select[name="productId"]').selectOption(customId);
  await page.locator('#finished-stock-dialog input[name="quantity"]').fill('0');
  await page.locator('#finished-stock-dialog textarea[name="note"]').fill('現物を確認。在庫なし');
  await shot('stock-custom', '#finished-stock-dialog', '案件に保存した特注製品を選び、現物がなければ0で登録', [
    [2, '#finished-stock-dialog select[name="productId"]'],
    [3, '#finished-stock-dialog input[name="quantity"]'],
  ]);
  await page.locator('#finished-stock-submit').click();
  await page.locator('#finished-stock-dialog').waitFor({ state: 'hidden' });
  await page.locator('#finished-stock-rows').getByText('26031', { exact: true }).waitFor({ state: 'visible' });
  await page.locator('[data-stock-action="opening"]').first().click();
  await shot('stock-opening','#finished-stock-dialog','手元の在庫を数えて追加');
  await page.keyboard.press('Escape');
  await load('worker','&case=error');
  await page.evaluate(()=>openProcessDialog(state.jobs.find(j=>j.id==='SAMPLE-001'),'welding'));
  await page.locator('#process-form [data-stage-key="welding"] [data-status="working"]').click();
  await page.locator('#process-form').getByRole('button',{name:'工程を保存',exact:true}).click();
  await page.waitForTimeout(450);
  await shot('save-error','#toast-stack','保存失敗の表示から入力を復元して再試行');
  await page.goto(`${origin}/Access.html`,{waitUntil:'domcontentloaded'});
  captureRole = null;
  await shot('login','.access-card','初回にメールアドレスと8桁の確認コードを入力');
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  const report = {
    capturedAt: edition, localDemoOnly: true, entry: 'Index.html', version, bundleSha256, accessSha256,
    fixture: fixturePath, viewport: { ...viewport, deviceScaleFactor }, images: manifest, errors,
  };
  await writeFile(manifestPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({count:Object.keys(manifest).length,errors}));
} finally {await context.close();await browser.close();}
