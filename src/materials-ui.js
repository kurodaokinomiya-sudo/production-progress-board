(function (root) {
  "use strict";

  const ACTIONS = Object.freeze({ opening: "開始残高", order: "発注", receive: "入庫", use: "案件引当", release: "引当解除", adjust: "在庫調整", cancel: "発注取消" });
  const OPERATIONS = Object.freeze({
    order: { title: "材料を発注", date: "発注日", submit: "発注を記録", api: "saveMaterialOrder" },
    receive: { title: "材料の入庫を記録", date: "入庫日", submit: "入庫を記録", api: "receiveMaterialOrder" },
    adjust: { title: "材料の在庫を調整", date: "調整日", submit: "在庫を調整", api: "adjustMaterialStock" },
    cancel: { title: "発注残を取り消す", date: "取消日", submit: "発注残を取り消す", api: "cancelMaterialOrder" },
  });
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const quantity = (value) => number(value).toLocaleString("ja-JP");
  const dateLabel = (value) => value ? String(value).slice(0, 10) : "—";
  const materialName = (material) => [material?.code, material?.name].filter(Boolean).join(" · ") || "不明な材料";
  const emptyRow = (columns, message) => `<tr><td colspan="${columns}" class="material-empty">${escape(message)}</td></tr>`;
  const actionButton = (action, label, attributes = "") => `<button class="button button-secondary material-row-button" type="button" data-material-action="${escape(action)}" ${attributes}>${escape(label)}</button>`;

  function purchaseStatus(order) {
    const remaining = number(order.remainingQuantity), received = number(order.receivedQuantity), canceled = number(order.canceledQuantity);
    return {
      key: remaining > 0 ? received > 0 ? "partial" : "waiting" : canceled > 0 ? "canceled" : "received",
      label: remaining > 0 ? received > 0 ? "一部入庫" : "入庫待ち" : canceled > 0 ? received > 0 ? "入庫済・残数取消" : "取消" : "入庫済",
    };
  }

  function purchaseReceipts(order, events) {
    const receipts = events.filter((entry) => entry.action === "receive" && String(entry.materialId) === String(order.materialId) && String(entry.orderId) === String(order.id) && number(entry.quantity) > 0)
      .slice().sort((a, b) => String(a.date || "9999").localeCompare(String(b.date || "9999")) || String(a.at || "").localeCompare(String(b.at || "")) || String(a.id).localeCompare(String(b.id)));
    const recorded = receipts.reduce((sum, entry) => sum + number(entry.quantity), 0);
    const lines = receipts.map((entry) => `<span class="material-order-receipt"><span>${escape(entry.date ? dateLabel(entry.date) : "日付不明")}</span><span>${quantity(entry.quantity)} セット</span></span>`);
    if (number(order.receivedQuantity) > recorded) lines.push(`<span class="material-order-receipt"><span>日付不明</span><span>${quantity(number(order.receivedQuantity) - recorded)} セット</span></span>`);
    return lines.join("") || "入庫なし";
  }

  function create(options = {}) {
    const doc = root.document;
    const query = (selector) => doc?.querySelector?.(selector) || null;
    let panel;
    let dialog;
    let form;
    let bound = false;
    let snapshot = null;
    let snapshotSource = null;
    let revision = 0;
    let readRevision = 0;
    let refreshing = false;
    let refreshPromise = null;
    let refreshQueued = false;
    let pending = false;
    let draft = null;
    let attempt = null;
    const failedDrafts = new Map();
    const filters = { material: "all", action: "all", search: "" };
    const permitted = () => options.canEdit?.() === true;
    const field = (name) => form?.elements?.namedItem?.(name) || form?.elements?.[name];
    const text = (selector, value) => { const element = query(selector); if (element) element.textContent = String(value ?? ""); };
    const markup = (selector, value) => { const element = query(selector); if (element) element.innerHTML = value; };
    const hide = (selector, value) => { const element = query(selector); if (element) element.hidden = value; };
    const setStatus = (selector, message, tone = "") => {
      const element = query(selector);
      if (element) { element.textContent = message; element.dataset.tone = tone; }
    };
    const materialFor = (id) => snapshot?.materials?.find((material) => String(material.id) === String(id));
    const orderFor = (id) => snapshot?.orders?.find((order) => String(order.id) === String(id));
    const notifyError = (message) => { if (typeof options.onError === "function") options.onError(message); };
    const notifySnapshot = () => { if (permitted() && typeof options.onSnapshot === "function") options.onSnapshot(snapshotSource || snapshot); };

    function rememberFailedDraft() {
      if (!draft || !attempt?.failed || !permitted()) return;
      const values = Object.fromEntries(["materialId", "date", "quantity", "expectedDate", "note"].map((name) => [name, String(field(name)?.value || "")]));
      const materialId = ["order", "adjust"].includes(draft.action) ? values.materialId : draft.materialId;
      failedDrafts.set(`${draft.action}:${draft.orderId || materialId}`, { draft: { ...draft, materialId }, values, attempt, order: orderFor(draft.orderId), message: query("#material-form-status")?.textContent || "" });
    }

    function close() {
      if (pending || !dialog) return;
      rememberFailedDraft();
      if (typeof dialog.close === "function") dialog.close();
      else dialog.open = false;
    }

    function renderControls() {
      if (!panel || !dialog || !form) return;
      const editable = permitted();
      panel.querySelectorAll?.("[data-material-action]").forEach((button) => {
        const action = button.dataset.materialAction;
        button.disabled = !editable || (action === "refresh" ? refreshing : pending || !snapshot?.materials?.length);
      });
      const refresh = panel.querySelector?.('[data-material-action="refresh"]');
      if (refresh) {
        refresh.setAttribute?.("aria-busy", String(refreshing));
        const label = refresh.querySelector?.("span");
        if (label) label.textContent = refreshing ? "更新中…" : "更新";
      }
      Array.from(form.elements || []).forEach((input) => { input.disabled = pending || !editable; });
      dialog.querySelectorAll?.('[data-material-action="close"]').forEach((button) => { button.disabled = pending; });
      form.setAttribute?.("aria-busy", String(pending));
      text("#material-submit", pending ? "反映中…" : attempt?.failed ? "同じ内容で再試行" : OPERATIONS[draft?.action]?.submit || "保存");
    }

    function renderHistory() {
      if (!permitted() || !snapshot) return;
      const material = query("#material-history-material");
      if (material) {
        material.innerHTML = '<option value="all">すべての材料</option>' + snapshot.materials.map((item) => `<option value="${escape(item.id)}">${escape(materialName(item))}</option>`).join("");
        material.value = filters.material;
        if (!material.value) { material.value = "all"; filters.material = "all"; }
      }
      const needle = filters.search.trim().normalize("NFKC").toLocaleLowerCase("ja");
      const groups = new Map(), rows = [];
      const orders = new Map(snapshot.orders.map((order) => [String(order.id), order]));
      snapshot.history.forEach((entry, index) => {
        const orderId = entry.orderId || (entry.action === "order" ? entry.id : "");
        const order = ["order", "receive", "cancel"].includes(entry.action) && orderId ? orders.get(String(orderId)) : null;
        if (!order || String(order.materialId) !== String(entry.materialId)) {
          rows.push({ entries: [entry], materialId: entry.materialId, date: entry.date || "", index });
          return;
        }
        let row = groups.get(String(order.id));
        if (!row) {
          row = { order, entries: [], materialId: order.materialId, date: entry.date || "", index };
          groups.set(String(order.id), row);
          rows.push(row);
        }
        row.entries.push(entry);
        if (String(entry.date || "") > row.date) row.date = String(entry.date);
      });
      const entries = rows.filter((row) => {
        if (filters.material !== "all" && String(row.materialId) !== filters.material) return false;
        if (filters.action !== "all" && !row.entries.some((entry) => entry.action === filters.action)) return false;
        const haystack = [materialName(materialFor(row.materialId)), row.order?.note, ...row.entries.flatMap((entry) => [entry.product, entry.customer, entry.serialNo, entry.note, entry.actor])].join(" ").normalize("NFKC").toLocaleLowerCase("ja");
        return !needle || haystack.includes(needle);
      }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.index - a.index);
      text("#material-history-count", `${entries.length} / ${rows.length}件`);
      markup("#material-history-rows", entries.map((row) => {
        if (row.order) {
          const order = row.order, status = purchaseStatus(order);
          const eventNotes = row.entries.slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.at || "").localeCompare(String(b.at || "")))
            .map((entry) => `<div class="material-history-event-note"><span>${escape(ACTIONS[entry.action])} ${escape(dateLabel(entry.date))}${entry.action === "cancel" ? ` ${quantity(entry.quantity)} セット` : ""}</span>${entry.note ? `<div>${escape(entry.note)}</div>` : ""}${entry.actor ? `<small>${escape(entry.actor)}</small>` : ""}</div>`).join("");
          const orderNote = order.note && !row.entries.some((entry) => entry.note === order.note) ? `<div>${escape(order.note)}</div>` : "";
          return `<tr data-material-history-order="${escape(order.id)}"><td>${escape(dateLabel(order.orderDate))}</td><td><span class="material-history-action" data-material-kind="order">発注・入庫</span><small><span class="material-order-status" data-material-order-status="${status.key}">${status.label}</span></small></td><td>${escape(materialName(materialFor(order.materialId)))}</td><td class="material-number">発注 ${quantity(order.quantity)}<small>入庫 ${quantity(order.receivedQuantity)}</small><small>発注残 ${quantity(order.remainingQuantity)}</small>${number(order.canceledQuantity) > 0 ? `<small>取消 ${quantity(order.canceledQuantity)}</small>` : ""}</td><td class="material-order-receipts">${purchaseReceipts(order, row.entries)}</td><td class="material-history-job">—</td><td class="material-history-note">${orderNote}${eventNotes}</td></tr>`;
        }
        const entry = row.entries[0];
        let amount = quantity(entry.quantity);
        if (entry.action === "use") amount = `−${quantity(Math.abs(number(entry.quantity)))}`;
        else if (["receive", "release"].includes(entry.action)) amount = `+${quantity(Math.abs(number(entry.quantity)))}`;
        else if (["opening", "adjust"].includes(entry.action) && number(entry.quantity) > 0) amount = `+${amount}`;
        const job = [entry.product, entry.customer, entry.serialNo ? `連番 ${entry.serialNo}` : ""].filter(Boolean).map(escape).join(" / ") || "—";
        const receipt = entry.action === "receive" ? `<span class="material-order-receipt"><span>${escape(entry.date ? dateLabel(entry.date) : "日付不明")}</span><span>${quantity(entry.quantity)} セット</span></span>` : "—";
        return `<tr><td>${escape(dateLabel(entry.date))}</td><td><span class="material-history-action" data-material-kind="${escape(entry.action)}">${escape(ACTIONS[entry.action] || entry.action)}</span></td><td>${escape(materialName(materialFor(entry.materialId)))}</td><td class="material-number">${escape(amount)}</td><td class="material-order-receipts">${receipt}</td><td class="material-history-job">${job}${entry.jobId ? actionButton("job", "案件を開く", `data-material-job="${escape(entry.jobId)}"`) : ""}</td><td class="material-history-note">${escape(entry.note || "—")}<small>${escape(entry.actor || "")}</small></td></tr>`;
      }).join("") || emptyRow(7, snapshot.history.length ? "条件に合う履歴がありません。" : "履歴はまだありません。"));
    }

    function render() {
      if (!bound) bind();
      if (!panel || !dialog || !form) return;
      if (!permitted()) {
        snapshot = null;
        snapshotSource = null;
        refreshQueued = false;
        failedDrafts.clear();
        panel.hidden = true;
        ["#material-summary", "#material-stock-rows", "#material-order-rows", "#material-history-rows", "#material-unresolved-list"].forEach((selector) => markup(selector, ""));
        markup("#material-form-material", "");
        markup("#material-history-material", '<option value="all">すべての材料</option>');
        text("#material-dialog-summary", "");
        text("#material-status", "");
        text("#material-form-status", "");
        ["#material-orders-count", "#material-history-count", "#material-unresolved-count", "#material-initialized-at"].forEach((selector) => text(selector, ""));
        hide("#material-unresolved", true);
        form.reset?.();
        if (dialog.open) {
          if (typeof dialog.close === "function") dialog.close();
          else dialog.open = false;
        }
        renderControls();
        return;
      }
      if (!snapshot) {
        markup("#material-summary", "");
        markup("#material-stock-rows", emptyRow(6, refreshing ? "碓井材料在庫を読み込み中…" : "更新すると碓井材料在庫を表示します。"));
        markup("#material-order-rows", emptyRow(9, "碓井材料在庫を読み込んでください。"));
        markup("#material-history-rows", emptyRow(6, "碓井材料在庫を読み込んでください。"));
        hide("#material-unresolved", true);
        renderControls();
        return;
      }
      const materials = snapshot.materials;
      const orders = snapshot.orders.slice().sort((a, b) => {
        const aOpen = number(a.remainingQuantity) > 0;
        const bOpen = number(b.remainingQuantity) > 0;
        if (aOpen !== bOpen) return aOpen ? -1 : 1;
        return (aOpen ? String(a.expectedDate || "9999").localeCompare(String(b.expectedDate || "9999")) || String(a.orderDate || "").localeCompare(String(b.orderDate || "")) : String(b.orderDate || "").localeCompare(String(a.orderDate || ""))) || String(a.id).localeCompare(String(b.id));
      });
      const outstanding = orders.filter((order) => number(order.remainingQuantity) > 0);
      const receiptsByOrder = new Map();
      snapshot.history.forEach((entry) => {
        if (entry.action !== "receive" || !entry.orderId || number(entry.quantity) <= 0) return;
        const key = String(entry.orderId);
        if (!receiptsByOrder.has(key)) receiptsByOrder.set(key, []);
        receiptsByOrder.get(key).push(entry);
      });
      const shortage = materials.filter((material) => number(material.stockQuantity) < 0).length;
      const zero = materials.filter((material) => number(material.stockQuantity) === 0).length;
      markup("#material-summary", `<p><span>管理する材料</span><strong>${quantity(materials.length)}<small>種類</small></strong></p><p><span>入庫待ち</span><strong>${quantity(outstanding.reduce((sum, order) => sum + number(order.remainingQuantity), 0))}<small>セット</small></strong></p><p class="${shortage ? "material-summary-danger" : ""}"><span>不足している材料</span><strong>${quantity(shortage)}<small>種類</small></strong></p><p class="${zero ? "material-summary-warning" : ""}"><span>在庫なし</span><strong>${quantity(zero)}<small>種類</small></strong></p>`);
      markup("#material-stock-rows", materials.map((material) => {
        const stock = number(material.stockQuantity);
        const tone = stock < 0 ? "material-stock-negative" : stock === 0 ? "material-stock-zero" : "";
        const badge = stock < 0 ? `不足 ${quantity(Math.abs(stock))} セット` : stock === 0 ? "在庫なし" : "";
        const attributes = `data-material-id="${escape(material.id)}"`;
        return `<tr class="${tone}"><th scope="row"><strong>${escape(material.code || "—")}</strong><small>${escape(material.name || "")}</small></th><td>${escape(material.shape || "—")}<small>${escape(material.specification || "")}</small></td><td class="material-number material-stock-value"><strong>${quantity(stock)}</strong>${badge ? `<span class="material-stock-badge">${escape(badge)}</span>` : ""}</td><td class="material-number">${quantity(material.onOrderQuantity)}</td><td>${escape(material.nextExpectedDate ? dateLabel(material.nextExpectedDate) : number(material.onOrderQuantity) > 0 ? "予定未定" : "—")}</td><td><div class="material-actions">${actionButton("order", "発注", attributes)}${actionButton("adjust", "在庫調整", attributes)}</div></td></tr>`;
      }).join("") || emptyRow(6, "登録済みの材料がありません。"));
      text("#material-orders-count", `${orders.length}件（入庫待ち ${outstanding.length}件）`);
      markup("#material-order-rows", orders.map((order) => {
        const attributes = `data-material-order="${escape(order.id)}"`;
        const remaining = number(order.remainingQuantity);
        const received = number(order.receivedQuantity);
        const canceled = number(order.canceledQuantity);
        const overdue = remaining > 0 && order.expectedDate && order.expectedDate < (options.today?.() || "");
        const { key: status, label: statusLabel } = purchaseStatus(order);
        const receiptDetails = purchaseReceipts(order, receiptsByOrder.get(String(order.id)) || []);
        const actions = remaining > 0 ? `<div class="material-actions">${actionButton("receive", "入庫を記録", attributes)}${actionButton("cancel", "残数を取消", attributes)}</div>` : "—";
        return `<tr data-material-order-status="${status}"><th scope="row">${escape(materialName(materialFor(order.materialId)))}${order.note ? `<small>${escape(order.note)}</small>` : ""}</th><td>${escape(dateLabel(order.orderDate))}</td><td class="material-number">${quantity(order.quantity)}</td><td class="material-number">${quantity(received)}</td><td class="material-number"><strong>${quantity(remaining)}</strong></td><td class="${overdue ? "material-overdue" : ""}">${escape(dateLabel(order.expectedDate))}${overdue ? "<small>予定日を過ぎています</small>" : ""}</td><td class="material-order-receipts">${receiptDetails}</td><td><span class="material-order-status" data-material-order-status="${status}">${statusLabel}</span>${canceled > 0 ? `<small>取消 ${quantity(canceled)} セット</small>` : ""}</td><td>${actions}</td></tr>`;
      }).join("") || emptyRow(9, "発注はまだありません。材料を選んで発注を記録してください。"));
      const unresolved = snapshot.unresolved;
      hide("#material-unresolved", unresolved.length === 0);
      text("#material-unresolved-count", `${unresolved.length}件`);
      markup("#material-unresolved-list", unresolved.map((job) => `<div class="material-unresolved-row"><div><strong>${escape(job.product || "製品名未設定")}</strong><span>${quantity(job.quantity)} セット · 型：${escape(job.specShape || "未設定")}</span><small>${escape(job.reason || "材料の対応を確認してください。")}</small></div>${actionButton("job", "注文を確認・修正", `data-material-job="${escape(job.id)}"`)}</div>`).join(""));
      text("#material-initialized-at", snapshot.initializedAt ? `開始残高の登録：${dateLabel(snapshot.initializedAt)}` : "");
      renderHistory();
      renderControls();
    }

    function setSnapshot(data) {
      const source = permitted() && data && Array.isArray(data.materials) ? data : null;
      if (source !== snapshotSource && source !== snapshot) {
        revision += 1;
        snapshotSource = source;
        snapshot = source ? { ...source, materials: source.materials, orders: Array.isArray(source.orders) ? source.orders : [], history: Array.isArray(source.history) ? source.history : [], unresolved: Array.isArray(source.unresolved) ? source.unresolved : [] } : null;
      }
      render();
    }

    function invalidate({ refresh: shouldRefresh = false } = {}) {
      revision += 1;
      setSnapshot(null);
      if (shouldRefresh && permitted()) {
        refreshQueued = true;
        return refresh();
      }
      return null;
    }

    function refresh() {
      if (!bound) bind();
      if (!panel || !permitted() || typeof options.api?.getMaterialInventory !== "function") return Promise.resolve(null);
      if (pending) { refreshQueued = true; return Promise.resolve(null); }
      if (refreshPromise) return refreshPromise;
      refreshQueued = true;
      refreshPromise = (async () => {
        let result = null;
        while (refreshQueued && !pending && permitted()) {
          refreshQueued = false;
          result = await readInventory();
        }
        return result;
      })().finally(() => {
        refreshPromise = null;
        refreshing = false;
        renderControls();
        if (refreshQueued && !pending && permitted()) void refresh();
      });
      return refreshPromise;
    }

    async function readInventory() {
      const requestRevision = ++readRevision;
      const startRevision = revision;
      refreshing = true;
      options.onRefreshStart?.();
      setStatus("#material-status", "碓井材料在庫を読み込み中…");
      render();
      try {
        const data = await options.api.getMaterialInventory();
        if (requestRevision !== readRevision || startRevision !== revision || pending || !permitted()) return null;
        if (!Array.isArray(data?.materials)) throw new Error("碓井材料在庫の応答を確認できませんでした。");
        setSnapshot(data);
        setStatus("#material-status", "碓井材料在庫を更新しました。", "success");
        notifySnapshot();
        return data;
      } catch (error) {
        if (requestRevision !== readRevision || startRevision !== revision || !permitted()) return null;
        const message = `碓井材料在庫を読み込めませんでした。更新ボタンで再試行できます。${error?.message ? ` ${error.message}` : ""}`;
        setStatus("#material-status", message, "error");
        notifyError(message);
        return null;
      }
    }

    function updateDialogSummary() {
      if (!draft || !snapshot) return;
      const material = materialFor(field("materialId")?.value || draft.materialId);
      const order = orderFor(draft.orderId);
      const balance = material ? `現在庫 ${quantity(material.stockQuantity)} セット` : "";
      text("#material-dialog-summary", [materialName(material), order ? `発注日 ${dateLabel(order.orderDate)} / 未入庫 ${quantity(order.remainingQuantity)} セット` : balance, draft.action === "cancel" ? "未入庫の残数をすべて取り消します。入庫済みの在庫は変わりません。" : ""].filter(Boolean).join(" · "));
    }

    function open(action, button) {
      if (!permitted() || pending || !snapshot || !OPERATIONS[action] || !dialog || !form) return;
      rememberFailedDraft();
      const target = button?.dataset.materialOrder || button?.dataset.materialId;
      const recovered = target ? failedDrafts.get(`${action}:${target}`) : Array.from(failedDrafts.values()).reverse().find((saved) => saved.draft.action === action);
      const order = orderFor(button?.dataset.materialOrder || recovered?.draft.orderId) || recovered?.order;
      const selected = materialFor(order?.materialId || button?.dataset.materialId || recovered?.draft.materialId) || snapshot.materials[0];
      if (!selected || (["receive", "cancel"].includes(action) && (!order || (!recovered && number(order.remainingQuantity) <= 0)))) return;
      form.reset?.();
      draft = { action, materialId: selected.id, orderId: order?.id || "" };
      attempt = recovered?.attempt || null;
      const operation = OPERATIONS[action];
      text("#material-dialog-title", operation.title);
      text("#material-date-label", `${operation.date}（必須）`);
      text("#material-quantity-label", action === "adjust" ? "増減数量（セット・必須）" : "数量（セット・必須）");
      text("#material-quantity-help", action === "adjust" ? "増やすときは正の数、減らすときはマイナスを入力します。" : action === "receive" ? `一部の入庫も記録できます。今回の上限は${quantity(order.remainingQuantity)} セットです。` : "本体とカブセで1セット。整数で入力してください。");
      text("#material-note-label", ["adjust", "cancel"].includes(action) ? "理由（必須）" : "備考（任意）");
      hide("#material-field-material", ["receive", "cancel"].includes(action));
      hide("#material-field-quantity", action === "cancel");
      hide("#material-field-expected", action !== "order");
      markup("#material-form-material", snapshot.materials.map((item) => `<option value="${escape(item.id)}">${escape(materialName(item))}</option>`).join(""));
      field("materialId").value = String(selected.id);
      field("materialId").required = ["order", "adjust"].includes(action);
      field("date").value = options.today?.() || new Date().toISOString().slice(0, 10);
      const amount = field("quantity");
      amount.value = action === "receive" ? String(number(order.remainingQuantity)) : "";
      amount.required = action !== "cancel";
      amount.min = action === "adjust" ? "" : "1";
      amount.max = action === "receive" ? String(number(order.remainingQuantity)) : "";
      field("expectedDate").value = "";
      field("expectedDate").required = action === "order";
      field("note").required = ["adjust", "cancel"].includes(action);
      field("note").value = "";
      if (recovered) Object.entries(recovered.values).forEach(([name, value]) => { if (field(name)) field(name).value = value; });
      setStatus("#material-form-status", recovered?.message || "", recovered ? "error" : "");
      updateDialogSummary();
      renderControls();
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.open = true;
    }

    function readPayload() {
      if (!draft) throw new Error("入力画面を開き直してください。");
      const action = draft.action;
      const date = String(field("date")?.value || "");
      const note = String(field("note")?.value || "").trim();
      const amountText = String(field("quantity")?.value || "").trim();
      const amount = Number(amountText);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${OPERATIONS[action].date}を入力してください。`);
      if (["adjust", "cancel"].includes(action) && !note) throw new Error("理由を入力してください。");
      if (action !== "cancel" && (!amountText || !Number.isSafeInteger(amount) || (action === "adjust" ? amount === 0 : amount <= 0))) throw new Error(action === "adjust" ? "増減数量を0以外の整数で入力してください。" : "数量を1以上の整数で入力してください。");
      if (["receive", "cancel"].includes(action)) {
        const payload = { orderId: draft.orderId, date, ...(action === "receive" ? { quantity: amount } : {}), note };
        const retrying = attempt?.failed && attempt.signature === `${action}:${JSON.stringify(payload)}`;
        const order = orderFor(draft.orderId);
        if (!retrying && (!order || number(order.remainingQuantity) <= 0)) throw new Error("この発注の未入庫数量がありません。在庫を更新してください。");
        if (!retrying && action === "receive" && amount > number(order.remainingQuantity)) throw new Error(`入庫数量は未入庫の${quantity(order.remainingQuantity)} セット以内で入力してください。`);
        return payload;
      }
      const materialId = String(field("materialId")?.value || "");
      if (!materialFor(materialId)) throw new Error("材料を選んでください。");
      if (action === "adjust") return { materialId, date, quantity: amount, note };
      const expectedDate = String(field("expectedDate")?.value || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) throw new Error("入庫予定日を入力してください。");
      if (expectedDate < date) throw new Error("入庫予定日は発注日以降を入力してください。");
      return { materialId, orderDate: date, quantity: amount, expectedDate, note };
    }

    async function submit(event) {
      event?.preventDefault?.();
      if (pending || !permitted() || !draft) return;
      let payload;
      try { payload = readPayload(); }
      catch (error) { setStatus("#material-form-status", error.message, "error"); return; }
      const operation = OPERATIONS[draft.action];
      if (typeof options.api?.[operation.api] !== "function") {
        setStatus("#material-form-status", "碓井材料在庫に接続できません。画面を更新してください。", "error");
        return;
      }
      const signature = `${draft.action}:${JSON.stringify(payload)}`;
      const operationKey = `${draft.action}:${payload.orderId || payload.materialId}`;
      if (!attempt || attempt.signature !== signature) attempt = { signature, requestId: `material-${root.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`, failed: false };
      pending = true;
      revision += 1;
      const startRevision = revision;
      readRevision += 1;
      refreshing = false;
      setStatus("#material-form-status", "反映中です。完了するまでお待ちください。", "pending");
      renderControls();
      let succeeded = false;
      let acceptedSnapshot = false;
      try {
        const data = await options.api[operation.api]({ ...payload, requestId: attempt.requestId });
        if (!Array.isArray(data?.materials)) throw new Error("保存後の応答を確認できませんでした。");
        succeeded = true;
        failedDrafts.delete(operationKey);
        if (permitted() && startRevision === revision) {
          setSnapshot(data);
          acceptedSnapshot = true;
          setStatus("#material-status", `${operation.submit}：完了しました。`, "success");
        }
      } catch (error) {
        attempt.failed = true;
        if (permitted()) {
          const unknown = error?.name === "TypeError" || /network|fetch|通信|接続|timeout|タイムアウト|応答/i.test(`${error?.code || ""} ${error?.message || ""}`);
          const message = unknown ? `通信結果を確認できません。反映済みの可能性があります。入力を変えずに再試行すると、同じ操作として確認します。${error?.message ? ` ${error.message}` : ""}` : `保存できませんでした。入力を確認して再試行してください。${error?.message ? ` ${error.message}` : ""}`;
          setStatus("#material-form-status", message, "error");
          rememberFailedDraft();
          notifyError(message);
        }
      } finally {
        pending = false;
        if (succeeded) {
          attempt = null;
          close();
        }
        renderControls();
      }
      if (succeeded && acceptedSnapshot) notifySnapshot();
      if (refreshQueued && !refreshPromise && permitted()) void refresh();
    }

    function onClick(event) {
      const button = event.target?.closest?.("[data-material-action]");
      if (!button || button.disabled) return;
      const action = button.dataset.materialAction;
      if (action === "close") { event.preventDefault?.(); close(); return; }
      if (!permitted()) return;
      if (action === "refresh") { void refresh(); return; }
      if (action === "job") { options.onJob?.(button.dataset.materialJob); return; }
      open(action, button);
    }

    function bind() {
      if (bound || !doc) return;
      panel = query('[data-view-panel="materials"]');
      dialog = query("#material-dialog");
      form = query("#material-form");
      if (!panel || !dialog || !form) return;
      bound = true;
      panel.addEventListener?.("click", onClick);
      dialog.addEventListener?.("click", (event) => {
        if (event.target === dialog) { event.preventDefault?.(); close(); }
        else onClick(event);
      });
      dialog.addEventListener?.("cancel", (event) => { event.preventDefault?.(); close(); });
      form.addEventListener?.("submit", submit);
      form.addEventListener?.("input", () => {
        if (attempt?.failed) {
          try { if (`${draft.action}:${JSON.stringify(readPayload())}` !== attempt.signature) text("#material-submit", OPERATIONS[draft.action].submit); }
          catch { text("#material-submit", OPERATIONS[draft.action].submit); }
        }
      });
      field("materialId")?.addEventListener?.("change", updateDialogSummary);
      const historyMaterial = query("#material-history-material");
      const historyAction = query("#material-history-action");
      const historySearch = query("#material-history-search");
      historyMaterial?.addEventListener?.("change", () => { filters.material = historyMaterial.value; renderHistory(); });
      historyAction?.addEventListener?.("change", () => { filters.action = historyAction.value; renderHistory(); });
      historySearch?.addEventListener?.("input", () => { filters.search = historySearch.value; renderHistory(); });
    }

    if (doc?.readyState === "loading") doc.addEventListener?.("DOMContentLoaded", () => { bind(); render(); }, { once: true });
    else bind();
    return Object.freeze({ setSnapshot, render, refresh, invalidate });
  }

  root.MaterialInventoryUI = Object.freeze({ create });
})(globalThis);
