# ローカルブラウザー回帰検証

Node.js 20以上とnpmを使う。個人のホームやCodex内部ランタイムを参照しない。

```sh
npm ci
npm run qa:install
npm run qa
```

Playwrightは開発依存 `1.64.1` に固定した。`qa:install` はその版に対応するChromiumを導入する。Linux CIでは必要に応じ `npx playwright install --with-deps chromium` を使う。

`npm run qa` は生成物をビルドし、ソース `/src/index.html` と生成物 `/dist/Index.html` をそれぞれ新しいブラウザーコンテキストで開く。起動、主要画面、注文追加・保存・再読込、工程変更・保存・再読込、タブレット幅を確認する。
空きポートはOSへ割り当てを依頼し、HTTP到達性を確認してから実行する。既存の開発サーバーやブラウザーの保存領域を使わない。

結果は `output/browser-qa/<suite>-<日時>/report.json` に保存する。対象ごとのtrace.zip、失敗時のPNG、必要な画面キャプチャも残る。失敗は終了コード1。未導入ブラウザーは `QA_BROWSER_MISSING`、起動失敗は `QA_SERVER_START_FAILED`、起動待ち期限切れは `QA_SERVER_TIMEOUT` と表示する。ポート競合は他のサーバーを終了せず失敗として扱う。

標準実行は専用サーバーを起動・終了する。既存の**ローカルQA専用**サーバーを使う場合のみ `PROGRESS_BOARD_QA_URL=http://127.0.0.1:<port>/src/index.html` を指定できる。HTTPかつ明示ポート付きの127.0.0.1/localhost以外は拒否する。通常の個人用デモのURLは指定しない。

ブラウザーから外部サイトへは通信しない。フォントは空の合成応答、その他の外部リクエストは拒否する。専用サーバーは `PROGRESS_BOARD_QA_MODE=1` で、外部AI、AI指定の本文解析、本番プロジェクト情報・認証ファイルの取得を拒否する。実メール・Googleログイン・本番データは不要。

後続の結合テストは `runBrowserQa(name, scenario)` を使う。1つのcontextに2つのpageを作れば、保存領域を共有する2タブ検証になる。入力遅延・障害は合成APIかテスト用の一時的な差し替えで再現する。

`npm run qa:conflicts` は注文・工程の2タブ競合、別項目の併合、同一項目の選択、復旧中の再競合、作業員の送信範囲、応答消失後の工程/新規注文の再試行、削除・権限失効を確認する。

`npm run qa:stock-dialog` はTezoe在庫のボタン/背景/Escapeでの下書き保持、遅い保存の閉鎖防止、失敗後再試行、権限失効、フォーカスとinert解除、タブレット幅を確認する。

`npm run qa:stock-completion` は製造3丁＋在庫出荷予定2丁の受注5丁について、在庫不足・一部出荷での完了拒否、在庫分の実出荷後の完了、再開、製造10丁のうち5丁を在庫補充する正常系をソース版・生成物の画面で確認する。

## 既存QAの対応表

従来のシナリオは削除せず、同じ依存・サーバー・通信制限へ移した。次のように個別に実行できる。

```sh
npm run build
npm run qa:legacy -- tools/project-link-qa.mjs
```

| スクリプト | 残している検証範囲 |
| --- | --- |
| browser-qa.mjs | 従来の広範な工程・注文・ラベル・印刷・レイアウト |
| polishing-browser-qa.mjs | 研磨の発送・戻り・最終仕上げ |
| ai-browser-qa.mjs | 合成AI応答・取込・診断エラー |
| text-import-qa.mjs | 本文解析・候補確認・失敗復旧 |
| bulk-intake-qa.mjs | 一括取込・入力・承認・表示幅 |
| customer-rules-qa.mjs | 得意先ルールの編集・保存 |
| intake-delete-qa.mjs | 取込候補の選択・削除・失敗復旧 |
| project-link-qa.mjs | 合成プロジェクトのリンク先・別タブ・不正URL |
| review-fixes-qa.mjs | 過去の詳細回帰シナリオ |

旧シナリオの業務前提が変わった場合は、その対象の変更時に確認・更新する。既定スモークの成功だけで全旧シナリオの成功とはしない。

## 検証の限界

どちらの画面もローカルのMockApiを使う。生成物の組み込み漏れやブラウザー操作の確認であり、HtmlService上のgoogle.script.run、GASロック、Sheets永続化、Google認証、本番との一致は確認しない。サーバー単体回帰は別途 `node --test --test-isolation=none tests/*.test.mjs` で実行する。

Playwright公式: https://playwright.dev/docs/library / https://playwright.dev/docs/browsers
