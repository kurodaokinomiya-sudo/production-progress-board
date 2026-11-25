# 確定した製品を記録して注文取込のAI利用を減らす

取り込み方法に「自動（覚えた製品を優先・必要なときだけAI）」を追加した。確認画面で「この製品の修正を次回にも使う」が有効な注文を案件へ反映すると、修正がなかった製品も既存の製品補完シートに記録する。記録は全端末で共有し、既存の補完一覧から解除できる。

記録するのは得意先との対応、品名・製品番号・大分類・全長・型・刃幅だけ。数量・納期・連番・注文番号・工程は記録から再利用しない。備考は従来どおり別の明示選択がある追記だけを共有する。重複拒否・案件保存失敗では記録せず、記録保存の失敗後は保存済みの案件から一度だけ復旧する。

## 自動読取

- 今回の原文で製品と得意先が厳密に一致し、全明細の数量と年付き納期を確認できたときだけAIを省略する。
- 対象は1項目1行のラベル付き本文と、行番号・日付・数量・単位の配置を検証できるTC発注書。未知の書式、未知の製品、異なる品番・寸法・向き、曖昧な記録、欠落・重複した数量や納期、数量合計不一致では文書全体を一度だけAIへ渡す。読めた行だけ先に保存しない。
- PDFは抽出できた文字を優先する。Apps Scriptの写真・画像PDFは先にDrive OCRを試す。文字を確実に解析できなければ従来のAIで原本を読む。ローカルの写真にはOCRがないためAIへ進む。
- 添付のないメール本文は同じ照合を使う。添付付きメールは本文と添付の二重計上を避ける従来のAI経路を維持する。メールの一部保存失敗は同じバッチとして復旧する。
- 候補には「AIなし・要確認」と原文を表示し、従来どおり確認してから案件へ反映する。AIを明示選択すると新たにAIで読み直せる。「AIを使わず読み取る」も残す。

## 検証

全924テスト、正規ビルド、contrast監査、diffの空白検査が成功した。source/dist両方のsmokeと製品記録のブラウザーQAが成功し、320/768/1280pxとキーボード操作を確認した。実AIや実Gmailの読み取り、実注文の登録を伴う試験は実施していない。

証跡は `output/intake-memory-tests.log`、`output/intake-memory-contrast.log`、`output/intake-memory-smoke.log`、`output/browser-qa/intake-memory-2026-11-01T23-57-31-163Z/`。公開結果は `output/release-2026-11-02-intake-memory/` に保存する。

## 本番反映

2026-11-02、`.clasp.json` の接続先と既存デプロイ一覧を確認し、同じ本番デプロイをv103から **v104** へ更新した。URL・所有者実行・Googleログイン要件・OAuthスコープは維持した。ほか7デプロイの参照バージョンは変えていない。

公開前のApps Script HEADとv103は19/19ファイルが一致し、未公開変更はなかった。検証済み候補を固定して19ファイルをpushし、作成したv104を隔離取得して、BOM・改行と`.js`/`.gs`拡張子の正規化後に候補19/19ファイル・SHA-256の一致を確認してから本番を更新した。

通常の本番URLを新しいタブで開き、スプレッドシートとの同期、新しい「自動」の初期選択、製品記録の説明を確認した。ブラウザーconsole errorは0件。既存の確認タブには旧画面が残ったため、新しいタブでの読み直しを確認手順に含めた。実注文登録・AI送信・Gmail検索は行っていない。

- Script ID: `10NmIpt3CMJAx6zmpAi3mWPhq3STu-y97bMU9a4nt9sL6sHmHqYOTTfmT`
- Deployment ID: `AKfycbwVlF96mdaxEptRwXWeh2oAZ0-s0INe6jMHaB1BWhImXd8x_hbn7hSKcpMY7v2ERzJmpA`
- [既存の本番URL](https://script.google.com/macros/s/AKfycbwVlF96mdaxEptRwXWeh2oAZ0-s0INe6jMHaB1BWhImXd8x_hbn7hSKcpMY7v2ERzJmpA/exec)

`comparison-head.json`、`comparison-before.json`、`comparison-after.json`、`candidate-hashes.json`、`push.log`、`version.log`、`deploy.log`、`deployments-before.txt`、`deployments-after.txt`、`production-v104-import.png` を公開証跡として保存した。
