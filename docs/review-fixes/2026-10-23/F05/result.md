# F05 Sheets文字列保存

未保護の保存経路を確認し、管理シートの書き込み境界に共通エンコードを追加した。先頭 `=` と先頭アポストロフィのみSheetsの文字列エスケープを付ける。sanitizeText_、画面モデル、JSONの意味、通常の数値・Date・真偽値は変更しない。
案件、取込、設定、製品補完、マスター設定、研磨ミラー、材料・完成品在庫、監査ログの外部入力writerへ適用した。固定ヘッダー、サーバー生成日時、JSON.stringifyだけの値は元のまま。既存データの一括変換は行わない。

関連177テスト成功。実際のwriter/readerで、先頭 `=`、1個/複数のアポストロフィ、改行、日本語を保存し、別項目更新と繰り返し再保存後も同じ値になることを確認。通常値・日時・JSONも確認した。

公式のsetValues仕様: https://developers.google.com/apps-script/reference/spreadsheet/range#setvaluesvalues

実Sheetsへの書込は未実施。後日許可された隔離コピーで上記文字列を案件・取込へ保存し、getValues/getDisplayValues/getFormulasと画面再読込を比較する。getFormulasが空で、先頭アポストロフィが元の個数のままになること、再保存で増減しないことを確認する。ローカルの数式解釈スタブは、この実確認の代用ではない。
