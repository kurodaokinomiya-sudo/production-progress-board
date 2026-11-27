(function (root) {
  "use strict";

  const labels = {
    use: "使用", receive: "入庫", process: "下加工", sell: "販売（未加工）", order: "発注",
    transfer: "保管場所の移動", classify: "区分確認", count: "調整",
    threshold: "発注点の変更", editOrder: "発注変更", cancelOrder: "発注残の取消", reverse: "記録の取消",
    correctQuantity: "数量訂正", setNote: "備考の変更",
  };
  const submitLabels = {
    use: "使用を記録", receive: "入庫を記録", process: "下加工を記録", sell: "販売を記録",
    order: "発注を記録", count: "調整を記録",
    threshold: "発注点を保存", editOrder: "発注の変更を保存", cancelOrder: "発注残を取り消す", reverse: "記録を取り消す",
    correctQuantity: "数量の訂正を保存",
  };
  const overReceiptLabel = "超過を含めて入庫を記録";
  const completeReceiptLabel = "入庫を記録して完了";
  const laterCountText = "後日の調整がある在庫は、その調整時の数量を基準にします。";
  const consuming = new Set(["use", "sell", "process"]);
  const entryTypes = new Set(["use", "sell", "process", "order", "receive", "count", "threshold"]);
  const processedPhases = new Set(["processed", "colored"]);
  const unprocessedLabel = "未加工";
  const processedLabel = "加工済";
  const placeLabels = { "1F": "1階", "2F": "2階", "保土田": "保土田（旧）" };
  // Follow the beta sheet's inventory list while keeping the ledger's part IDs.
  const betaParts = new Map([
    ["hernia", "ヘルニア"],
    ["hernia-lever", "ヘルニアレバー"],
    ["cottonman", "コットマン"],
    ["cottonman:colored", "コットマン_色しっぽ"],
    ["stepped-kerrison", "段付きケリソン"],
    ["long", "長型"],
    ["long-lever", "長型レバー"],
    ["ring-lever", "輪付きレバー"],
    ["bent-lever", "くの字レバー"],
    ["m1-lever", "M1レバー"],
    ["tm-stanche", "TMスタンチェ"],
    ["tm-stanche-lever", "TMスタンチェレバー"],
    ["stepped-hernia", "段付きヘルニア"],
    ["stepped-hernia-lever", "段付きヘルニアレバー"],
    ["gruewald", "グリワルト"],
    ["m2-lever", "M2レバー"],
    ["double-force-frame", "倍力フレーム"],
    ["double-force-lever", "倍力レバー"],
    ["small-forceps", "小小鉗子"],
    ["legacy--5jUghc0ifJkDHKDawwaH7TodaDPNgDqKytiya8t474", "TAレバー"],
    ["nishihata-king", "西端"],
    ["nishihata-lever-king", "西端レバー"],
    ["maeda-lever", "前田式レバー"],
    ["gruewald-lever", "グリワルトレバー"],
    ["small-forceps-lever", "小小鉗子レバー"],
    ["meniscus-lever", "メニスカスレバー"],
    ["meniscus-ratchet", "メニスカスラチェット"],
    ["meniscus-base", "メニスカス台座"],
    ["link-nut", "リンクナッツ"],
    ["push-link", "プッシュリンク"],
  ].map(([id, name], order) => [id, { name, order }]));
  const hiddenParts = new Set([
    "nishihata-niigata", "nishihata-lever-niigata",
    "legacy-UyPJu1vSaMpnbuDaNzPTENQ2DzkGDH6ZbQL9qEiWZHU", // グリワルトかぶせ（長）
    "legacy-_CP8nLzhMxpLF6TcRDJqKpVYeUBtPAVHcla0o7-pwHE", // グリワルトかぶせ（短）
  ]);
  const presets = [1, 2, 5, 10, 20, 30, 50];
  const numbers = new Intl.NumberFormat("ja-JP");
  const dates = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeZone: "Asia/Tokyo" });
  const qty = (n) => numbers.format(n);
  const dateLabel = (value) => value ? dates.format(new Date(value)) : "—";
  const dueLabel = (value) => value ? dateLabel(value) : "未定";
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const normalize = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s_]+/g, "");
  const key = (partId, variant) => JSON.stringify([partId, variant]);
  const errorMessage = (error) => String(error?.message || "在庫を確認して、もう一度お試しください。").replace(/(?:Exception: |Error: |CASTING_STOCK_[A-Z_]+:\s*)+/g, "");
  const button = (action, title, { partId = "", id = "", type = "", variant = "", name = "", disabled = false, pending = false, describedBy = "", slot = "" } = {}) =>
    '<button type="button" class="button button-secondary" data-casting-action="' + action + '" data-part-id="' + escape(partId) +
    '" data-entry-id="' + escape(id) + '" data-entry-type="' + escape(type) + '" data-variant="' + escape(variant) + '"' +
    (slot ? ' data-casting-slot="' + escape(slot) + '"' : "") + (name ? ' aria-label="' + escape(name) + '"' : "") +
    (describedBy ? ' aria-describedby="' + escape(describedBy) + '"' : "") +
    (pending ? ' aria-disabled="true"' : "") + (disabled ? " disabled" : "") + ">" + escape(title) + "</button>";
  const numericCell = (number) => '<td class="material-number">' + (number == null ? "—" : qty(number)) + "</td>";
  const shell = (label, field) => '<label class="field"><span>' + escape(label) + "</span>" + field + "</label>";
  const option = (id, label, selected) => '<option value="' + escape(id) + '"' + (id === selected ? " selected" : "") + ">" + escape(label) + "</option>";
  const select = (label, name, values, selected) =>
    shell(label, '<select name="' + name + '" required>' + values.map(([id, title]) => option(id, title, selected)).join("") + "</select>");
  const input = (label, name, type, value, attributes = "") =>
    shell(label, '<input name="' + name + '" type="' + type + '" value="' + escape(value) + '"' + (attributes ? " " + attributes : "") + ">");
  const noteField = (value = "") => '<label class="field casting-note-field"><span>備考（任意）</span>' +
    '<textarea name="note" maxlength="500" rows="2">' + escape(value) + "</textarea></label>";

  function create(options) {
    const doc = root.document;
    const find = (id) => doc.getElementById(id);
    const panel = doc.querySelector("[data-view-panel='castingStock']");
    const dialog = find("casting-stock-dialog");
    const form = find("casting-stock-form");
    const modalContent = find("casting-dialog-content");
    const submit = find("casting-submit");
    const statusFilter = find("casting-filter");
    let snapshot = null;
    let stock = new Map();
    let read = null;
    let readFailed = false;
    let historyRead = null;
    let generation = 0;
    let draft = null;
    let composingNote = false;
    let noteRenderQueued = false;
    const notes = new Map();
    const noteEdits = new Map();
    const pendingSaves = new Set();
    const failedSaves = new Map();
    const attempts = new Map();

    const field = (name) => form.elements.namedItem(name);
    const partFor = (id) => snapshot?.items.find((item) => item.id === id);
    const variantFor = (item, id) => item?.variants.find((variant) => variant.id === id);
    const variantLabel = (item, id) => variantFor(item, id)?.label || (id === "single" ? "区分なし" : "");
    const orderFor = (id) => snapshot?.orders.find((order) => order.id === id);
    const editableOrderFor = (id) => orderFor(id) || snapshot?.completedOrders?.find((order) => order.id === id);
    const variantTotal = (item, variant) => stock.get(key(item.id, variant)) ?? 0;
    const pendingOrders = (item) => snapshot.orders.filter((order) => order.partId === item.id && order.remaining > 0);
    const completedOrders = (item) => (snapshot.completedOrders || []).filter((order) => order.partId === item.id);
    const openingOrders = () => snapshot.openingOrders || [];
    const orderRemainder = (orders) => orders.reduce((sum, order) => sum + (order.remaining ?? order.quantity), 0);
    const orderVersions = (orders) => orders.map(({ id, revision }) => ({ id, revision })).sort((first, second) => first.id.localeCompare(second.id));
    const processed = (item) => item.variants.filter((variant) => processedPhases.has(variant.id));
    const rawVariant = (item) => variantFor(item, "raw") ? "raw" : "single";
    const rowId = (item, phase) => phase === "colored" ? item.id + ":colored" : item.id;
    const noteFor = (partId, phase) => notes.get(key(partId, phase)) ?? { note: "", revision: "" };
    const noteControlId = (item, phase) => "casting-row-note-" + rowId(item, phase);
    const storedRowName = (item, phase) => phase === "colored" ? "色しっぽ" + item.name : item.name;
    const rowName = (item, phase) => item ? (betaParts.get(rowId(item, phase))?.name ??
      storedRowName(item, phase).replace(/[（(]\s*(?:未加工|加工済み?)\s*[）)]\s*$/u, "").trim()) : "";
    const rowVariants = (item, phase) => item.variants.filter((variant) => phase ? variant.id === phase : variant.id !== "colored");
    const variantSuffix = (item, id) => processedPhases.has(id) && processed(item).length > 1
      ? (id === "colored" ? "色しっぽ" : "通常") : "";

    function phaseLabel(item, id) {
      if (id === "raw" || id === "single") return unprocessedLabel + "（1階）";
      if (id === "colored") return "加工済（2階・色しっぽ）";
      return id === "processed" ? processedLabel + "（2階）" : variantLabel(item, id);
    }

    function setStatus(id, message, tone = "") {
      const element = find(id);
      element.textContent = message;
      element.dataset.tone = tone;
    }

    function itemStatus(item, phase, variants) {
      const orders = phase ? [] : snapshot.initialized ? pendingOrders(item) : openingOrders().filter((order) => order.partId === item.id);
      if (item.openingUnconfirmed) return { unconfirmed: true, checks: [], orders };
      const unknown = phase ? 0 : variantTotal(item, "unclassified");
      const checks = variants.filter((variant) => variant.threshold != null &&
        variantTotal(item, variant.id) + unknown <= variant.threshold && !orders.some((order) => order.variant === variant.id));
      return { unconfirmed: unknown > 0, checks, orders };
    }

    function orderSummary(order, area) {
      const detailsId = "casting-order-" + area + "-" + order.id;
      const title = "発注 " + qty(order.quantity) + "個";
      const orderTitle = snapshot.initialized
        ? button("editOrder", title, { partId: order.partId, id: order.id, describedBy: detailsId, pending: pendingSaves.has(order.partId) })
        : "<strong>" + title + "</strong>";
      const balance = area === "completed" ? "入庫済 " + qty(order.received) + "個" : "発注残 " + qty(order.remaining ?? order.quantity) + "個";
      const unreceived = order.shortClosed ? Math.max(0, order.quantity - order.received) : 0;
      return '<div class="casting-order-summary">' + orderTitle + '<div id="' + escape(detailsId) + '" class="casting-order-info">' +
        '<strong class="casting-ordered">' + balance + "</strong><small>発注日 " + dateLabel(order.date) +
        "</small><small>入荷予定日 " + dueLabel(order.dueDate) + "</small>" +
        (unreceived ? "<small>入荷なし " + qty(unreceived) + "個で完了</small>" : "") + "</div></div>";
    }

    function floorCount(item, label, variants) {
      const values = variants.map((id) => '<span class="casting-phase-count"><strong>' +
        qty(variantTotal(item, id)) + "</strong></span>").join("");
      return '<td class="material-number casting-floor"><span class="casting-floor-label" aria-hidden="true">' + label + "</span>" +
        (item.openingUnconfirmed ? "—" : values || "—") + "</td>";
    }

    function rowActions(item, phase, remainder) {
      const describedBy = "casting-part-" + rowId(item, phase);
      const entryButton = (type, variant, disabled = false, slot = "") => {
        const suffix = type === "process" ? variantSuffix(item, variant) : "";
        const title = labels[type] + (suffix ? "（" + suffix + "）" : "");
        return button("entry", title, { partId: item.id, type, variant, disabled, describedBy, slot, pending: pendingSaves.has(item.id) });
      };
      const raw = rawVariant(item);
      const hasStock = (variant) => !item.openingUnconfirmed && variantTotal(item, variant) > 0;
      if (phase) return '<div class="casting-row-actions">' +
        entryButton("use", phase, !hasStock(phase)) + entryButton("count", phase) + "</div>";
      const variants = processed(item).map((variant) => variant.id);
      const useVariant = variantFor(item, "processed") ? "processed" : raw;
      const actions = [
        ...variants.map((id) => entryButton("process", id, !hasStock(raw))),
        entryButton("use", useVariant, !hasStock(useVariant)),
        entryButton(remainder > 0 ? "receive" : "order", raw, remainder > 0 && item.openingUnconfirmed, "procurement"),
        entryButton("count", raw),
      ];
      return '<div class="casting-row-actions">' + actions.join("") + "</div>";
    }

    function noteCell(item, phase, name) {
      const saved = noteFor(item.id, phase);
      const edit = noteEdits.get(key(item.id, phase));
      const controlId = noteControlId(item, phase);
      const cell = '<td class="casting-remarks" id="' + escape(controlId + "-cell") + '"><span class="casting-floor-label" aria-hidden="true">備考</span>';
      if (!edit || edit.saving) {
        const note = edit?.value ?? saved.note;
        const hint = note ? "備考を編集" : "備考を入力";
        return cell + '<button type="button" class="casting-remark-trigger" id="' + escape(controlId) +
          '" aria-label="' + escape(hint + "（" + name + "）") + '" data-empty="' + !note +
          (note ? '" aria-describedby="' + escape(controlId + "-text") : "") +
          '" data-casting-action="editNote" data-part-id="' + escape(item.id) + '" data-variant="' + escape(phase) + '"' +
          (pendingSaves.has(item.id) ? ' aria-disabled="true"' : "") + '><span id="' + escape(controlId + "-text") + '">' +
          escape(note || hint) + "</span></button></td>";
      }
      const changedElsewhere = saved.revision !== edit.expectedRevision;
      const needsReload = edit.conflict && !changedElsewhere;
      const attributes = { partId: item.id, variant: phase };
      const status = changedElsewhere ? "別の端末で備考が更新されました。" : edit.error;
      return cell + '<div class="casting-remark-editor"><textarea id="' + escape(controlId) +
        '" name="stockNote" autocomplete="off" data-casting-note-input data-part-id="' + escape(item.id) + '" data-variant="' + escape(phase) +
        '" aria-label="' + escape(name + "の備考") + '" maxlength="500" rows="2">\n' + escape(edit.value) + "</textarea>" +
        (status ? '<small class="casting-remark-feedback" role="status">' + escape(status) + "</small>" : "") +
        (changedElsewhere ? '<small class="casting-note">最新の備考　' + escape(saved.note || "空欄") + "</small>" : "") +
        '<div class="casting-remark-actions">' +
        (needsReload ? button("refresh", "最新を読み込む") : button("saveNote", changedElsewhere ? "入力内容で保存" : "保存", {
          ...attributes, id: saved.revision, name: changedElsewhere ? "入力内容で保存（" + name + "の備考）" : name + "の備考を保存",
          disabled: edit.value.trim() === saved.note, pending: pendingSaves.has(item.id),
        })) + button("cancelNote", "キャンセル", { ...attributes, name: name + "の備考編集をキャンセル" }) +
        "</div></div></td>";
    }

    function renderTable() {
      if (!snapshot) return;
      if (composingNote) {
        noteRenderQueued = true;
        return;
      }
      noteRenderQueued = false;
      const query = normalize(find("casting-search").value);
      const filter = snapshot.initialized ? statusFilter.value : "";
      const rows = snapshot.items.filter((item) => !hiddenParts.has(item.id)).flatMap((item) => (variantFor(item, "colored") ? ["", "colored"] : [""]).map((phase) => {
        const id = rowId(item, phase);
        const name = rowName(item, phase);
        const aliases = [storedRowName(item, phase),
          ...(item.aliases || []).filter((alias) => normalize(alias).includes("色しっぽ") === Boolean(phase))];
        const variants = rowVariants(item, phase);
        return { id, item, phase, name, aliases, variants, order: betaParts.get(id)?.order ?? betaParts.size,
          status: itemStatus(item, phase, variants) };
      }))
        .filter(({ name, aliases }) => !query || [name, ...aliases].some((value) => normalize(value).includes(query)))
        .filter(({ status }) => filter !== "low" || status.checks.length)
        .filter(({ status }) => filter !== "ordered" || status.orders.length)
        .filter(({ status }) => filter !== "unconfirmed" || status.unconfirmed)
        .sort((first, second) => first.order - second.order);
      const visibleTotal = rows.filter(({ item }) => !item.openingUnconfirmed)
        .reduce((sum, { item, variants }) => sum + variants.reduce((total, variant) => total + variantTotal(item, variant.id), 0), 0);
      find("casting-result-count").textContent = qty(rows.length) + "品目・" + qty(visibleTotal) + "個";
      const rowMarkup = rows.map(({ id, item, phase, name, variants, status }) => {
        const historyButton = snapshot.initialized ? button("history", "履歴", {
          partId: item.id, variant: phase, name: name + "の履歴",
        }) : "";
        const nameCell = '<th scope="row" class="casting-name"><div class="casting-name-actions"><button id="casting-part-' + escape(id) +
          '" type="button" class="casting-part" data-casting-action="details" data-part-id="' + escape(item.id) +
          '" data-variant="' + escape(phase) + '">' + escape(name) + "</button>" + historyButton + "</div></th>";
        const remainder = orderRemainder(status.orders);
        const state = [
          remainder ? '<ul class="casting-order-list">' + status.orders.map((order) =>
            "<li>" + orderSummary(order, "list") + "</li>").join("") + "</ul>" : "",
          pendingSaves.has(item.id) ? '<span class="casting-pending">保存中…</span>' : "",
          ...(snapshot.initialized ? status.checks.map((variant) => '<span class="casting-warning">' +
            (processedPhases.has(variant.id) ? "要補充 " + escape(phaseLabel(item, variant.id)) : "要発注") + "</span>") : []),
          status.unconfirmed ? '<span class="casting-pending">' +
            (item.openingUnconfirmed ? "数量未登録" : "区分未確認 " + qty(variantTotal(item, "unclassified")) + "個") + "</span>" : "",
        ].join("");
        return '<tr data-casting-part="' + escape(id) + '">' + nameCell +
          floorCount(item, unprocessedLabel, phase ? [] : [rawVariant(item)]) +
          floorCount(item, processedLabel, variants.filter((variant) => processedPhases.has(variant.id)).map((variant) => variant.id)) +
          '<td class="casting-statuses">' + state + "</td>" +
          (snapshot.initialized ? '<td class="casting-row-action">' + rowActions(item, phase, remainder) + "</td>" + noteCell(item, phase, name) : "") + "</tr>";
      });
      const tbody = find("casting-stock-rows");
      const active = doc.activeElement;
      const returnFocus = dialog._returnFocus;
      const restoreActive = active && tbody.contains(active);
      const restoreReturn = returnFocus && tbody.contains(returnFocus);
      const noteSelection = restoreActive && active.hasAttribute("data-casting-note-input")
        ? { id: active.id, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection, scrollTop: active.scrollTop }
        : null;
      const columnCount = snapshot.initialized ? 6 : 4;
      tbody.innerHTML = rowMarkup.join("") ||
        '<tr><td colspan="' + columnCount + '" class="material-empty">該当する品目がありません。検索語や絞り込みを変更してください。</td></tr>';
      if (restoreActive || restoreReturn) {
        const triggers = [...tbody.querySelectorAll("[data-casting-action]")];
        const replacement = (previous) => triggers.find((element) => {
          if (element.disabled || element.dataset.partId !== previous.dataset.partId) return false;
          if (previous.dataset.castingSlot) return element.dataset.castingSlot === previous.dataset.castingSlot;
          return ["castingAction", "entryType", "entryId", "variant"].every((field) => element.dataset[field] === previous.dataset[field]);
        }) || find(previous.closest(".casting-remarks")?.id)?.querySelector("textarea, .casting-remark-trigger") ||
          triggers.find((element) => element.dataset.castingAction === "details" &&
          element.dataset.partId === previous.dataset.partId && element.dataset.variant === (previous.dataset.variant === "colored" &&
            previous.dataset.entryType !== "process" ? "colored" : "")) || (snapshot.initialized ? statusFilter : find("casting-search"));
        if (restoreActive) {
          const editor = noteSelection && find(noteSelection.id);
          if (editor instanceof root.HTMLTextAreaElement) {
            editor.focus({ preventScroll: true });
            editor.setSelectionRange(noteSelection.start, noteSelection.end, noteSelection.direction);
            editor.scrollTop = noteSelection.scrollTop;
          } else replacement(active).focus({ preventScroll: true });
        }
        if (restoreReturn) dialog._returnFocus = replacement(returnFocus);
      }
    }

    function renderPanel() {
      const ready = Boolean(snapshot);
      const managed = snapshot?.initialized === true;
      find("casting-stock-content").hidden = !ready;
      panel.dataset.managed = String(managed);
      panel.querySelector('[data-casting-action="history"]').hidden = !managed;
      const startButton = panel.querySelector('[data-casting-action="start"]');
      startButton.hidden = !ready || managed || !options.canStart();
      startButton.disabled = pendingSaves.has("");
      find("casting-status-filter").hidden = !managed;
      if (!ready) return;
      find("casting-stock-source-status").textContent = managed
        ? "HAKOBIでの管理開始日 " + dateLabel(snapshot.initializedAt)
        : "現行の在庫表から表示中。所有者が管理を開始すると、HAKOBIで在庫を記録できます。" +
          (openingOrders().length ? "入荷待ち " + qty(openingOrders().length) + "件を引き継ぎます。" : "");
      find("casting-stock-head").innerHTML = '<tr><th scope="col">品目</th><th scope="col" class="material-number">' + unprocessedLabel +
        '</th><th scope="col" class="material-number">' + processedLabel + '</th><th scope="col">発注残・状態</th>' +
        (managed ? '<th scope="col">操作</th><th scope="col">備考</th>' : "") + "</tr>";
      renderTable();
    }

    function accept(next) {
      if (!next || !Array.isArray(next.items) || !Array.isArray(next.stock)) throw new Error("在庫の読み込み結果を確認できません。更新してください。");
      if (snapshot?.initialized && (!next.initialized || next.revision <= snapshot.revision)) return false;
      if (snapshot && !next.initialized && snapshot.sourceRevision === next.sourceRevision) return false;
      snapshot = next;
      stock = new Map();
      notes.clear();
      for (const note of next.notes || []) notes.set(key(note.partId, note.variant), note);
      for (const entry of next.stock) {
        const balance = key(entry.partId, entry.variant);
        stock.set(balance, (stock.get(balance) ?? 0) + entry.quantity);
      }
      renderPanel();
      updateEntrySummary();
      return true;
    }

    function refresh({ passive = false } = {}) {
      if (!options.canEdit() || read) return read;
      const attemptGeneration = generation;
      if (!snapshot || !passive) setStatus("casting-stock-status", "鋳物の在庫を読み込み中…", "pending");
      read = options.api.getCastingInventory().then((result) => {
        if (generation !== attemptGeneration || !options.canEdit()) return;
        accept(result);
        readFailed = false;
        setStatus("casting-stock-status", "");
      }).catch((error) => {
        if (generation !== attemptGeneration || !options.canEdit()) return;
        readFailed = true;
        setStatus("casting-stock-status", errorMessage(error), "error");
      }).finally(() => {
        if (generation === attemptGeneration) read = null;
      });
      return read;
    }

    function editRowNote(item, phase) {
      if (pendingSaves.has(item.id)) return;
      const saved = noteFor(item.id, phase);
      noteEdits.set(key(item.id, phase), { value: saved.note, expectedRevision: saved.revision });
      renderTable();
      find(noteControlId(item, phase))?.focus({ preventScroll: true });
    }

    async function saveRowNote(item, phase, expectedNoteRevision) {
      const id = key(item.id, phase);
      const edit = noteEdits.get(id);
      const saved = noteFor(item.id, phase);
      if (!edit || pendingSaves.has(item.id) || expectedNoteRevision !== saved.revision ||
          (edit.conflict && edit.expectedRevision === saved.revision)) return;
      const note = edit.value.trim();
      if (note === saved.note || note.length > 500) return;
      const payload = edit.attempt?.note === note && edit.attempt.expectedNoteRevision === expectedNoteRevision
        ? edit.attempt : { type: "setNote", partId: item.id, variant: phase, note, expectedNoteRevision, date: options.today(), opId: root.crypto.randomUUID() };
      edit.attempt = payload;
      edit.expectedRevision = expectedNoteRevision;
      edit.saving = true;
      edit.error = "";
      edit.conflict = false;
      const attemptGeneration = generation;
      const isCurrent = () => generation === attemptGeneration && options.canEdit();
      pendingSaves.add(item.id);
      setStatus("casting-stock-status", "");
      renderTable();
      try {
        const next = await options.api.saveCastingInventoryChange(payload);
        if (!isCurrent()) return;
        pendingSaves.delete(item.id);
        noteEdits.delete(id);
        if (!accept(next)) renderTable();
        setStatus("casting-stock-status", "備考を保存しました。", "success");
      } catch (error) {
        if (!isCurrent()) return;
        edit.error = errorMessage(error);
        edit.conflict = /CASTING_STOCK_NOTE_CHANGED:/.test(String(error?.message || ""));
        if (edit.conflict) {
          edit.attempt = null;
          if (read) await read;
          if (!isCurrent()) return;
          await refresh({ passive: true });
        }
        if (!isCurrent()) return;
        pendingSaves.delete(item.id);
        edit.saving = false;
        renderTable();
        setStatus("casting-stock-status", "備考を保存できませんでした。" + edit.error, "error");
      }
    }

    function render() {
      if (!options.canEdit()) return;
      if (!snapshot && !readFailed) void refresh();
      if (snapshot && !snapshot.initialized) {
        panel.querySelector('[data-casting-action="start"]').hidden = !options.canStart();
      }
    }

    function show(title, markup, submitLabel = "", initialFocus = "") {
      historyRead = null;
      find("casting-dialog-title").textContent = title;
      modalContent.innerHTML = markup;
      submit.textContent = submitLabel;
      submit.hidden = !submitLabel;
      submit.disabled = false;
      setStatus("casting-dialog-status", "");
      if (!dialog.open) options.openDialog(dialog, initialFocus);
      else {
        const target = (initialFocus && modalContent.querySelector(initialFocus)) || modalContent.querySelector("input, select, button")
          || form.querySelector("[data-casting-action='close']");
        target.focus({ preventScroll: true });
      }
      dialog._editBaseline = editSnapshot();
    }

    function detail(item, phase) {
      draft = null;
      const variants = rowVariants(item, phase).filter((variant) => variant.id !== "unclassified" || variantTotal(item, variant.id) > 0);
      const body = variants.map((variant) => '<tr><th scope="row">' + escape(phaseLabel(item, variant.id)) + "</th>" +
        numericCell(item.openingUnconfirmed ? null : variantTotal(item, variant.id)) + numericCell(variant.threshold) + "</tr>").join("");
      const orders = itemStatus(item, phase, variants).orders;
      const orderLines = orders.map((order) => "<li><div>" + orderSummary(order, "detail") +
        (order.note ? '<small class="casting-note">' + escape(order.note) + "</small>" : "") + "</div>" +
        (snapshot.initialized ? '<div class="casting-inline-actions">' +
          button("entry", "この発注を入庫", { partId: item.id, type: "receive", id: order.id, disabled: item.openingUnconfirmed }) +
          button("cancelOrder", "残数を取り消す", { id: order.id }) + "</div>" : "") + "</li>").join("");
      const completedLines = phase ? "" : completedOrders(item).map((order) => "<li><div>" + orderSummary(order, "completed") +
        (order.note ? '<small class="casting-note">' + escape(order.note) + "</small>" : "") + "</div></li>").join("");
      const history = snapshot.history.find((entry) => entry.type === "use" && entry.partId === item.id &&
        (entry.variant === "colored") === Boolean(phase) && !entry.reversed);
      const actions = [];
      if (snapshot.initialized) {
        actions.push(button("entry", "調整", { partId: item.id, type: "count", variant: phase }));
        if (!item.openingUnconfirmed) {
          actions.push(button("entry", "発注点を変更", { partId: item.id, type: "threshold", variant: phase }));
          if (!phase) {
            actions.push(orders.length
              ? button("entry", "追加発注", { partId: item.id, type: "order", slot: "additional" })
              : button("entry", "発注なしで入庫", { partId: item.id, type: "receive", slot: "unplanned" }));
            actions.push(button("entry", labels.sell, { partId: item.id, type: "sell", disabled: variantTotal(item, rawVariant(item)) === 0 }));
          }
        }
      }
      show(rowName(item, phase), '<div class="material-table-wrap casting-detail-wrap" tabindex="0" role="region" aria-label="加工区分ごとの在庫">' +
        '<table class="material-table"><thead><tr><th scope="col">加工区分</th><th scope="col" class="material-number">在庫（個）</th>' +
        '<th scope="col" class="material-number">発注点</th></tr></thead><tbody>' + body + "</tbody></table></div>" +
        (actions.length ? '<div class="casting-inline-actions">' + actions.join("") + "</div>" : "") +
        (item.openingUnconfirmed ? '<p class="casting-warning">「調整」で現物の数量を登録してください。</p>' : "") +
        (orderLines ? '<h3>入荷待ち</h3><ul class="casting-event-list">' + orderLines + "</ul>" : "") +
        (completedLines ? '<h3>入庫済みの発注</h3><ul class="casting-event-list">' + completedLines + "</ul>" : "") +
        (history ? "<p>最終使用日 " + dateLabel(history.date) + "</p>" : "") +
        (!phase && item.unitPrice != null ? "<p>現行表の単価 " + qty(item.unitPrice) + "円</p>" : "") +
        (!phase && item.note ? '<p class="casting-note"><strong>現行表の備考</strong><br>' + escape(item.note) + "</p>" : "") +
         (snapshot.initialized ? '<div class="casting-inline-actions">' +
           button("history", "この品目の履歴", { partId: item.id, variant: phase }) + "</div>" : ""));
    }

    function historyHeading(entry, item) {
      const suffix = entry.type === "process" && item ? variantSuffix(item, entry.toVariant) : labels[entry.targetType];
      return (labels[entry.type] || "在庫変更") + (suffix ? "（" + suffix + "）" : "");
    }

    function stockChangeText(item, { variant, location, before, after }) {
      const label = [variantLabel(item, variant), placeLabels[location] || location].filter(Boolean).join(" ");
      return label + " " + qty(before) + " → " + qty(after) + "個";
    }

    function correctionOrderText({ date, receivedBefore, receivedAfter, remainingBefore, remainingAfter }) {
      return [
        date ? dateLabel(date) + "の発注" : "関連する発注",
        balanceText("入庫済", receivedBefore, receivedAfter),
        balanceText("発注残", remainingBefore, remainingAfter),
      ].join(" ／ ");
    }

    function canCancelRecord(entry) {
      if (!entry || entry.reversed || entry.cancellationBlocked) return false;
      return entry.cancellation ? entry.cancellation.expectedRevision != null : entry.canReverse;
    }

    function historyMarkup(entries, phase) {
      const lines = entries.map((entry) => {
        const item = partFor(entry.partId);
        const change = (entry.changes || []).map((adjustment) => stockChangeText(item, adjustment)).join(" ／ ");
        const allocated = (entry.orderAllocations || []).reduce((sum, order) => sum + order.quantity, 0);
        const heading = historyHeading(entry, item);
        const corrected = entry.correctedQuantity != null;
        const isCorrection = entry.type === "correctQuantity";
        const previous = entry.previousOrder;
        const orderChange = previous ? [
          balanceText("発注数", previous.quantity, entry.quantity),
          previous.date !== entry.orderDate ? "発注日 " + dateLabel(previous.date) + " → " + dateLabel(entry.orderDate) : "",
          previous.dueDate !== entry.dueDate ? "入荷予定日 " + dueLabel(previous.dueDate) + " → " + dueLabel(entry.dueDate) : "",
        ].filter(Boolean).join(" ／ ") : "";
        const recordedQuantity = entry.correctedQuantity ?? entry.quantity;
        const quantity = isCorrection ? "　" + qty(entry.previousQuantity) + "個 → " + qty(entry.quantity) + "個"
          : recordedQuantity != null && !previous
            ? "　" + (entry.type === "receive" ? "実入庫 " : "") + qty(recordedQuantity) + "個" : "";
        const actions = [];
        if (entry.correction && !entry.reversed) {
          actions.push(button("correctQuantity", "数量を訂正", {
            partId: entry.partId, id: entry.id, name: heading + "の数量を訂正（" + dateLabel(entry.date) + "、" + qty(recordedQuantity) + "個）",
          }));
        }
        const blockedReasonId = entry.cancellationBlocked ? "casting-cancel-reason-" + entry.id : "";
        if (entry.type !== "reverse" && !isCorrection && entry.type !== "setNote") {
          actions.push(button("reverse", "取り消す", {
            partId: entry.partId, id: entry.id, name: heading + "の記録を取り消す", disabled: !canCancelRecord(entry),
            describedBy: blockedReasonId || "casting-undo-order", pending: pendingSaves.has(entry.partId),
          }));
        }
        return '<li><div><strong>' + escape(heading) + "　" + escape(item && rowName(item, phase || entry.variant)) +
          quantity + '</strong><small>' + dateLabel(entry.date) +
          (entry.reversed ? "　取り消し済み" : "") + "</small>" +
          (entry.targetDate ? "<small>対象の記録 " + dateLabel(entry.targetDate) + "</small>" : "") +
          (corrected ? "<small>記録当初 " + qty(entry.quantity) + "個</small>" : "") +
          (change ? "<small>" + (corrected ? "記録時の在庫 " : "") + escape(change) + "</small>" : "") +
          (orderChange ? "<small>" + escape(orderChange) + "</small>" : "") +
          (entry.orderChanges || []).map((order) => "<small>" + escape(correctionOrderText(order)) + "</small>").join("") +
          (entry.laterCountPreserved ? "<small>" + laterCountText + "</small>" : "") +
          (allocated && !entry.orderChanges?.length ? "<small>" + (entry.type === "reverse" ? "発注残へ復元" : corrected ? "記録時の発注残に充当" : "発注残に充当") +
            " " + qty(allocated) + "個</small>" : "") +
          (entry.excessQuantity > 0 ? "<small>" + (corrected ? "記録時の" : "") + "超過入庫分 " + qty(entry.excessQuantity) + "個</small>" : "") +
          (entry.closedRemainder > 0 ? "<small>" + (entry.type === "reverse" ? "入荷待ちに戻した残数 " :
            corrected ? "記録時に入荷なしで完了 " : "今回で入庫を完了・入荷なし ") +
            qty(entry.closedRemainder) + "個</small>" : "") +
          (entry.note || entry.type === "setNote" ? '<small class="casting-note">' + escape(entry.note || "備考を削除") + "</small>" : "") +
          (blockedReasonId ? '<small id="' + escape(blockedReasonId) + '">' + escape(entry.cancellationBlocked) + "</small>" : "") +
          "</div>" + (actions.length ? '<div class="casting-inline-actions">' + actions.join("") + "</div>" : "") + "</li>";
      });
      return lines.length ? '<p class="casting-history-help" id="casting-undo-order">取り消す記録を選ぶと、現在庫や発注残への反映を確認できます。</p>' +
        '<ol class="casting-event-list">' + lines.join("") + "</ol>" : "<p>HAKOBIでの記録はまだありません。</p>";
    }

    async function history(partId, phase) {
      draft = null;
      if (!partId) {
        show("鋳物在庫の履歴", historyMarkup(snapshot.history));
        return;
      }
      const item = partFor(partId);
      if (!item) return;
      show(rowName(item, phase) + "の履歴", "");
      setStatus("casting-dialog-status", "履歴を読み込み中…", "pending");
      const request = { entries: [] };
      historyRead = request;
      const isCurrent = () => dialog.open && historyRead === request && options.canEdit();
      try {
        const entries = await options.api.getCastingInventoryHistory(partId);
        if (!isCurrent()) return;
        request.entries = entries.filter((entry) => {
          if (entry.partId !== partId) return false;
          return phase ? entry.variant === phase || entry.toVariant === phase || entry.changes?.some((change) => change.variant === phase)
            : entry.variant !== "colored" || entry.changes?.some((change) => change.variant !== "colored");
        });
        modalContent.innerHTML = historyMarkup(request.entries, phase);
        setStatus("casting-dialog-status", "");
      } catch (error) {
        if (!isCurrent()) return;
        modalContent.innerHTML = '<div class="casting-inline-actions">' + button("history", "履歴を再読み込み", { partId, variant: phase }) + "</div>";
        setStatus("casting-dialog-status", errorMessage(error), "error");
      }
    }

    function editOrder(orderId) {
      const order = editableOrderFor(orderId);
      if (!order) {
        setStatus(dialog.open ? "casting-dialog-status" : "casting-stock-status",
          "この発注が更新されました。発注の一覧を確認してください。", "error");
        return;
      }
      draft = { mode: "entry", type: "editOrder", order, partId: order.partId, date: options.today() };
      show(rowName(partFor(order.partId)) + "・発注を編集",
        '<p id="casting-entry-summary" class="casting-entry-summary" role="status"></p>' +
        '<div class="form-grid">' +
        input("発注数量（個）", "quantity", "number", order.quantity, 'inputmode="numeric" required min="1" step="1"') +
        input("発注日", "orderDate", "date", order.date, "required") +
        input("入荷予定日（任意）", "dueDate", "date", order.dueDate) + noteField(order.note) + "</div>",
        submitLabels.editOrder);
      updateEntrySummary();
    }

    function openQuantityCorrection(record) {
      const item = partFor(record.partId);
      const { quantity, expectedRevision } = record.correction;
      draft = { mode: "entry", type: "correctQuantity", record, partId: record.partId, expectedRevision, date: options.today() };
      show(rowName(item, record.variant) + "・数量を訂正",
        "<p>" + dateLabel(record.date) + "の「" + escape(historyHeading(record, item)) + "」</p>" +
        '<div class="form-grid">' + input("訂正後の数量（個）", "quantity", "number", quantity,
          'inputmode="numeric" required min="' + (record.type === "count" ? 0 : 1) + '" step="1"') + "</div>" +
        '<div id="casting-entry-summary" class="casting-entry-summary" role="status"></div>',
        submitLabels.correctQuantity, '[name="quantity"]');
      field("quantity").select();
      updateEntrySummary();
    }

    function quantityCorrectionSummary(summary, quantityField, quantity) {
      const { record } = draft;
      const previous = record.correction.quantity;
      const lines = [balanceText("記録の数量", previous, quantity)];
      submit.disabled = true;
      if (!Number.isSafeInteger(quantity)) {
        if (quantityField.value || quantityField.validity.badInput) {
          lines.push(record.type === "count" ? "訂正後の数量は0以上の整数を入力してください。" : "訂正後の数量は1以上の整数を入力してください。");
        }
      } else if (quantity !== previous) {
        try {
          const preview = root.CastingStock.previewQuantityCorrection(record, quantity);
          const item = partFor(draft.partId);
          lines.push(...preview.stockChanges.map((adjustment) => stockChangeText(item, adjustment)));
          if (!preview.stockChanges.length) lines.push("現在庫の数量は変わりません。");
          lines.push(...preview.orderChanges.map(correctionOrderText));
          if (preview.laterCountPreserved) lines.push(laterCountText);
          submit.disabled = false;
        } catch (error) {
          lines.push(errorMessage(error));
        }
      }
      summary.innerHTML = lines.map((line) => "<div>" + escape(line) + "</div>").join("");
    }

    function receiptExcess(entry, quantity) {
      return entry.type === "receive" && entry.expectedOrders?.length && Number.isSafeInteger(quantity)
        ? Math.max(0, quantity - entry.expectedOrderRemainder) : 0;
    }

    function receiptShortfall(entry, quantity) {
      return entry.type === "receive" && entry.expectedOrders?.length && Number.isSafeInteger(quantity) && quantity > 0
        ? Math.max(0, entry.expectedOrderRemainder - quantity) : 0;
    }

    function entry(item, type, selection, orderId = "", slot = "") {
      if (!item || !entryTypes.has(type) || (item.openingUnconfirmed && !["count", "order"].includes(type))) return;
      const phase = selection === "colored" && ["count", "threshold"].includes(type) ? selection : "";
      const choices = rowVariants(item, phase).filter((variant) => variant.id !== "unclassified");
      const canChoosePhase = ["count", "threshold"].includes(type) && choices.length > 1;
      const variant = type === "use" ? selection : phase || rawVariant(item);
      const destination = type === "process" ? selection : "";
      if (!variantFor(item, variant) || (type === "process" && !processed(item).some(({ id }) => id === destination))) return;
      const linked = orderId && orderFor(orderId);
      if (orderId && (!linked || linked.partId !== item.id)) {
        setStatus("casting-dialog-status", "発注残が更新されました。品目の詳細を開き直してください。", "error");
        return;
      }
      const orders = linked ? [linked] : pendingOrders(item);
      const remainder = orderRemainder(orders);
      if (slot === "unplanned" && remainder > 0) {
        setStatus("casting-dialog-status", "発注残が更新されました。一覧で入庫を選び直してください。", "error");
        return;
      }
      if (slot === "procurement" && (type === "order") !== (remainder === 0)) {
        renderTable();
        return;
      }
      const expectedOrders = type === "receive" ? orderVersions(orders) : null;
      const expectedOrderRemainder = expectedOrders || slot === "procurement" ? remainder : null;
      const current = variantTotal(item, variant);
      const max = consuming.has(type) ? current : null;
      const today = options.today();
      const numberAttrs = 'inputmode="numeric" step="1"';
      const label = type === "count" ? "調整後の数量（個）" : "数量（個）";
      let markup = '<p id="casting-entry-summary" class="casting-entry-summary" role="status"></p>';
      if (type === "receive") markup += '<p id="casting-over-receipt" class="casting-over-receipt" role="status" hidden></p>';
      if (canChoosePhase) {
        markup += select(type === "count" ? "調整する在庫" : "対象の在庫", "variant",
          choices.map(({ id }) => [id, phaseLabel(item, id)]), variant);
      }
      if (type === "threshold") {
        markup += input("発注点（個）", "threshold", "number", variantFor(item, variant)?.threshold ?? "", numberAttrs + ' min="0"');
      } else {
        if (type !== "count") {
          markup += '<fieldset class="casting-presets"><legend>数量を選ぶ</legend>' + presets.map((value) =>
            '<button type="button" class="button button-secondary" data-casting-action="preset" data-quantity="' + value +
            '" aria-pressed="false"' + (max != null && value > max ? " disabled" : "") + ">" + value + "個</button>").join("") + "</fieldset>";
        }
        markup += input(label, "quantity", "number", "", numberAttrs + ' required min="' + (type === "count" ? "0" : "1") +
          '"' + (max == null ? "" : ' max="' + max + '"'));
        if (expectedOrders?.length === 1) {
          markup += '<div id="casting-complete-receipt" hidden><label class="bulk-check">' +
            '<input type="checkbox" name="completeOrder" value="1" aria-describedby="casting-short-receipt-note" disabled>今回で入庫を完了</label>' +
            '<p id="casting-short-receipt-note" class="casting-entry-summary"></p></div>';
        } else if (expectedOrders?.length > 1) {
          markup += '<p id="casting-multiple-receipts" class="casting-entry-summary" hidden>' +
            '今回で完了する発注は、品目詳細の「この発注を入庫」から選べます。</p>';
        }
        if (type === "count") markup += noteField();
        else {
          markup += '<details class="casting-entry-options"><summary>日付・備考</summary><div class="form-grid">' +
            input(type === "order" ? "発注日" : "日付", "date", "date", today, "required") +
            (type === "order" ? input("入荷予定日（任意）", "dueDate", "date", "") : "") + noteField() + "</div></details>";
        }
      }
      draft = {
        type, mode: "entry", partId: item.id, variant, destination, selection, slot, orderId, date: today, expectedOrderRemainder, expectedOrders,
        expectedQuantity: type === "count" ? current : null,
      };
      const suffix = destination && variantSuffix(item, destination);
      const actionLabel = slot === "additional" ? "追加発注" : slot === "unplanned" ? "発注なしで入庫" : labels[type];
      const title = rowName(item, variant) + "・" + actionLabel + (suffix ? "（" + suffix + "）" : "");
      const focus = canChoosePhase ? '[name="variant"]'
        : root.matchMedia?.("(pointer: coarse)")?.matches && type !== "count" && type !== "threshold"
          ? '[data-casting-action="preset"]:not(:disabled)' : "";
      show(title, markup, submitLabels[type], focus);
      updateEntrySummary();
    }

    function balanceText(label, current, after) {
      return label + " " + qty(current) + (Number.isSafeInteger(after) && after >= 0 && after !== current ? " → " + qty(after) : "") + "個";
    }

    function updateEntrySummary() {
      const summary = find("casting-entry-summary");
      if (!summary || draft?.mode !== "entry") return;
      const { type, variant, destination, orderId, expectedQuantity, expectedOrderRemainder, expectedOrders } = draft;
      const quantityField = field("quantity");
      const quantity = quantityField?.validity.valid ? quantityField.valueAsNumber : NaN;
      if (type === "correctQuantity") {
        quantityCorrectionSummary(summary, quantityField, quantity);
        return;
      }
      if (type === "editOrder") {
        const order = draft.order;
        const latest = editableOrderFor(order.id);
        summary.textContent = latest?.revision !== order.revision
          ? "発注内容が更新されました。内容を確認してから編集を開き直してください。"
          : [
            balanceText("発注数", order.quantity, quantity),
            "入庫済 " + qty(order.received) + "個",
            balanceText("発注残", order.remaining, Math.max(0, quantity - order.received)),
          ].join(" ／ ");
        return;
      }
      const item = partFor(draft.partId);
      for (const preset of modalContent.querySelectorAll('[data-casting-action="preset"]')) {
        preset.setAttribute("aria-pressed", String(Number(preset.dataset.quantity) === quantity));
      }
      const changes = [];
      if (Number.isSafeInteger(quantity) && type !== "count") changes.push("選択した数量 " + qty(quantity) + "個");
      if (type === "threshold") {
        changes.push("未入力で発注点を解除します。");
      } else if (type === "order" || type === "receive") {
        const order = orderId && orderFor(orderId);
        const orders = orderId ? (order ? [order] : []) : pendingOrders(item);
        const remainder = orderRemainder(orders);
        const shortage = receiptShortfall(draft, quantity);
        const finish = field("completeOrder");
        if (finish) {
          finish.disabled = shortage === 0;
          if (finish.disabled) finish.checked = false;
          find("casting-complete-receipt").hidden = finish.disabled;
          find("casting-short-receipt-note").textContent = shortage ? (finish.checked ? "残り " + qty(shortage) + "個は入荷なしとして完了します。"
            : "選ぶと残り " + qty(shortage) + "個の入荷待ちを終了します。") : "";
        }
        const multiple = find("casting-multiple-receipts");
        if (multiple) multiple.hidden = shortage === 0;
        const completeOrder = finish?.checked === true;
        const warning = find("casting-over-receipt");
        if (warning) {
          const excess = receiptExcess(draft, quantity);
          warning.hidden = excess === 0;
          warning.textContent = excess ? "発注残より" + qty(excess) + "個多く入庫します。実際に届いた " + qty(quantity) + "個を在庫に加えます。" : "";
          submit.textContent = excess ? overReceiptLabel : completeOrder ? completeReceiptLabel : submitLabels.receive;
        }
        if (expectedOrderRemainder != null && remainder !== expectedOrderRemainder) {
          changes.push("発注残が " + qty(remainder) + "個に更新されました。操作を選び直してください。");
          summary.textContent = changes.join(" ／ ");
          return;
        }
        if (expectedOrders && JSON.stringify(orderVersions(orders)) !== JSON.stringify(expectedOrders)) {
          changes.push("発注内容が更新されました。内容を確認してから操作を選び直してください。");
          summary.textContent = changes.join(" ／ ");
          return;
        }
        const after = completeOrder ? 0 : type === "order" ? remainder + quantity : Math.max(0, remainder - quantity);
        changes.push(balanceText("発注残", remainder, after));
        if (type === "receive") {
          const current = variantTotal(item, variant);
          changes.push(balanceText(phaseLabel(item, variant), current, current + quantity));
        }
      } else {
        const current = type === "count" ? expectedQuantity : variantTotal(item, variant);
        if (item.openingUnconfirmed) {
          changes.push(phaseLabel(item, variant) + " 数量未登録" + (Number.isSafeInteger(quantity) ? " → " + qty(quantity) + "個" : ""));
        } else {
          changes.push(balanceText(phaseLabel(item, variant), current, type === "count" ? quantity : current - quantity));
        }
        if (destination) {
          const completed = variantTotal(item, destination);
          changes.push(balanceText(phaseLabel(item, destination), completed, completed + quantity));
        }
      }
      summary.textContent = changes.join(" ／ ");
    }

    function openRecordCancellation(record) {
      if (!canCancelRecord(record) || pendingSaves.has(record.partId)) return;
      const item = partFor(record.partId);
      const plan = record.cancellation;
      const quantity = record.correctedQuantity ?? record.quantity;
      const summary = "<p>" + escape(rowName(item, record.variant)) + "の" + dateLabel(record.date) + "の「" +
        escape(historyHeading(record, item)) + "」" + (quantity == null ? "" : " " + qty(quantity) + "個") + "を取り消します。</p>";
      let consequences = "";
      if (plan) {
        const changes = [
          ...plan.stockChanges.map((change) => stockChangeText(item, change)),
          ...plan.orderChanges.map(correctionOrderText),
        ];
        consequences = changes.length
          ? '<ul class="casting-entry-summary">' + changes.map((change) => "<li>" + escape(change) + "</li>").join("") + "</ul>"
          : '<p class="casting-entry-summary">現在庫・発注残の増減 0個</p>';
        if (plan.laterCountPreserved) consequences += '<p class="casting-entry-summary">' + laterCountText + "</p>";
      } else {
        const undoRemainder = record.undoOrderRemainder ?? (record.closedRemainder > 0 ? record.quantity + record.closedRemainder : null);
        if (undoRemainder > 0) consequences = "<p>実入庫 " + qty(record.undoOrderReceived ?? quantity) +
          "個を戻し、発注残 " + qty(undoRemainder) + "個を入荷待ちに戻します。</p>";
      }
      draft = { mode: "confirm", type: "reverse", id: record.id, partId: record.partId, date: options.today(), expectedRevision: plan?.expectedRevision };
      show("在庫の記録を取り消す", summary + consequences, submitLabels.reverse);
    }

    function showConfirmation(type, id = "") {
      if (type === "reverse") {
        const record = (historyRead?.entries ?? snapshot.history).find((entry) => entry.id === id);
        openRecordCancellation(record);
        return;
      }
      const order = type === "cancelOrder" ? orderFor(id) : null;
      if (type === "cancelOrder" && !order) return;
      const partId = order?.partId || "";
      if (pendingSaves.has(partId)) return;
      draft = { mode: "confirm", type, id, partId, date: options.today() };
      if (type === "start") {
        if (!options.canStart() || snapshot.initialized) return;
        draft.sourceRevision = snapshot.sourceRevision;
        const total = snapshot.stock.reduce((sum, entry) => sum + entry.quantity, 0);
        const orders = openingOrders().map((order) => "<li>" + escape(rowName(partFor(order.partId))) + " " + qty(order.quantity) +
          "個（入荷予定 " + dateLabel(order.dueDate) + "）</li>").join("");
        show("HAKOBIで鋳物在庫を管理する",
          "<p>現行表の " + qty(total) + "個を開始在庫として取り込みます。以後の鋳物在庫はHAKOBIで記録してください。</p>" +
          "<p>未加工の在庫は1階、加工済の在庫は2階にまとめて取り込みます。</p>" +
          (orders ? "<h3>引き継ぐ入荷待ち</h3><ul>" + orders + "</ul>" : ""),
          "開始在庫を取り込む");
      } else if (type === "cancelOrder") {
        draft.expectedOrderRevision = order.revision;
        show("発注残を取り消す", "<p>" + escape(rowName(partFor(order.partId))) + "の発注残 " + qty(order.remaining) +
          "個を取り消す記録を残します。</p>", submitLabels[type]);
      }
    }

    function editSnapshot() {
      return draft?.mode === "entry" ? JSON.stringify([...new FormData(form)]) : null;
    }

    function reopenFailedSave(recovery) {
      const { previous, fields, baseline, conflict, partId } = recovery;
      if (failedSaves.get(partId) !== recovery || !options.canEdit()) return true;
      if (doc.querySelector("dialog[open]") || pendingSaves.has(partId)) return false;
      options.activate();
      if (conflict && ["correctQuantity", "reverse"].includes(previous.type)) {
        void reopenConflictingHistoryChange(recovery);
        return true;
      }

      if (conflict) {
        if (previous.type === "editOrder") editOrder(previous.order.id);
        else if (["start", "cancelOrder"].includes(previous.type)) showConfirmation(previous.type, previous.id);
        else if (previous.mode === "entry") entry(partFor(partId), previous.type, previous.selection, previous.orderId, previous.slot);
      }
      const updated = dialog.open;
      if (!updated) {
        draft = previous;
        show(recovery.title, recovery.markup, recovery.submitLabel);
        dialog._editBaseline = baseline;
        if (!conflict && recovery.opId) attempts.set(recovery.fingerprint, recovery.opId);
      }

      const original = new Map(baseline ? JSON.parse(baseline) : []);
      for (const [name, value] of Object.entries(fields || {})) {
        if (updated && previous.type === "editOrder" && value === original.get(name)) continue;
        const control = field(name);
        if (!control) continue;
        if (control.type === "checkbox") control.checked = !conflict && value === control.value;
        else control.value = value;
      }
      if (updated && field("variant")) field("variant").dispatchEvent(new Event("change", { bubbles: true }));
      updateEntrySummary();
      if (conflict && !updated) submit.disabled = true;
      setStatus("casting-dialog-status", conflict && updated
        ? recovery.message + " 最新の内容に入力を復元しました。確認してから保存してください。"
        : recovery.message, "error");
      failedSaves.delete(partId);
      return true;
    }

    async function reopenConflictingHistoryChange(recovery) {
      const { partId, previous, fields, title } = recovery;
      const correction = previous.type === "correctQuantity";
      const entered = correction ? "<p>入力した数量 " + qty(Number(fields.quantity)) + "個</p>" : "";
      draft = null;
      show(title, entered);
      setStatus("casting-dialog-status", "最新の履歴を読み込み中…", "pending");
      const request = { entries: [] };
      historyRead = request;
      const isCurrent = () => dialog.open && historyRead === request && options.canEdit();
      try {
        const entries = await options.api.getCastingInventoryHistory(partId);
        if (!isCurrent()) return;
        const targetId = correction ? previous.record.id : previous.id;
        const record = entries.find((entry) => entry.id === targetId);
        if (correction && record?.correction && !record.reversed) {
          openQuantityCorrection(record);
          field("quantity").value = fields.quantity;
          field("quantity").select();
          updateEntrySummary();
          if (record.correction.quantity === Number(fields.quantity)) {
            setStatus("casting-dialog-status", "入力した数量はすでに記録されています。", "success");
          } else {
            setStatus("casting-dialog-status", recovery.message + " 最新の内容に入力を復元しました。確認してから保存してください。", "error");
          }
        } else if (!correction && canCancelRecord(record)) {
          openRecordCancellation(record);
          setStatus("casting-dialog-status", "最新の在庫と発注残を反映しました。内容を確認してから取り消してください。", "error");
        } else if (!correction && record?.reversed) {
          setStatus("casting-dialog-status", "この記録はすでに取り消されています。", "success");
        } else if (!correction && record?.cancellationBlocked) {
          setStatus("casting-dialog-status", record.cancellationBlocked, "error");
        } else {
          setStatus("casting-dialog-status", "対象の記録が更新されました。品目の履歴を確認してください。", "error");
        }
        failedSaves.delete(partId);
      } catch (error) {
        if (!isCurrent()) return;
        modalContent.innerHTML = entered + '<div class="casting-inline-actions">' +
          button("retryHistoryChange", "履歴を再読み込み", { partId }) + "</div>";
        setStatus("casting-dialog-status", errorMessage(error), "error");
      }
    }

    async function save(event) {
      event.preventDefault();
      if (!draft || submit.disabled || !options.canEdit()) return;
      const { type, partId } = draft;
      const isStart = type === "start";
      if (pendingSaves.has(partId) || (isStart && !options.canStart())) return;
      let request = { type, date: draft.date };
      const fields = draft.mode === "entry" ? Object.fromEntries(new FormData(form)) : null;
      if (draft.mode === "entry") {
        const quantity = Number(fields.quantity);
        const orderDate = type === "editOrder" ? fields.orderDate : fields.date;
        if ((type === "order" || type === "editOrder") && fields.dueDate && fields.dueDate < orderDate) {
          const due = field("dueDate");
          const details = due.closest("details");
          if (details) details.open = true;
          setStatus("casting-dialog-status", "入荷予定日は発注日以降にしてください。", "error");
          due.focus();
          return;
        }
        if (type === "correctQuantity") {
          request = { ...request, targetId: draft.record.id, expectedRevision: draft.expectedRevision, quantity };
        } else if (type === "editOrder") {
          request = {
            type, date: draft.date, orderId: draft.order.id, expectedOrderRevision: draft.order.revision,
            quantity, orderDate: fields.orderDate, dueDate: fields.dueDate, note: fields.note,
          };
        } else {
          request = {
            ...request, date: fields.date || draft.date, note: fields.note || "",
            partId: draft.partId, variant: draft.variant,
          };
          if (draft.destination) request.toVariant = draft.destination;
          if (draft.orderId) request.orderId = draft.orderId;
          if (fields.dueDate) request.dueDate = fields.dueDate;
          if (draft.expectedOrderRemainder != null) request.expectedOrderRemainder = draft.expectedOrderRemainder;
          if (draft.expectedOrders) request.expectedOrders = draft.expectedOrders;
          if (type === "threshold") request.threshold = fields.threshold === "" ? null : Number(fields.threshold);
          else request.quantity = quantity;
          if (type === "count") request.expectedQuantity = draft.expectedQuantity;
          if (fields.completeOrder && draft.expectedOrders?.length === 1 && receiptShortfall(draft, quantity)) request.completeOrder = true;
          if (receiptExcess(draft, quantity)) {
            if (event.submitter !== submit) {
              submit.focus({ preventScroll: true });
              setStatus("casting-dialog-status", "届いた数量を確認して「" + overReceiptLabel + "」を押してください。", "error");
              return;
            }
            request.confirmOverReceipt = true;
          }
        }
      } else if (type === "cancelOrder") {
        request.orderId = draft.id;
        if (draft.expectedOrderRevision != null) request.expectedOrderRevision = draft.expectedOrderRevision;
      } else if (type === "reverse") {
        request.targetId = draft.id;
        if (draft.expectedRevision != null) {
          request.type = "reverseSelected";
          request.expectedRevision = draft.expectedRevision;
        }
      }

      const fingerprint = JSON.stringify(request);
      if (!isStart && !attempts.has(fingerprint)) {
        if (attempts.size >= 20) attempts.delete(attempts.keys().next().value);
        attempts.set(fingerprint, root.crypto.randomUUID());
      }
      const attemptGeneration = generation;
      const isCurrent = () => generation === attemptGeneration && options.canEdit();
      const opId = attempts.get(fingerprint);
      const recovery = {
        partId, previous: draft, fields, fingerprint, opId, baseline: dialog._editBaseline, markup: modalContent.innerHTML,
        title: find("casting-dialog-title").textContent, submitLabel: submit.textContent,
      };
      pendingSaves.add(partId);
      failedSaves.delete(partId);
      draft = null;
      options.closeDialog(dialog, { force: true });
      setStatus("casting-stock-status", "");
      renderPanel();
      try {
        const result = isStart ? await options.api.startCastingInventory({ sourceRevision: recovery.previous.sourceRevision })
          : await options.api.saveCastingInventoryChange({ ...request, opId });
        if (!isCurrent()) return;
        pendingSaves.delete(partId);
        if (!accept(result)) renderPanel();
        attempts.delete(fingerprint);
        const success = request.completeOrder ? "実入庫を記録し、発注を完了しました。"
          : type === "cancelOrder" ? "発注残を取り消しました。" : type === "reverse" ? "記録を取り消しました。"
          : type === "correctQuantity" ? "数量を訂正しました。"
          : isStart ? "鋳物在庫の管理を開始しました。" : submitLabels[type] + "しました。";
        setStatus("casting-stock-status", success, "success");
      } catch (error) {
        if (!isCurrent()) return;
        recovery.message = errorMessage(error);
        recovery.conflict = /CASTING_STOCK_(?:ORDER|RECORD|SOURCE)_CHANGED:|別の端末でこの在庫が更新/.test(String(error?.message || ""));
        if (recovery.conflict) {
          attempts.delete(fingerprint);
          if (read) await read;
          if (!isCurrent()) return;
          await refresh({ passive: true });
        }
        if (!isCurrent()) return;
        pendingSaves.delete(partId);
        failedSaves.set(partId, recovery);
        renderPanel();
        const notice = "鋳物在庫を保存できませんでした。" + recovery.message;
        setStatus("casting-stock-status", notice, "error");
        options.notify(notice, { tone: "error", sticky: true,
          action: { label: "入力内容を開く", run: () => reopenFailedSave(recovery) } });
      }
    }

    function click(event) {
      const target = event.target.closest("[data-casting-action]");
      if (!target || !options.canEdit() || target.getAttribute("aria-disabled") === "true") return;
      const { castingAction: action, partId, entryType, entryId, variant, castingSlot } = target.dataset;
      if (["entry", "editOrder"].includes(action) && pendingSaves.has(partId)) return;
      if (action === "refresh") { void refresh(); return; }
      if (action === "close") { options.closeDialog(dialog); return; }
      if (!snapshot) return;
      const item = partFor(partId);
      if (action === "details" && item) detail(item, variant);
      else if (action === "start") showConfirmation(action);
      else if (snapshot.initialized) {
        if (action === "entry") entry(item, entryType, variant, entryId, castingSlot);
        else if (action === "editOrder") editOrder(entryId);
        else if (action === "editNote" && item) editRowNote(item, variant);
        else if (action === "saveNote" && item) void saveRowNote(item, variant, entryId);
        else if (action === "cancelNote" && item) {
          noteEdits.delete(key(partId, variant));
          renderTable();
          find(noteControlId(item, variant))?.focus({ preventScroll: true });
        } else if (action === "history") void history(partId, variant);
        else if (action === "correctQuantity") {
          if (pendingSaves.has(partId)) {
            setStatus("casting-dialog-status", "この品目の保存中です。完了後に履歴を開き直してください。", "pending");
            return;
          }
          const record = (historyRead?.entries ?? snapshot.history).find((entry) => entry.id === entryId && entry.correction && !entry.reversed);
          if (record) openQuantityCorrection(record);
        } else if (action === "retryHistoryChange") {
          const recovery = failedSaves.get(partId);
          if (recovery?.conflict) void reopenConflictingHistoryChange(recovery);
        } else if (["reverse", "cancelOrder"].includes(action)) showConfirmation(action, entryId);
        else if (action === "preset") {
          field("quantity").value = target.dataset.quantity;
          updateEntrySummary();
        }
      }
    }

    panel.addEventListener("click", click);
    panel.addEventListener("compositionstart", (event) => {
      if (event.target.hasAttribute("data-casting-note-input")) composingNote = true;
    });
    panel.addEventListener("compositionend", (event) => {
      if (!event.target.hasAttribute("data-casting-note-input")) return;
      composingNote = false;
      if (noteRenderQueued) root.requestAnimationFrame(() => {
        if (noteRenderQueued) renderTable();
      });
    });
    panel.addEventListener("input", (event) => {
      const editor = event.target;
      if (!editor.hasAttribute("data-casting-note-input")) return;
      const { partId, variant } = editor.dataset;
      const edit = noteEdits.get(key(partId, variant));
      if (!edit || edit.saving) return;
      edit.value = editor.value;
      const saveNote = editor.closest(".casting-remarks").querySelector('[data-casting-action="saveNote"]');
      if (saveNote) saveNote.disabled = editor.value.trim() === noteFor(partId, variant).note;
    });
    dialog.addEventListener("click", click);
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      draft = null;
      historyRead = null;
    });
    form.addEventListener("submit", save);
    form.addEventListener("invalid", (event) => {
      const details = event.target.closest("details");
      if (details) details.open = true;
    }, true);
    form.addEventListener("input", updateEntrySummary);
    form.addEventListener("change", (event) => {
      if (draft?.mode !== "entry" || event.target.name !== "variant") return;
      const item = partFor(draft.partId);
      draft.variant = event.target.value;
      if (draft.type === "count") draft.expectedQuantity = variantTotal(item, draft.variant);
      if (draft.type === "threshold") field("threshold").value = variantFor(item, draft.variant)?.threshold ?? "";
      updateEntrySummary();
    });
    find("casting-search").addEventListener("input", renderTable);
    statusFilter.addEventListener("change", renderTable);

    return {
      render, refresh, editSnapshot,
      clear() {
        generation += 1;
        snapshot = null;
        stock.clear();
        notes.clear();
        noteEdits.clear();
        composingNote = false;
        noteRenderQueued = false;
        read = null;
        readFailed = false;
        historyRead = null;
        draft = null;
        pendingSaves.clear();
        failedSaves.clear();
        attempts.clear();
        dialog._editBaseline = null;
        modalContent.replaceChildren();
        find("casting-stock-rows").replaceChildren();
        find("casting-stock-source-status").textContent = "";
        setStatus("casting-stock-status", "");
        if (dialog.open) options.closeDialog(dialog, { force: true });
        renderPanel();
      },
    };
  }

  root.CastingStockUI = { create };
})(globalThis);
