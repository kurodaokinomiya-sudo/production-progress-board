import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

function harness() {
  const jobs = [{ id: "old-first" }, { id: "old-second" }];
  const element = { focus() {} };
  const dialog = {
    open: false, value: "",
    showModal() { this.open = true; },
    close() { this.open = false; },
    querySelector: () => element,
  };
  const reads = [];
  const edits = [];
  const context = vm.createContext({
    window: { google: { script: { run: {} } } }, HTMLElement: class {},
    localStorage: { getItem: () => null },
    document: {
      querySelector: selector => selector === "dialog[open]" ? (dialog.open ? dialog : null) : element,
      querySelectorAll: () => [],
    },
  });
  vm.runInContext(source.replace(/\ninit\(\);\s*$/, "") +
    '\nObject.assign(globalThis, { state, openStockOrder, openDialog });', context);
  Object.assign(context.state, { activeView: "materials", jobHistoryReady: false, mode: "live", access: { canEdit: true, role: "editor" } });
  context.loadDeferredData = () => new Promise(resolve => reads.push(resolve));
  context.openOrderDialog = job => {
    edits.push(job?.id ?? "new");
    dialog.value = job?.id ?? "";
    context.openDialog(dialog);
  };
  return {
    context, edits, dialog,
    finish(index) {
      context.state.jobs = jobs;
      reads[index](true);
    },
  };
}

test("a delayed inventory order never replaces input entered in a newly opened order form", async () => {
  const h = harness();
  const old = h.context.openStockOrder("old-first");
  h.context.openOrderDialog();
  h.dialog.value = "新規案件の入力中の備考";
  h.finish(0);
  await old;
  assert.deepEqual(h.edits, ["new"]);
  assert.equal(h.dialog.value, "新規案件の入力中の備考");
});

test("the first inventory order is ignored even if the newer order has already closed", async () => {
  const h = harness();
  const old = h.context.openStockOrder("old-first");
  const latest = h.context.openStockOrder("old-second");
  h.finish(1);
  await latest;
  assert.deepEqual(h.edits, ["old-second"]);
  h.dialog.close();
  h.finish(0);
  await old;
  assert.deepEqual(h.edits, ["old-second"]);
  assert.equal(h.dialog.open, false);
});

test("an inventory order still opens after an uninterrupted history load", async () => {
  const h = harness();
  const request = h.context.openStockOrder("old-first");
  h.finish(0);
  await request;
  assert.deepEqual(h.edits, ["old-first"]);
});
