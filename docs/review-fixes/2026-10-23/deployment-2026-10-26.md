# 7件の改善の本番公開

2026-10-26、ユーザーの追加指示「別に一回待たなくてデプロイしても大丈夫だよね？実行して」を受け、当初のデプロイ禁止を解除して公開した。各項目とfinal-validationの記録は、追加指示前の検証結果として保持する。

既存の本番Webアプリを **v97 → v98** に更新した。スクリプトIDは実際の `.clasp.json`、本番デプロイIDと直前のバージョンは最新の一覧で確認した。

- Script ID: `10NmIpt3CMJAx6zmpAi3mWPhq3STu-y97bMU9a4nt9sL6sHmHqYOTTfmT`
- Deployment ID: `AKfycbwVlF96mdaxEptRwXWeh2oAZ0-s0INe6jMHaB1BWhImXd8x_hbn7hSKcpMY7v2ERzJmpA`
- URL: https://script.google.com/macros/s/AKfycbwVlF96mdaxEptRwXWeh2oAZ0-s0INe6jMHaB1BWhImXd8x_hbn7hSKcpMY7v2ERzJmpA/exec

公開直前の全テストは670件成功、失敗・skipなし。ビルド、コントラスト、diffチェックも成功した。検証済みの19ファイルを隔離した候補フォルダーへ固定し、本番v97との静的差分を確認した。既存の材料履歴に関するbundle・MaterialLogic、実行者・アクセス・OAuthスコープのmanifestは変わらず、欠落ファイルや権限緩和は見つからなかった。

候補をpushし、v98を作成して既存デプロイだけを更新した。公開前後の一覧を比較し、ほか7つのデプロイは変更していないことを確認した。

公開後はv98を別フォルダーへpullし、`.gs`/`.js`の対応とBOM・改行の正規化後に**19/19ファイルの内容・SHA-256が候補と一致**した。

キャッシュ回避URLの新しい内蔵ブラウザータブで工程一覧と実在庫画面の読み込みを確認し、コンソールエラーはなかった。在庫ダイアログに数量5と確認用の備考を入力し、Escapeで閉じて再表示した際の復元を確認した。確認用入力は空に戻して閉じ、工程一覧へ戻した。案件・在庫の保存、出荷取消、メール取込などの実データ操作は行っていない。

ローカル証跡は `output/release-seven-fixes-20261026-143637/` に保管した。

- `all-tests.log` / `contrast.log`
- `candidate-hashes.json` / `comparison-before.json` / `comparison-after.json`
- `deployments-before.txt` / `push.log` / `version.log` / `deploy.log` / `deployments-after.txt`
- `before-v97/` / `candidate/dist/` / `after-v98/`
- `browser-check.json` / `production-v98.jpg`

実GASの並行更新・ロック待機と、実Sheetsへの特殊文字の保存・再保存は、この公開確認では実行していない。ローカルの障害注入テストと配置内容の一致を、実サービス上の全動作確認と混同しない。F02の旧形式・AI内容変化による要確認データも自動修復していない。
