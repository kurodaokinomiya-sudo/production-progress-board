# HAKOBI 操作マニュアル 実画面版

2026年11月20日改訂。作業者・編集者向け、v121対応のA4縦39ページです。
表紙と目次から、共通の工程・配布表と、編集者の注文・研磨・出荷・在庫の手順を開けます。

- 配布用PDFは `output/pdf/生産工程管理_操作マニュアル_実画面版.pdf` に生成します。
- ブラウザーで読む場合は[操作マニュアル（実画面版）](../操作マニュアル_実画面版.md)を開きます。
- 本文の編集元は [manual-content-2026-11-20.json](../manual-content-2026-11-20.json) です。
- 撮影画像とファイルの照合記録は [2026-11-20-v121/manifest.json](2026-11-20-v121/manifest.json) にあります。

画像は11月20日のv121配信ファイルをローカルで開き、説明用の案件・数量・アカウントで撮影しています。
PDFでは手順に必要な箇所を拡大し、番号を操作手順とそろえています。撮影時のJPEGはそのまま保管します。
2026年10月30日版のPDFは `output/pdf/archive/` に保管しています。

## 再生成

Codexのワークスペース依存関係にあるNode.js、Python、Popplerと、Chromeを使います。
撮影に使う配信ファイルは `output/release-2026-11-20-stock-width/deployed-version/download/` の
`Index.html` と `Access.html` です。撮影用ブラウザー内でローカルのファイルとデータを読み込みます。
セットアップ済みのPlaywright Chromiumで撮影する場合は `MANUAL_BROWSER_CHANNEL=chromium` を設定します。

```powershell
node tools/capture-manual-screenshots.mjs
python tools/build-screenshot-manual.py
$manualQa = 'tmp/pdfs/manual-2026-11-20-v121'
pdftoppm -r 120 -png (Join-Path $manualQa '生産工程管理_操作マニュアル_実画面版.pdf') (Join-Path $manualQa 'page')
python tools/verify-screenshot-manual.py
# 全ページのPNGを確認した後、配布用PDFとMarkdownを所定の場所に配置
python tools/verify-screenshot-manual.py --publish
```

検証結果は `tmp/pdfs/manual-2026-11-20-v121/verification.json` に保存します。
配信ファイルとのハッシュ一致、PDFのページ番号・目次リンク・しおり、日本語フォントの埋め込みを確認します。
