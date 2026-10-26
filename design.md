# Design — 生産工程管理

このアプリの固定デザインシステム。今後の画面追加は `tokens.css` と本書を先に読み、
ページごとに別テーマを作らない。機能と現場の読み順を優先する。

2026-10-22の共通UI更新では、比較試作の鋼青を採用し、最新の配布表とTezoe製品在庫へも同じ配色・部品を適用する。追加・変更時は `frontend-design`、変更範囲の確認には `web-design-guidelines` を使う。既存の機能・権限・保存・印刷の仕様を優先する。

## System

- Genre · modern-minimal
- App macrostructure · Index-First（一覧が主役、状況台帳は絞り込み入口）
- Theme · custom（precision instrument, engineering drawing, quiet operations）
- Axes · light / display-condensed-bold / cool
- Navigation · 全画面で上部の横並びタブ（狭い画面はタブ内を横スクロール）
- Footer · Ft4 Dense colophon（同期状態と最終更新）

## Visual thesis

精密機器の操作盤 × 日本の工業図面 × 静かな業務ツール。
アルミ白と黒鉛を基調にし、鋼青は選択、朱赤は納期警告だけに使う。
カードを並べず、罫線・余白・書体・数字の整列で階層を作る。

器具白 `#F4F7FA`、白い作業面 `#FFFFFF`、黒鉛 `#233747`、鋼青 `#195B7D`、罫線銀 `#CBD5DD`、注意の朱 `#A93429`。進行中は鋼青の面、完了は控えめな緑、未着手は中立色にし、状態名を必ず残す。分類帯は `--color-section-band` / `--color-section-ink`、進行中は `--color-working` / `--color-working-ink`、交互の行は `--color-row-alt` を使う。ダークと端末設定への追従も同じトークンで切り替える。

ライトの交互の行は薄い中立グレー、ホバー・キーボード操作中の行は淡い黄色で区別する。分類帯の鋼青と同じ色相に寄せず、文字のコントラストに加えて行の状態同士の色差も監査する。ダークの行配色は別トークンを維持する。

## Information hierarchy

1. 状況台帳 — 進行中、納期注意、今月完了、出荷待ち、ラベル印刷待ち。各項目から対象一覧へ直接移動する。
2. 案件一覧 — 優先順の先頭8件で、製品、納期、現在工程、現在担当、工程ごとの担当、出荷までの進捗を最短で読む。現在工程は工程専用ダイアログへ、編集記号は注文情報へ直接つなぐ。
3. 工程一覧 — 製造中の案件を表示する。通常の「仕上げ」に完了操作は置かない。研磨へ全数を送り、全数が戻った後に最終仕上げを完了すると、先行工程が残っていても出荷待ち一覧へ移す。条件外の未出荷案件は工程一覧で編集可能に保つ。
4. 完成品リスト — 上段に出荷待ち、下段に出荷済みを並べ、縦スクロールと倍率操作を共通にする。上下それぞれに分類見出し・小計・総合計、検索・並び順を保つ。作業員は閲覧のみ、編集者・管理者・所有者が出荷完了または再開を行う。未発送・一部発送・未返却では最終仕上げを完了できない。
5. 出荷済み — 完成品リストの下段で初期表示は今月。出荷年月で過去の記録へ切り替えられ、上段の出荷待ちは期間に関係なく表示する。再開した案件は同じ画面の出荷待ちへ戻る。
6. 操作帯 — 取込、追加、印刷。同期状態と手動更新はフッターを正本にする。

独立した「優先作業」一覧や「工程別の担当」集計は作らない。案件一覧の再掲になり、直接の判断や操作につながらないため。

## Typography

- 集計の大きな数字 · Big Shoulders Display 700。画面・ダイアログの見出しはIBM Plex Sans JP 600 / 700。
- Japanese body · IBM Plex Sans JP 400 / 600
- Tabular metadata · IBM Plex Sans JP 400 / 600（tabular-nums）
- Body floor · 16px。補助情報は14px以上、コロフォンのみ11px。工程一覧の表は既存の13pxを基準とし、表示倍率は表だけに適用する。
- 数量、連番、日付、件数、進捗は tabular-nums。

## Tokens

`tokens.css` が正本。主要値は次のとおり。

```css
:root {
  --color-paper:      oklch(97.472% 0.00513 247.88);
  --color-paper-2:    oklch(95.203% 0.00931 242.84);
  --color-paper-3:    oklch(92.276% 0.01530 241.78);
  --color-ink:        oklch(32.721% 0.03841 243.45);
  --color-ink-2:      oklch(40.784% 0.04109 239.88);
  --color-rule:       oklch(86.775% 0.01553 241.80);
  --color-accent:     oklch(44.730% 0.08467 236.16);
  --color-accent-ink: oklch(100.000% 0.00000 0.00);
  --color-danger:     oklch(49.798% 0.15483 29.11);
  --color-focus:      oklch(34.010% 0.06481 244.36);

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

- Primary action · 鋼青の面と高コントラストの文字。角は `--radius-control`、動詞で終える。
- Secondary action · 作業面と罫線。主操作と同じ高さ。
- Status · 角丸ラベルではなく、小さな面と文字を組み合わせる。
- Panels · 原則一重。入れ子カードは禁止。
- App pages · 装飾画像なし。実データと操作が画面を作る。
- Process dialog · 品名を見出しにし、得意先・連番・数量・納期・仕様を上部へ固定する。全工程の状態と担当候補は常時表示し、広い画面では同じ行、タブレットでは担当を次の行へ置く。担当・状態を450ms長押しすると直上へ「全」が出て、その中で離したときだけ全工程へ入力する。通常のクリックは1工程のみ、長押し前の移動やキャンセルは一括入力しない。Alt＋↑でも同じ一括入力ができ、直前の一括変更を戻せる。共通担当の候補は全工程の表示設定の共通部分とする。「設定 → 工程ごとの担当候補」で10名の表示を工程別に保存し、候補外となった登録済み担当は表示・保持する。操作対象は44px以上。保存を押すとダイアログをすぐ閉じ、失敗時は入力内容を復元できる。保存結果で別の編集中画面を閉じない。
- Order dialog · 顧客、製品、数量、仕様の低頻度編集に限定する。案件削除は物理削除せず、一覧から退避して取り消せるようにする。
- Distribution · 開始月・終了月・前月/翌月・月ごとの並び順・現在工程・配布担当を維持する。画面の表だけ共通の分類色・交互の行を使い、印刷は専用8列のA4縦1枚を保つ。未定を画面に残し、印刷からは除く。画面の担当別集計は期間全体、印刷は対象行で再集計する。
- Tezoe finished stock · 共通の表見出しと操作ボタンを使い、受注と出荷予定・製造総数と完成予定・ロット・履歴の区別を保つ。使える在庫見込には後日の受注分の確保も反映し、不足は朱色と文字で示す。入力の最小幅・横スクロール・44pxの操作対象を保つ。材料在庫と完成品在庫を混同しない。
- 碓井材料在庫 · 発注行を入庫後も残し、入庫日・数量・残数・文字付き状態を同じ行で表示する。一部入庫は複数の明細を並べ、未完了の発注を先にする。実在庫は従来どおり入庫記録時に加算する。
- Focus · 2pxの輪郭と周囲の補助色を併用し、塗りつぶしたボタンでも見分けられるようにする。

## Motion stance

- 基本は静止。状態切替、ダイアログ、保存中表示だけを動かす。
- 成功は画面の反映だけで伝える。見えている成功にトーストを出さない。
- `prefers-reduced-motion` では150ms以下の透明度変化だけにする。

## Responsive contract

- 320 / 375 / 414 / 768pxでページ全体の横はみ出しを出さない。幅のある表は専用の領域で横スクロールする。
- 工程一覧・完成品リストは全画面幅で1製品1行の表を維持する。33/23製品と160%表示、連番の実測と固定、共通スクロールを保つ。
- 全画面のナビゲーションを上部の横並びタブに統一する。工程一覧・完成品リストは既存の操作帯、その他の画面は本文先頭の共通操作帯に置き、左レールや開閉メニューへ切り替えない。配布表の狭い画面では既存の行カード表示を使い、Tezoe製品在庫は表の横スクロールを使う。
- タッチ対象は44px以上。短い操作ボタンとタブの文字は折り返さず、省略しない。幅が足りない場合はタブ内を横スクロールし、最後の設定までタッチ・キーボードで移動できるようにする。

## Exports

### Tailwind v4 `@theme`

```css
@theme {
  --color-paper: oklch(97.472% 0.00513 247.88);
  --color-paper-2: oklch(95.203% 0.00931 242.84);
  --color-paper-3: oklch(92.276% 0.01530 241.78);
  --color-ink: oklch(32.721% 0.03841 243.45);
  --color-ink-2: oklch(40.784% 0.04109 239.88);
  --color-rule: oklch(86.775% 0.01553 241.80);
  --color-accent: oklch(44.730% 0.08467 236.16);
  --color-danger: oklch(49.798% 0.15483 29.11);
  --color-focus: oklch(34.010% 0.06481 244.36);
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
    "paper": { "$value": "oklch(97.472% 0.00513 247.88)", "$type": "color" },
    "ink": { "$value": "oklch(32.721% 0.03841 243.45)", "$type": "color" },
    "accent": { "$value": "oklch(44.730% 0.08467 236.16)", "$type": "color" },
    "danger": { "$value": "oklch(49.798% 0.15483 29.11)", "$type": "color" }
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
