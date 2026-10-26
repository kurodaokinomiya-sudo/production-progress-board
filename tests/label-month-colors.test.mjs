import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedMonthColors = [
  "oklch(88% 0.08 230)", // January: light blue
  "oklch(88% 0.10 45)",  // February: orange
  "oklch(88% 0.10 350)", // March: pink
  "oklch(88% 0.10 145)", // April: green
  "oklch(88% 0.08 230)", // May: light blue
  "oklch(88% 0.10 45)",  // June: orange
  "oklch(88% 0.10 350)", // July: pink
  "oklch(88% 0.10 145)", // August: green
  "oklch(88% 0.08 230)", // September: light blue
  "oklch(88% 0.10 45)",  // October: orange
  "oklch(88% 0.10 350)", // November: pink
  "oklch(88% 0.10 145)", // December: green
];

test("label marker colors follow the requested January-to-December cycle", async () => {
  const tokens = await readFile(new URL("../tokens.css", import.meta.url), "utf8");
  const actualMonthColors = Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, "0");
    const match = tokens.match(new RegExp(`--color-label-month-${month}:\\s*([^;]+);`));
    assert.ok(match, `missing color token for month ${month}`);
    return match[1].trim();
  });

  assert.deepEqual(actualMonthColors, expectedMonthColors);
});
