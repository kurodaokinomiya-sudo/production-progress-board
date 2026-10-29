# 2026-10-29 技術レビュー改善の実装記録

今回の範囲はN01〜N06のローカル実装・検証・個別コミット。GitHub push、Apps Script push、デプロイ、本番データ・設定・権限・メールの変更は実施していない。C01〜C04の未確認事項は修正課題に追加していない。

|単位|変更理由と主な対象|個別記録|
|---|---|---|
|N01|全角Tezoeだけ完了ガードが抜ける条件を共有識別に統一。Repository.gs、finished-stock.js、app.js|[再現・104回帰・生成物確認](N01.md)|
|N02|混合出荷完了後の取消は注文の明示再開を要求。finished-stock.js、stock-completion-qa.mjs|[108回帰・履歴の実DOM操作](N02.md)|
|N03|lock取得後に必要権限を再取得。サーバーの全mutation入口とrepairを照合。worker/editor/admin/owner境界を維持|[入口一覧・降格/削除回帰・隔離GAS手順](N03.md)|
|N04|品名の強弱弯＋上下方向をUI/Mock/Serverで同じ型に補完。app.jsの最小変更、Parserの挙動を維持|[共通ケース表・保存/再読込・一括取込](N04.md)|
|N05|Node宣言を固定依存と一致させ、24系を推奨。package/lock、README、browser-qa.md|[隔離npm ci・905回帰・PDF実抽出](N05.md)|
|N06|保存された10〜300秒を単一タイマーへ反映。app.js、README|[制御時計・失敗回復・遅い応答の回帰](N06.md)|

開始時はmain、HEAD `d06d327cd84cdfa99520c2a6628883ff23ecd23f`、origin/mainより2コミット先行していた。未コミットのProductMaster.gs、app.js、polishing-billing-ui.test.mjs、product-master.test.mjsは `output/improvements-2026-10-29/baseline/` へ退避し、変更を保持して今回のコミットから除外した。

各N番号のコミットは `git log --oneline --grep='N0[1-6]'` で追跡できる。作業ファイルだけでなく、部分ステージしたソースの構文と実際のコミット差分も確認する。初回のN03/N04切り出しで行位置がずれた2ファイルは、未公開の当該コミットを修正してから確定した。開始時から存在するコミットと未コミット変更は保持した。

全テスト、正規build、contrast、diff-check、smoke/競合回復/在庫ダイアログ/在庫完了の最終結果とコミットIDは `output/improvements-2026-10-29/final-report.md` に記録する。各QAは専用localhost・隔離保存領域でsource/distを確認し、実サービスの成功とは区別する。

実GASの並行実行、実Sheets文字列往復、実アカウント失効、実AI/Gmailは未確認。隔離スクリプト・検証用シート・専用アカウントが未準備で、本番設定を変える検証は禁止されている。N03の個別記録に準備と手順を残した。Node22下限とmacOS/Linuxも未検証。
