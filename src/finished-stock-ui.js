(function (root) {
  "use strict";
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const count = (value) => number(value).toLocaleString("ja-JP");
  const names = (value) => Array.isArray(value) ? value.filter(Boolean).join("・") : String(value || "");
  const date = (value) => value ? String(value).slice(0, 10) : "不明";
  const recordedAt = (value) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "不明";
  const errorMessage = (error) => String(error?.message || error).replace(/FINISHED_STOCK_INVALID:\s*/g, "");
  const empty = (n, value) => `<tr><td colspan="${n}" class="material-empty">${escape(value)}</td></tr>`;
  const button = (action, label, attributes = "") => `<button class="button button-secondary material-row-button" type="button" data-stock-action="${action}" ${attributes}>${label}</button>`;
  const ACTIONS = { opening: "手元の在庫追加", receive: "製造分の入庫", ship: "在庫から出荷", reverse: "記録の取消", schedule: "出荷予定を設定", completion: "完成予定日を設定" };
  const APIS = { opening: "openFinishedStock", receive: "receiveFinishedStock", ship: "shipFinishedStock", reverse: "reverseFinishedStock", schedule: "saveFinishedStockSchedule", completion: "saveFinishedStockSchedule" };

  function create(options = {}) {
    const doc = root.document;
    const q = (s) => doc.querySelector(s);
    const panel = q('[data-view-panel="finishedStock"]');
    const dialog = q("#finished-stock-dialog"), form = q("#finished-stock-form");
    let bound = false, snapshot = null, dirty = true, pending = false, reading = null, revision = 0, queued = false;
    let draft = null, attempt = null, overviewSignature = "", clearRevision = 0;
    const savedDrafts = new Map();
    const permitted = () => options.canEdit?.() === true;
    const today = () => options.today?.() || new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
    const product = (id) => snapshot?.products?.find((item) => item.id === id);
    const lot = (id) => snapshot?.lots?.find((item) => item.id === id);
    const field = (name) => form?.elements.namedItem(name);
    const text = (selector, value) => { const el = q(selector); if (el) el.textContent = value; };
    const status = (selector, value, tone = "") => { const el = q(selector); if (el) { el.textContent = value; el.dataset.tone = tone; } };
    const asof = () => q("#finished-stock-asof")?.value || today();
    const forecast = (id, until = asof()) => root.FinishedStockOrders.forecast(snapshot, id, until);
    const orderFor = (id) => snapshot?.orders?.find((entry) => entry.jobId === id);
    const nameFor = (id) => { const p = product(id); return p ? `${p.code} ${p.name}` : id; };
    const usable = () => permitted() && snapshot && !dirty && !pending && !reading;
    const unresolvedShipment = (productId) => [...savedDrafts.values()].find((saved) => saved.draft?.action === "ship" && saved.attempt?.unconfirmed && saved.values.productId === productId);

    function controls() {
      panel?.querySelectorAll("[data-stock-action]").forEach((el) => {
        if (el.dataset.stockAction === "job") { el.disabled = !permitted(); return; }
        if (el.dataset.stockAction === "refresh") el.disabled = !permitted() || pending || Boolean(reading);
        else el.disabled = !usable() || el.dataset.stockUnavailable === "true" && !(el.dataset.stockAction === "ship" && unresolvedShipment(el.dataset.productId));
      });
      form?.querySelectorAll("input, select, textarea, button").forEach((el) => { el.disabled = pending || !permitted() || Boolean(attempt?.unconfirmed && el.name); });
      form?.setAttribute("aria-busy", String(pending));
      text("#finished-stock-submit", pending ? "記録しています…" : attempt?.unconfirmed ? "前回の記録を確認する" : draft?.action === "reverse" ? "理由を残して取り消す" : "記録する");
    }

    function updateForecast() {
      for (const p of snapshot?.products || []) {
        const row = panel?.querySelector(`[data-stock-product="${p.id}"]`);
        if (!row) continue;
        const value = forecast(p.id);
        row.querySelector("[data-stock-add]").textContent = `＋${count(value.incomingQuantity)}`;
        row.querySelector("[data-stock-outgoing]").textContent = `−${count(value.outgoingQuantity)}${value.undatedOrderQuantity ? `（未定${count(value.undatedOrderQuantity)}）` : ""}`;
        const result = row.querySelector("[data-stock-forecast]");
        result.innerHTML = `${count(value.availableQuantity)}${value.futureReservedQuantity ? `<small>残数見込 ${count(value.quantity)} / 後日出荷分 ${count(value.futureReservedQuantity)}を確保</small>` : ""}`;
        result.classList.toggle("finished-stock-shortage", value.availableQuantity < 0);
      }
    }

    function paintOverview() {
      const signature = JSON.stringify([snapshot?.products, snapshot?.productions, snapshot?.orders]);
      if (signature !== overviewSignature) {
        overviewSignature = signature;
        q("#finished-stock-rows").innerHTML = (snapshot?.products || []).map((p) => {
          return `<tr data-stock-product="${escape(p.id)}"><th scope="row"><strong>${escape(p.code)}</strong><small>${escape(p.name.replace(/^Tezoe\s*/i, ""))}</small></th><td><strong class="finished-stock-number">${count(p.stockQuantity)}</strong>${p.stockRegistered ? "" : '<small class="finished-stock-warning">開始在庫未登録</small>'}</td><td>${count(p.orderQuantity)}</td><td>${count(p.reservedQuantity)}</td><td class="finished-stock-number">${count(p.availableQuantity)}</td><td data-stock-add class="finished-stock-addition"></td><td data-stock-outgoing></td><td data-stock-forecast class="finished-stock-number"></td><td>${button("ship", "在庫から出荷", `data-product-id="${escape(p.id)}" data-stock-unavailable="${number(p.stockQuantity) <= 0}"`)}</td></tr>`;
        }).join("") || empty(9, "製品を読み込んでいます。");
      }
      updateForecast();
    }

    function paintOrders() {
      const orders = snapshot.orders || [];
      text("#finished-stock-orders-count", `${orders.length}件`);
      q("#finished-stock-order-rows").innerHTML = orders.map((o) => `<tr data-stock-order="${escape(o.jobId)}"><th scope="row"><strong>${escape(nameFor(o.productId))}</strong><small>${escape(o.customer)} / ${escape(o.serialNo || o.jobId)}</small></th><td>${count(o.quantity)}${o.hasSchedule ? "" : '<small>製造総数−在庫予定</small>'}</td><td>${count(o.shippedQuantity)}</td><td>${count(o.remainingQuantity)}</td><td class="finished-stock-number">${count(o.allocatedQuantity)}</td><td class="${o.shortageQuantity > 0 ? "finished-stock-shortage" : ""}">${count(o.shortageQuantity)}</td><td>${escape(o.shipDate || "未定")}${o.shipDate && o.shipDate < today() && (o.shipmentMode === "together" ? o.remainingQuantity > 0 : o.stockTargetQuantity > 0) ? '<small class="finished-stock-badge">出荷予定日超過</small>' : ""}<small>${o.shipmentMode === "together" ? "不足分と一緒に出荷" : "在庫分を先に出荷"}</small></td><td>${o.shortageQuantity > 0 ? escape(o.completionDate || "未定") : "在庫で対応可"}<small>製造総数 ${count(o.totalQuantity)}丁</small>${o.shortageQuantity > 0 && !o.finishReady && o.completionDate && o.completionDate < today() ? '<small class="finished-stock-badge">完成予定日超過・要確認</small>' : ""}${button("job", "製造計画", `data-job-id="${escape(o.jobId)}"`)}</td><td>${o.hasSchedule && o.totalQuantity === 0 && o.quantity > 0 && o.remainingQuantity === 0 && o.shippedQuantity === o.quantity ? button("fulfill", "受注履行完了", `data-job-id="${escape(o.jobId)}"`) : ""}${button("schedule", "出荷予定", `data-job-id="${escape(o.jobId)}"`)}${button("ship", "この受注へ出荷", `data-product-id="${escape(o.productId)}" data-order-job-id="${escape(o.jobId)}" data-stock-unavailable="${o.allocatedQuantity <= 0 || o.shipmentMode === "together" && o.shortageQuantity > 0 && !o.finishReady}"`)}</td></tr>`).join("") || empty(9, "未出荷のTezoe受注はありません。注文入力・取込の確定後に自動で表示します。");
      const issues = snapshot.issues || [];
      const issuePanel = q("#finished-stock-issues");
      if (issuePanel) issuePanel.hidden = !issues.length;
      q("#finished-stock-issue-list").innerHTML = issues.map((issue) => `<p class="finished-stock-warning"><strong>${escape([issue.customer, issue.serialNo, issue.product].filter(Boolean).join(" / ") || issue.jobId || "")}</strong><small>${escape(errorMessage(issue.message || issue.reason || "製品番号と注文数量を確認してください。"))}</small>${button("job", "注文を確認", `data-job-id="${escape(issue.jobId)}"`)}</p>`).join("");
    }

    function paintPlans() {
      const plans = [...(snapshot?.productions || snapshot?.plans || [])].sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.productId.localeCompare(b.productId));
      text("#finished-stock-plans-count", `${plans.length}件`);
      q("#finished-stock-plan-rows").innerHTML = plans.map((p) => {
        const stockLeft = number(p.stockQuantity ?? p.quantity);
        return `<tr><td>${escape(p.dueDate || "完成日未定")}${p.quantity > 0 && !p.finishReady && p.dueDate && p.dueDate < today() ? '<small class="finished-stock-badge">完成予定日超過</small>' : ""}${p.shippingStatus !== "shipped" ? button("completion", "完成予定", `data-job-id="${escape(p.jobId)}"`) : ""}</td><td><strong>${escape(nameFor(p.productId))}</strong><small>${escape(p.customer)} / ${escape(p.serialNo || "連番なし")}</small>${button("job", "注文を開く", `data-job-id="${escape(p.jobId)}"`)}</td><td>${count(p.totalQuantity)}</td><td>${count(p.orderQuantity)}</td><td>${count(p.plannedQuantity)}</td><td>${count(p.receivedQuantity)}</td><td class="finished-stock-addition">＋${count(stockLeft)}</td><td>${p.dueDate ? count(forecast(p.productId, p.dueDate).quantity) : "未定"}</td><td>${stockLeft > 0 ? button("receive", "在庫分を入庫", `data-job-id="${escape(p.jobId)}" data-stock-unavailable="${!p.finishReady}"`) : "在庫分の入庫なし"}<small>${p.finishReady ? "最終仕上げ完了" : "製造中・予定"}</small></td></tr>`;
      }).join("") || empty(9, "未完了の生産予定はありません。");
    }

    function traceMarkup(value, quantity) {
      if (!value) return '<span class="finished-stock-warning">出荷元の情報が見つかりません</span>';
      const producer = names(value.producers);
      return `<div class="finished-stock-lot-trace"><strong>${escape(value.lotNo || value.id)}</strong>${quantity === undefined ? "" : ` / ${count(quantity)}丁`}<small>製造日 ${escape(date(value.productionDate))} / 製造担当 ${escape(producer || "不明")}</small>${value.serialNo ? `<small>製造案件 ${escape(value.serialNo)}</small>` : ""}${!value.productionDate || !producer ? '<small class="finished-stock-warning">製造元の情報が不明な在庫</small>' : ""}</div>`;
    }

    function paintLots() {
      const all = q("#finished-stock-exhausted")?.checked;
      const lots = (snapshot?.lots || []).filter((entry) => all || number(entry.remainingQuantity) > 0);
      q("#finished-stock-lot-rows").innerHTML = lots.map((entry) => `<tr><td><strong>${escape(entry.productId)}</strong><small>${escape(product(entry.productId)?.name || "")}</small></td><td>${escape(entry.lotNo || entry.id)}${entry.serialNo ? `<small>${escape(entry.serialNo)}</small>` : ""}${entry.jobId ? button("job", "製造案件", `data-job-id="${escape(entry.jobId)}"`) : ""}${entry.note ? `<small>${escape(entry.note)}</small>` : ""}</td><td>${escape(date(entry.productionDate))}</td><td>${escape(names(entry.producers) || "不明")}${!entry.productionDate || !names(entry.producers) ? '<small class="finished-stock-badge">製造元の情報不明</small>' : ""}${Object.keys(entry.stageAssignees || {}).length ? `<details><summary>工程ごとの担当</summary>${Object.entries(entry.stageAssignees).map(([key, value]) => `<p>${escape(({ welding: "溶接", base: "元作り", grinding: "浮き止め～立ち上がり", heat: "厚みとり", finish: "仕上げ" })[key] || key)}：${escape(typeof value === "object" ? value.assignee || "不明" : value || "不明")}</p>`).join("")}</details>` : ""}</td><td>${escape(date(entry.date))}</td><td>${count(entry.quantity)}</td><td class="finished-stock-number">${count(entry.remainingQuantity)}</td><td>${button("ship", "このロットから出荷", `data-product-id="${escape(entry.productId)}" data-lot-id="${escape(entry.id)}" data-stock-unavailable="${entry.remainingQuantity <= 0}"`)}</td></tr>`).join("") || empty(8, "在庫のあるロットはありません。");
    }

    function paintHistory() {
      const selected = q("#finished-stock-product-filter").value;
      const search = q("#finished-stock-history-search").value.trim().toLocaleLowerCase();
      const events = [...(snapshot?.history || [])].sort((a, b) => String(b.at).localeCompare(String(a.at))).filter((entry) => (selected === "all" || entry.productId === selected) && (!search || JSON.stringify([entry, (entry.allocations || []).map((a) => lot(a.lotId))]).toLocaleLowerCase().includes(search)));
      const reversed = new Set((snapshot?.history || []).filter((entry) => entry.action === "reverse").map((entry) => entry.eventId || entry.reverseOf));
      text("#finished-stock-history-count", `${events.length}件`);
      q("#finished-stock-history-rows").innerHTML = events.map((entry) => {
        const sourceLots = entry.action === "schedule" ? `出荷予定 ${escape(entry.shipDate || "未定")}<small>${entry.shipmentMode === "together" ? "不足分と一緒に出荷" : "在庫分を先に出荷"} / 在庫から ${count(entry.stockQuantity)}丁</small><small>完成予定 ${escape(entry.completionDate || "納期を使用")}</small>` : entry.action === "ship" ? (entry.allocations || []).map((a) => traceMarkup(lot(a.lotId) || a, a.quantity)).join("") : ["opening", "receive"].includes(entry.action) ? traceMarkup(lot(entry.id) || entry) : `元の記録 ${escape(entry.eventId || entry.reverseOf || "")}`;
        return `<tr><td>${escape(date(entry.date))}<small>${escape(ACTIONS[entry.action] || entry.action)}${entry.purpose === "demo" ? "・デモ用" : entry.purpose === "sale" ? "・販売用" : ""}</small>${reversed.has(entry.id) ? '<small class="finished-stock-warning">取消済</small>' : ""}</td><td><strong>${escape(entry.productId)}</strong><small>${count(entry.quantity)}丁</small></td><td>${escape(entry.customer || "—")}<small>${escape(entry.orderRef || entry.serialNo || "")}</small></td><td>${sourceLots}</td><td>${escape(entry.note || "—")}<small>記録者 ${escape(entry.actor || "不明")}</small><small>${escape(recordedAt(entry.at))}</small></td><td>${["opening", "receive", "ship"].includes(entry.action) && !reversed.has(entry.id) ? button("reverse", "訂正のため取り消す", `data-event-id="${escape(entry.id)}"`) : "—"}</td></tr>`;
      }).join("") || empty(6, "条件に一致する履歴はありません。");
    }

    function paint() {
      if (!permitted() || !snapshot) { controls(); return; }
      paintOverview(); paintOrders(); paintPlans(); paintLots(); paintHistory(); controls();
    }

    async function refresh() {
      if (!permitted()) { clear(); return; }
      if (pending) { queued = true; return; }
      if (reading) { queued = true; return reading; }
      const captured = revision;
      status("#finished-stock-status", "在庫と製造予定を読み込んでいます…", "pending");
      reading = Promise.resolve().then(() => options.api.getFinishedStock()).then((result) => {
        if (!permitted() || captured !== revision) { queued = permitted(); return; }
        snapshot = result; dirty = false;
        status("#finished-stock-status", snapshot.history.length ? "在庫は入出庫の記録から集計しています。" : "開始在庫は未登録です。現物を確認し「手元の在庫を追加」から登録してください。", snapshot.history.length ? "" : "warning");
        paint();
      }).catch((error) => {
        if (captured !== revision || !permitted()) return;
        dirty = true; status("#finished-stock-status", `読み込めませんでした。「更新」で再試行できます。${errorMessage(error)}`, "error");
      }).finally(() => {
        reading = null; controls();
        if (queued && permitted()) { queued = false; void refresh(); }
      });
      controls();
      return reading;
    }

    const inputField = (name, label, value = "", attributes = "", helper = "") => `<label class="field"><span>${label}</span><input name="${name}" value="${escape(value)}" ${attributes}>${helper ? `<small>${helper}</small>` : ""}</label>`;
    const productField = (id) => `<label class="field"><span>製品</span><select name="productId" required>${snapshot.products.map((p) => `<option value="${escape(p.id)}" ${p.id === id ? "selected" : ""}>${escape(`${p.code} ${p.name}`)}</option>`).join("")}</select></label>`;
    const values = () => Object.fromEntries(Array.from(form.elements).filter((element) => element.name).map((element) => [element.name, element.value]));
    const draftKey = (d) => `${d.action}:${d.jobId || d.eventId || d.orderJobId || d.lotId || d.productId || "all"}`;

    function remember() {
      if (draft) savedDrafts.set(draftKey(draft), { draft: { ...draft }, values: values(), attempt });
    }
    function close({ force = false, keepDraft = true } = {}) {
      if (pending && !force) return false;
      if (keepDraft) remember();
      if (dialog?.open) dialog.close();
      return true;
    }
    function open(action, data = {}) {
      if (!usable()) return;
      let restored = action === "ship" ? unresolvedShipment(data.productId) : null;
      if (restored) data = { ...restored.draft };
      if (!restored && action === "ship" && !data.orderJobId && number(product(data.productId)?.availableQuantity) <= 0) {
        const selected = (snapshot.orders || []).find((entry) => entry.productId === data.productId && entry.allocatedQuantity > 0);
        if (selected) data = { ...data, orderJobId: selected.jobId };
      }
      draft = { action, ...data }; attempt = null;
      restored ||= savedDrafts.get(draftKey(draft));
      const p = snapshot.plans.find((entry) => entry.jobId === data.jobId);
      const o = orderFor(data.jobId || data.orderJobId);
      const production = (snapshot.productions || []).find((entry) => entry.jobId === data.jobId);
      const receipt = action === "receive";
      const scheduling = action === "schedule";
      const completing = action === "completion";
      const existingLot = lot(data.lotId);
      const qty = receipt ? p?.quantity : action === "ship" ? number(o ? Math.min(o.allocatedQuantity, existingLot?.remainingQuantity ?? o.allocatedQuantity) : Math.min(1, number(existingLot?.remainingQuantity ?? product(data.productId)?.availableQuantity))) : "";
      draft.jobVersion = scheduling ? o?.jobVersion : completing ? production?.jobVersion : p?.jobVersion;
      if (completing) draft.scheduleDefaults = o ? { orderQuantity: o.quantity, stockQuantity: number(o.stockTargetQuantity) + number(o.shippedQuantity), shipmentMode: o.shipmentMode || "split", shipDate: o.shipDate || "" } : { orderQuantity: 0, stockQuantity: 0, shipmentMode: "split", shipDate: "" };
      draft.shipVersions = Object.fromEntries((snapshot.orders || []).map((entry) => [entry.jobId, entry.jobVersion]));
      text("#finished-stock-dialog-title", ACTIONS[action]);
      text("#finished-stock-dialog-kicker", receipt ? `${nameFor(p.productId)} / ${p.serialNo || p.jobId}` : scheduling ? `${nameFor(o.productId)} / ${o.customer} / ${o.serialNo || o.jobId}` : action === "reverse" ? "原記録と取消理由を保存します" : "Tezoe 製品在庫");
      text("#finished-stock-form-description", action === "opening" ? "現物を数えて、追加する数量を入力してください。入力した数だけ現在庫に加算します。製造日や担当が分からない場合は空欄にできます。" : receipt ? "実際に製造が完了した在庫分を入庫します。製造日・製造担当はこのロットの記録に残ります。" : scheduling ? "実際の注文数量を保存します。在庫から出す数量は出荷済分を含めた累計です。製造数量は自動変更しないため、保存後に製造計画を調整してください。" : action === "ship" ? "実際に出荷する在庫分を記録します。受注を選ぶと、その受注の確保分から出庫します。出荷待ち一覧の出荷完了は別に記録してください。" : "取消を記録し、在庫数を元に戻します。出荷に使った入庫は、その出荷の取消後に取り消せます。");
      if (completing) {
        text("#finished-stock-dialog-kicker", `${nameFor(production.productId)} / ${production.customer} / ${production.serialNo || production.jobId}`);
        text("#finished-stock-form-description", "在庫補充を含む製造の完成予定日を保存します。空欄の場合は案件の納期を使用します。");
      }
      const dateField = inputField("date", action === "ship" ? "出荷日" : action === "reverse" ? "取消日" : "入庫日", today(), `type="date" max="${today()}" required`);
      let html;
      if (completing) {
        html = inputField("completionDate", "製造の完成予定日", production.dueDate || "", 'type="date"');
      } else if (scheduling) {
        html = `${inputField("orderQuantity", "実際の注文数量（丁）", o.quantity, `type="number" min="${o.shippedQuantity}" max="1000000" step="1" required`)}${inputField("stockQuantity", "在庫から出す累計数量（丁）", o.hasSchedule ? number(o.stockTargetQuantity) + number(o.shippedQuantity) : number(o.allocatedQuantity) + number(o.shippedQuantity), `type="number" min="${o.shippedQuantity}" max="${o.quantity}" step="1" required`, `在庫から出荷済 ${count(o.shippedQuantity)}丁。0にすると現在庫を使わず製造します。`)}<label class="field"><span>出荷方法</span><select name="shipmentMode"><option value="split" ${o.shipmentMode !== "together" ? "selected" : ""}>在庫分を先に出荷</option><option value="together" ${o.shipmentMode === "together" ? "selected" : ""}>不足分の完成後に一緒に出荷</option></select></label>${inputField("shipDate", "在庫分の出荷予定日", o.shipDate || "", 'type="date"', "未定の場合は空欄。在庫見込では未定分も先に差し引きます。")}${inputField("completionDate", "製造の完成予定日", o.hasSchedule ? o.completionDate || "" : "", 'type="date"', `空欄の場合は納期 ${escape(o.dueDate || "未定")} を使います。在庫補充分にも同じ完成予定日を適用します。`)}`;
      } else if (action === "reverse") {
        const entry = snapshot.history.find((e) => e.id === data.eventId);
        html = `<div class="field"><span>取り消す記録</span><strong>${escape(date(entry?.date))} / ${escape(ACTIONS[entry?.action])} / ${escape(entry?.productId)} / ${count(entry?.quantity)}丁</strong><small>${escape(entry?.customer || entry?.lotNo || "")}</small></div>${dateField}`;
      } else {
        html = `${receipt ? `<p>${escape(nameFor(p.productId))}・在庫追加残 ${count(p.quantity)}丁</p>` : productField(data.productId)}${inputField("quantity", action === "ship" ? "出荷数量（丁）" : "追加する在庫数量（丁）", qty, `type="number" min="${action === "opening" ? 0 : 1}" step="1" inputmode="numeric" required ${receipt ? `max="${p.quantity}"` : ""}`)}${dateField}`;
        if (action === "ship") {
          const relevant = snapshot.lots.filter((l) => l.productId === (data.productId || snapshot.products[0]?.id) && l.remainingQuantity > 0);
          const relevantOrders = (snapshot.orders || []).filter((entry) => entry.productId === (data.productId || snapshot.products[0]?.id) && entry.remainingQuantity > 0);
          // Native selects clear values that have no option. Keep a previous
          // selection visible even when its lot/order was consumed by the write.
          const previousLot = restored?.values.lotId, previousOrder = restored?.values.orderJobId;
          if (previousLot && !relevant.some((entry) => entry.id === previousLot)) relevant.push(lot(previousLot) || { id: previousLot, lotNo: `${previousLot}（前回の選択）`, remainingQuantity: 0 });
          if (previousOrder && !relevantOrders.some((entry) => entry.jobId === previousOrder)) relevantOrders.push({ jobId: previousOrder, customer: restored.values.customer, serialNo: `${restored.values.orderRef}（前回の選択）`, allocatedQuantity: 0 });
          html += `<label class="field"><span>対象の受注</span><select name="orderJobId"><option value="">受注と紐付けない（未確保の在庫から）</option>${relevantOrders.map((entry) => `<option value="${escape(entry.jobId)}" ${entry.jobId === data.orderJobId ? "selected" : ""}>${escape(entry.customer)} / ${escape(entry.serialNo || entry.jobId)} / 確保 ${count(entry.allocatedQuantity)}丁</option>`).join("")}</select></label><label class="field"><span>出荷元ロット</span><select name="lotId"><option value="">自動（先に入庫したロットから）</option>${relevant.map((l) => `<option value="${escape(l.id)}" ${l.id === data.lotId ? "selected" : ""}>${escape(l.lotNo || l.id)} / ${count(l.remainingQuantity)}丁 / 製造 ${escape(date(l.productionDate))} / ${escape(names(l.producers) || "担当不明")}</option>`).join("")}</select></label>${inputField("customer", "出荷先・得意先", o?.customer || "", 'maxlength="160" required')}${inputField("orderRef", "注文番号・出荷管理番号", o?.serialNo || o?.jobId || "", 'maxlength="160" required')}<label class="field"><span>用途</span><select name="purpose"><option value="sale">販売用</option><option value="demo">デモ用</option></select></label>`;
        } else {
          html += `${inputField("lotNo", "ロット番号（任意）", "", 'maxlength="120"', "空欄の場合は自動採番します。")}${inputField("productionDate", "製造日", receipt ? today() : "", `type="date" max="${today()}" ${receipt ? "required" : ""}`)}${inputField("producers", "製造担当", receipt ? names(p?.producers) : "", `maxlength="240" ${receipt ? "required" : ""}`, receipt ? "複数の場合は「・」で区切って入力できます。" : "不明な場合は空欄にします。")}`;
        }
      }
      html += `<label class="field"><span>${action === "reverse" ? "取消理由" : "備考・登録理由"}</span><textarea name="note" rows="2" maxlength="800" ${["opening", "reverse"].includes(action) ? "required" : ""}></textarea></label>`;
      q("#finished-stock-form-fields").innerHTML = html;
      if (restored) {
        for (const [name, value] of Object.entries(restored.values)) if (field(name)) field(name).value = value;
        attempt = restored.attempt;
        draft = { ...restored.draft };
      }
      status("#finished-stock-form-status", attempt?.unconfirmed ? "前回の記録が未確認です。入力を保持しています。「前回の記録を確認する」で同じ出荷の結果を確認してください。" : restored ? "前回の入力を復元しました。内容を確認して記録してください。" : "", attempt?.unconfirmed ? "error" : "");
      controls();
      if (options.openDialog) options.openDialog(dialog);
      else dialog.showModal();
    }

    async function submit(event) {
      event.preventDefault();
      if (pending || !permitted() || !draft || !attempt?.unconfirmed && !form.reportValidity()) return;
      const data = values();
      for (const name of ["quantity", "orderQuantity", "stockQuantity"]) if (data[name] !== undefined) data[name] = Number(data[name]);
      if (draft.action === "ship") {
        if (data.orderJobId) data.jobVersion = draft.shipVersions[data.orderJobId];
        else delete data.orderJobId;
      }
      const payload = attempt?.unconfirmed ? { ...attempt.payload } : { ...(draft.scheduleDefaults || {}), ...data, ...(draft.jobId ? { jobId: draft.jobId, jobVersion: draft.jobVersion } : {}), ...(draft.eventId ? { eventId: draft.eventId } : {}) };
      const fingerprint = JSON.stringify([draft.action, payload]);
      if (!attempt || attempt.fingerprint !== fingerprint) attempt = { fingerprint, payload: { ...payload }, requestId: root.crypto.randomUUID(), expectedVersion: snapshot.version };
      payload.requestId = attempt.requestId; payload.expectedVersion = attempt.expectedVersion;
      pending = true; revision += 1; controls();
      const capturedClear = clearRevision;
      status("#finished-stock-form-status", "記録しています…", "pending");
      status("#finished-stock-status", "在庫の記録を反映しています…", "pending");
      try {
        const result = await options.api[APIS[draft.action]](payload);
        if (!permitted() || capturedClear !== clearRevision) return;
        snapshot = result; dirty = false; overviewSignature = "";
        savedDrafts.delete(draftKey(draft));
        close({ force: true, keepDraft: false }); draft = null; attempt = null;
        status("#finished-stock-status", "在庫と履歴に反映しました。", "success");
        paint();
        options.onMutation?.();
      } catch (error) {
        if (!permitted() || capturedClear !== clearRevision) return;
        // A validation rejection is known not to have written. A transport
        // failure must resolve the exact request before accepting another ship.
        attempt.unconfirmed = draft.action === "ship" && error?.code !== "FINISHED_STOCK_INVALID" && !String(error?.message || error).includes("FINISHED_STOCK_INVALID:");
        status("#finished-stock-form-status", `記録を確認できませんでした。入力を保持しています。${attempt.unconfirmed ? "「前回の記録を確認する」で同じ出荷の結果を確認してください。" : ""}${errorMessage(error)}`, "error");
        status("#finished-stock-status", "記録が未確認です。入力画面から再試行できます。", "error");
        remember();
        // Refresh the inventory but retain the request id/version: a lost reply
        // must be retried verbatim so a committed event cannot be duplicated.
        dirty = true; queued = true;
      } finally {
        pending = false; controls();
        if (queued && permitted()) {
          queued = false; await refresh();
          if (draft && attempt && snapshot && !dirty) {
            attempt.expectedVersion = snapshot.version;
            const plan = draft.action === "receive" ? snapshot.plans.find((p) => p.jobId === draft.jobId) : draft.action === "schedule" ? orderFor(draft.jobId) : draft.action === "completion" ? (snapshot.productions || []).find((p) => p.jobId === draft.jobId) : null;
            if (!attempt.unconfirmed && plan && plan.jobVersion !== draft.jobVersion && !snapshot.history.some((entry) => entry.requestId === attempt.requestId)) {
              draft.jobVersion = plan.jobVersion; attempt = null;
              status("#finished-stock-form-status", "案件の最新状況を読み込みました。入力した数量・製造日・製造担当を確認し、もう一度記録してください。", "error");
            }
            if (draft.action === "ship" && !attempt?.unconfirmed && !snapshot.history.some((entry) => entry.requestId === attempt?.requestId)) draft.shipVersions = Object.fromEntries((snapshot.orders || []).map((entry) => [entry.jobId, entry.jobVersion]));
            remember();
          }
        }
      }
    }

    function clear() {
      revision += 1; clearRevision += 1; snapshot = null; dirty = true; queued = false; draft = null; attempt = null; savedDrafts.clear(); overviewSignature = "";
      close({ force: true, keepDraft: false });
      for (const id of ["rows", "order-rows", "issue-list", "plan-rows", "lot-rows", "history-rows", "form-fields"]) { const element = q(`#finished-stock-${id}`); if (element) element.replaceChildren(); }
      status("#finished-stock-status", ""); controls();
    }
    function bind() {
      if (bound || !panel || !dialog || !form) return;
      bound = true;
      q("#finished-stock-asof").value = (() => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 30); return d.toISOString().slice(0, 10); })();
      q("#finished-stock-product-filter").innerHTML = '<option value="all">すべて</option>' + (root.FinishedStock?.CATALOG || []).map((p) => `<option value="${escape(p.id)}">${escape(`${p.code} ${p.name}`)}</option>`).join("");
      panel.addEventListener("click", (event) => {
        const el = event.target.closest("[data-stock-action]"); if (!el || el.disabled || !permitted()) return;
        const action = el.dataset.stockAction;
        if (action === "refresh") { void refresh(); return; }
        if (action === "job") { options.onJob?.(el.dataset.jobId); return; }
        if (action === "fulfill") {
          pending = true; controls();
          status("#finished-stock-status", "受注履行完了を記録しています…", "pending");
          Promise.resolve().then(() => options.onFulfill?.(el.dataset.jobId)).then(() => {
            status("#finished-stock-status", "受注履行完了を記録しました。", "success");
          }).catch((error) => status("#finished-stock-status", errorMessage(error), "error")).finally(() => {
            pending = false; dirty = true; controls(); void refresh();
          });
          return;
        }
        open(action, { productId: el.dataset.productId, lotId: el.dataset.lotId, jobId: el.dataset.jobId, eventId: el.dataset.eventId, orderJobId: el.dataset.orderJobId });
      });
      panel.addEventListener("input", (event) => {
        if (event.target.id === "finished-stock-asof") updateForecast();
        if (event.target.id === "finished-stock-history-search") paintHistory();
      });
      q("#finished-stock-exhausted").addEventListener("change", () => { paintLots(); controls(); });
      q("#finished-stock-product-filter").addEventListener("change", paintHistory);
      dialog.querySelectorAll("[data-stock-close]").forEach((el) => el.addEventListener("click", close));
      dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
      form.addEventListener("submit", submit);
      form.addEventListener("input", (event) => {
        if (draft?.action === "schedule" && event.target.name === "orderQuantity" && field("stockQuantity")) field("stockQuantity").max = field("orderQuantity").value;
      });
      form.addEventListener("change", (event) => {
        if (attempt?.unconfirmed) return;
        if (event.target.name === "orderJobId" && draft?.action === "ship") {
          const selected = orderFor(event.target.value);
          if (selected) { field("customer").value = selected.customer; field("orderRef").value = selected.serialNo || selected.jobId; field("quantity").value = selected.allocatedQuantity; }
        }
        if (event.target.name === "productId" && draft?.action === "ship") {
          const previous = values(); draft.productId = previous.productId;
          savedDrafts.delete(draftKey(draft));
          open("ship", { productId: previous.productId });
          ["customer", "orderRef", "quantity", "date", "note", "purpose"].forEach((name) => { if (field(name)) field(name).value = previous[name]; });
        }
      });
    }
    function render() {
      bind();
      if (!permitted()) { clear(); return; }
      paint();
      if (dirty && !reading && !pending) void refresh();
    }
    function invalidate({ refresh: shouldRefresh = false, passive = false } = {}) {
      if (!permitted()) { clear(); return; }
      if (passive && (reading || pending)) return;
      revision += 1; dirty = true; controls();
      if (shouldRefresh) void refresh();
    }
    return { render, refresh, invalidate, clear, close };
  }
  root.FinishedStockUI = Object.freeze({ create });
})(typeof globalThis !== "undefined" ? globalThis : this);
