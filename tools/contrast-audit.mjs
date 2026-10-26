import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../tokens.css", import.meta.url), "utf8");
const tokens = Object.fromEntries(
  [...css.matchAll(/--(color-[\w-]+):\s*(oklch\([^;]+\));/g)].map((match) => [match[1], match[2]])
);

const pairs = [
  ["color-ink", "color-paper", 4.5],
  ["color-ink-2", "color-surface", 4.5],
  ["color-neutral", "color-surface", 4.5],
  ["color-muted", "color-surface", 4.5],
  ["color-ink", "color-row-hover", 4.5],
  ["color-neutral", "color-row-hover", 4.5],
  ["color-muted", "color-row-hover", 4.5],
  ["color-accent", "color-surface", 4.5],
  ["color-accent", "color-accent-soft", 4.5],
  ["color-accent-ink", "color-accent", 4.5],
  ["color-accent-ink", "color-danger", 4.5],
  ["color-danger", "color-danger-soft", 4.5],
  ["color-warning", "color-warning-soft", 4.5],
  ["color-success", "color-success-soft", 4.5],
  ["color-info", "color-info-soft", 4.5],
  ["color-inverse-ink", "color-inverse-surface", 4.5],
  ["color-rule-strong", "color-surface", 3],
  ["color-focus", "color-surface", 3],
  // Focus uses an inner outline and an outer halo, including on filled actions.
  ["color-focus", "color-focus-outer", 3],
  ["color-focus-outer", "color-accent", 3],
  ["color-section-ink", "color-section-band", 4.5],
  ["color-working-ink", "color-working", 4.5],
  ["color-ink", "color-row-alt", 4.5],
  ["color-neutral", "color-row-alt", 4.5],
  ["color-muted", "color-row-alt", 4.5],
  ["color-success", "color-row-alt", 4.5],
  ["color-danger", "color-row-alt", 4.5],
  ["color-label-ink", "color-label-paper", 4.5],
  ...Array.from({ length: 12 }, (_, index) => ["color-label-ink", `color-label-month-${String(index + 1).padStart(2, "0")}`, 4.5]),
  ["color-label-band-ink", "color-label-band", 4.5],
  ["color-label-customer", "color-label-paper", 4.5],
  ["color-label-due", "color-label-paper", 4.5],
  ["color-label-rule", "color-label-paper", 3],
  ["color-dark-ink", "color-dark-paper", 4.5],
  ["color-dark-ink-2", "color-dark-surface", 4.5],
  ["color-dark-neutral", "color-dark-surface", 4.5],
  ["color-dark-muted", "color-dark-surface", 4.5],
  ["color-dark-ink", "color-dark-row-hover", 4.5],
  ["color-dark-neutral", "color-dark-row-hover", 4.5],
  ["color-dark-muted", "color-dark-row-hover", 4.5],
  ["color-dark-accent", "color-dark-surface", 4.5],
  ["color-dark-accent", "color-dark-accent-soft", 4.5],
  ["color-dark-accent-ink", "color-dark-accent", 4.5],
  ["color-dark-danger", "color-dark-danger-soft", 4.5],
  ["color-dark-warning", "color-dark-warning-soft", 4.5],
  ["color-dark-success", "color-dark-success-soft", 4.5],
  ["color-dark-info", "color-dark-info-soft", 4.5],
  ["color-dark-inverse-ink", "color-dark-inverse-surface", 4.5],
  ["color-dark-rule-strong", "color-dark-surface", 3],
  ["color-dark-focus", "color-dark-surface", 3],
  ["color-dark-focus", "color-dark-focus-outer", 3],
  ["color-dark-focus-outer", "color-dark-accent", 3],
  ["color-dark-section-ink", "color-dark-section-band", 4.5],
  ["color-dark-working-ink", "color-dark-working", 4.5],
  ["color-dark-ink", "color-dark-row-alt", 4.5],
  ["color-dark-neutral", "color-dark-row-alt", 4.5],
  ["color-dark-muted", "color-dark-row-alt", 4.5],
  ["color-dark-success", "color-dark-row-alt", 4.5],
  ["color-dark-danger", "color-dark-row-alt", 4.5],
];

function parseOklch(value) {
  const match = value.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/i);
  if (!match) throw new Error(`Unsupported color: ${value}`);
  const lightness = value.includes(`${match[1]}%`) ? Number(match[1]) / 100 : Number(match[1]);
  return { lightness, chroma: Number(match[2]), hue: Number(match[3]) * Math.PI / 180 };
}

function luminance(value) {
  const { lightness: L, chroma: C, hue } = parseOklch(value);
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  const lRoot = L + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = L - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = L - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const red = Math.max(0, Math.min(1, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s));
  const green = Math.max(0, Math.min(1, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s));
  const blue = Math.max(0, Math.min(1, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function ratio(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

let failed = false;
for (const [foreground, background, minimum] of pairs) {
  const result = ratio(tokens[foreground], tokens[background]);
  const passed = result >= minimum;
  failed ||= !passed;
  console.log(`${passed ? "PASS" : "FAIL"} ${foreground}/${background}: ${result.toFixed(2)} (min ${minimum})`);
}

// Project-specific OKLab distance guard: text can pass contrast while a hovered
// row is still indistinguishable from the table's alternating stripe.
for (const background of ["color-surface", "color-row-alt"]) {
  const first = parseOklch(tokens["color-row-hover"]);
  const second = parseOklch(tokens[background]);
  const distance = Math.hypot(
    first.lightness - second.lightness,
    first.chroma * Math.cos(first.hue) - second.chroma * Math.cos(second.hue),
    first.chroma * Math.sin(first.hue) - second.chroma * Math.sin(second.hue)
  );
  const minimum = 0.08;
  const passed = distance >= minimum;
  failed ||= !passed;
  console.log(`${passed ? "PASS" : "FAIL"} light row highlight/${background}: OKLab distance ${distance.toFixed(3)} (project min ${minimum})`);
}

if (failed) process.exitCode = 1;
