// WCAG 2.1 contrast check of the design tokens (Theme A "Wine & cream"), both themes.
// Usage: npm run check:contrast -w @autowiki/web
// Reads the token values from src/styles/index.css, so it follows any change there.
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8');

function block(selector) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Selector not found: ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
  );
}

const themes = { light: block(':root {'), dark: block("[data-theme='dark'] {") };

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// [foreground, background, minimum] — 4.5 for body text, 3 for large text / UI parts.
const PAIRS = [
  ['text', 'bg', 4.5],
  ['text', 'surface', 4.5],
  ['text', 'raised', 4.5],
  ['muted', 'bg', 4.5],
  ['muted', 'surface', 4.5],
  ['muted', 'raised', 4.5],
  ['muted', 'soft', 4.5],
  ['accent-text', 'surface', 4.5],
  ['accent-text', 'accent-soft', 4.5],
  ['on-accent', 'accent', 4.5],
  ['success', 'success-soft', 4.5],
  ['success', 'surface', 4.5],
  ['warning', 'warning-soft', 4.5],
  ['warning', 'surface', 4.5],
  ['danger', 'danger-soft', 4.5],
  ['danger', 'surface', 4.5],
  ['bg', 'danger', 4.5], // danger button: text-bg on bg-danger
  ['text', 'code-bg', 4.5],
  ['border', 'surface', 1.2], // decorative separators, informational only
];

let failures = 0;
for (const [name, tokens] of Object.entries(themes)) {
  console.log(`\n${name}`);
  for (const [fg, bg, min] of PAIRS) {
    const r = ratio(tokens[fg], tokens[bg]);
    const ok = r >= min;
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${`${fg} on ${bg}`.padEnd(26)} ${r.toFixed(2)}:1 (min ${min})`,
    );
  }
}
console.log(failures ? `\n${failures} pair(s) below the minimum.` : '\nAll pairs pass.');
process.exitCode = failures ? 1 : 0;
