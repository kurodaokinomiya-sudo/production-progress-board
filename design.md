# Design — 生産工程管理

このアプリの固定デザインシステム。今後の画面追加は `tokens.css` と本書を先に読み、
ページごとに別テーマを作らない。機能と現場の読み順を優先する。

## System

- Genre · modern-minimal
- App macrostructure · Index-First（一覧が主役、状況台帳は絞り込み入口）
- Theme · custom（precision instrument, engineering drawing, quiet operations）
- Axes · light / display-condensed-bold / cool
- Navigation · N3 Side-rail（PC）／操作帯＋開閉メニュー（タブレット以下）
- Footer · Ft4 Dense colophon（同期状態と最終更新）

## Visual thesis

精密機器の操作盤 × 日本の工業図面 × 静かな業務ツール。
アルミ白と黒鉛を基調にし、鋼青は選択、朱赤は納期警告だけに使う。
カードを並べず、罫線・余白・書体・数字の整列で階層を作る。

## Information hierarchy

1. 状況台帳 — 進行中、納期注意、今月完了、出荷待ち、ラベル印刷待ち。各項目から対象一覧へ直接移動する。
2. 案件一覧 — 優先順の先頭8件で、製品、納期、現在工程、現在担当、工程ごとの担当、出荷までの進捗を最短で読む。現在工程は工程専用ダイアログへ、編集記号は注文情報へ直接つなぐ。
3. 未出荷案件 — 全件の検索、工程・状況の絞り込み、大分類・連番などの並び替えを行う。
4. 終了リスト — 初期表示は今月。必要なときだけ全期間へ切り替える。
5. 操作帯 — 取込、追加、印刷。同期状態と手動更新はフッターを正本にする。

独立した「優先作業」一覧や「工程別の担当」集計は作らない。案件一覧の再掲になり、直接の判断や操作につながらないため。

## Typography

- Display / numerals · Big Shoulders Display 700
- Japanese body · IBM Plex Sans JP 400 / 600
- Tabular metadata · IBM Plex Sans JP 400 / 600（tabular-nums）
- Body floor · 16px。補助情報は14px以上、コロフォンのみ11px。
- 数量、連番、日付、件数、進捗は tabular-nums。

## Tokens

`tokens.css` が正本。主要値は次のとおり。

```css
:root {
  --color-paper:      oklch(97.4% 0.006 242);
  --color-paper-2:    oklch(94.8% 0.009 242);
  --color-paper-3:    oklch(91.8% 0.012 242);
  --color-ink:        oklch(20% 0.018 248);
  --color-ink-2:      oklch(30% 0.018 248);
  --color-rule:       oklch(84% 0.012 242);
  --color-accent:     oklch(48% 0.115 246);
  --color-accent-ink: oklch(98% 0.006 242);
  --color-danger:     oklch(52% 0.19 29);
  --color-focus:      oklch(8% 0.02 246);

  --font-display: "Big Shoulders Display", "IBM Plex Sans JP", sans-serif;
  --font-body: "IBM Plex Sans JP", "BIZ UDPGothic", sans-serif;
  --font-mono: "IBM Plex Sans JP", "BIZ UDPGothic", sans-serif;

  --space-3xs: 0.125rem;
  --space-2xs: 0.25rem;
  --space-xs: 0.5rem;
  --space-sm: 0.75rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2.5rem;
  --space-2xl: 4rem;
  --space-3xl: 6rem;

  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-micro: 120ms;
  --dur-short: 220ms;
  --dur-long: 420ms;

  --radius-card: 0.125rem;
  --radius-input: 0.25rem;
}
```

## Component voice

- Primary action · 黒鉛塗り、2–4px角、動詞で終える。
- Secondary action · 透明面＋罫線。主操作と同じ高さ。
- Status · 角丸ラベルではなく、小さな面と文字を組み合わせる。
- Panels · 原則一重。入れ子カードは禁止。
- App pages · 装飾画像なし。実データと操作が画面を作る。
- Process dialog · 現在工程を入口にし、5工程の状態と担当を一画面で変更する。現在工程の担当候補10名は最初から展開する。
- Order dialog · 顧客、製品、数量、仕様の低頻度編集に限定する。案件削除は物理削除せず、一覧から退避して取り消せるようにする。

## Motion stance

- 基本は静止。状態切替、ダイアログ、保存中表示だけを動かす。
- 成功は画面の反映だけで伝える。見えている成功にトーストを出さない。
- `prefers-reduced-motion` では150ms以下の透明度変化だけにする。

## Responsive contract

- 320 / 375 / 414 / 768pxで横スクロールを出さない。
- 60rem未満は表を案件行カードへ変換する。
- PCは左レール、タブレット以下は操作帯と開閉メニュー。
- タッチ対象は44px以上。クリック文字は折り返さない。

## Exports

### Tailwind v4 `@theme`

```css
@theme {
  --color-paper: oklch(97.4% 0.006 242);
  --color-paper-2: oklch(94.8% 0.009 242);
  --color-paper-3: oklch(91.8% 0.012 242);
  --color-ink: oklch(20% 0.018 248);
  --color-ink-2: oklch(30% 0.018 248);
  --color-rule: oklch(84% 0.012 242);
  --color-accent: oklch(48% 0.115 246);
  --color-danger: oklch(52% 0.19 29);
  --color-focus: oklch(8% 0.02 246);
  --font-display: "Big Shoulders Display", "IBM Plex Sans JP", sans-serif;
  --font-body: "IBM Plex Sans JP", sans-serif;
  --font-mono: "IBM Plex Sans JP", sans-serif;
  --spacing-xs: 0.5rem;
  --spacing-sm: 0.75rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --radius-card: 0.125rem;
  --radius-input: 0.25rem;
}
```

### DTCG `tokens.json`

```json
{
  "$schema": "https://design-tokens.github.io/community-group/format/",
  "color": {
    "paper": { "$value": "oklch(97.4% 0.006 242)", "$type": "color" },
    "ink": { "$value": "oklch(20% 0.018 248)", "$type": "color" },
    "accent": { "$value": "oklch(48% 0.115 246)", "$type": "color" },
    "danger": { "$value": "oklch(52% 0.19 29)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Big Shoulders Display, IBM Plex Sans JP, sans-serif", "$type": "fontFamily" },
    "body": { "$value": "IBM Plex Sans JP, sans-serif", "$type": "fontFamily" },
    "mono": { "$value": "IBM Plex Sans JP, sans-serif", "$type": "fontFamily" }
  },
  "space": {
    "xs": { "$value": "0.5rem", "$type": "dimension" },
    "md": { "$value": "1rem", "$type": "dimension" },
    "lg": { "$value": "1.5rem", "$type": "dimension" }
  }
}
```

### shadcn/ui CSS variables

```css
:root {
  --background: 97.4% 0.006 242;
  --foreground: 20% 0.018 248;
  --card: 98.7% 0.004 242;
  --card-foreground: 20% 0.018 248;
  --primary: 48% 0.115 246;
  --primary-foreground: 98% 0.006 242;
  --secondary: 91.8% 0.012 242;
  --secondary-foreground: 30% 0.018 248;
  --muted: 84% 0.012 242;
  --muted-foreground: 46% 0.014 244;
  --destructive: 52% 0.19 29;
  --destructive-foreground: 98% 0.006 242;
  --border: 84% 0.012 242;
  --input: 66% 0.018 244;
  --ring: 8% 0.02 246;
  --radius: 0.125rem;
}
```

## References

### Specification ledger update (2026-09-07)

- Main, active, and completed lists share 17 narrow columns: customer, product, category, due date, quantity, length, shape, blade width, serial, five stages, notes, shipping, edit.
- Each stage is an independent 44px touch target displaying assignee and status. Duplicate current-stage/assignment/progress columns are removed. Clicking a stage opens that exact stage in the existing dialog.
- Names and notes wrap without ellipsis; missing specifications show a dash without changing stored data. Dates remain visible even when overdue.
- Below 78rem, compact cards expose all specifications, quantity, date, and all five stages, without page-wide horizontal scrolling. Existing light/dark palette and fonts are retained; dense table text is 13px, status labels 11px.
- Shipping remains independently accessible; completed records retain completion timestamps.
- Component QA: `npm run check` passes 44 tests and light/dark contrast checks. The existing browser QA passes against both `src/index.html` and bundled `dist/Index.html`. At 320/375/414/768/1024/1248/1280/1440/1920px, no root overflow or clipped table cells; all five stage buttons are at least 44px and open the corresponding stage. Names/specs/notes use stored values only. Screenshots inspected in light and dark themes.
- `output/playwright/spec-ledger-1280.png`
- `output/playwright/spec-ledger-768.png`
- `output/playwright/spec-ledger-dark-1280.png`

- `output/design/precision-ledger-desktop-v1.png`
- `output/design/precision-ledger-tablet-dark-v1.png`
