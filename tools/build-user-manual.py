"""Build the illustrated A4 user manual. Requires bundled reportlab and pypdf.

Run from any directory with the Codex bundled Python runtime. All diagram data
is fictional. No application data, credentials or network services are used.
"""
from pathlib import Path
from html import escape
import json
import math
import re

from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "生産工程管理_操作マニュアル.pdf"
SOURCE = ROOT / "docs" / "操作マニュアル.md"
QA = ROOT / "tmp" / "pdfs" / "manual-layout.json"
DATE = "2026年10月8日"
FONT_DIR = Path("C:/Windows/Fonts")
pdfmetrics.registerFont(TTFont("JP", str(FONT_DIR / "meiryo.ttc"), subfontIndex=0))
pdfmetrics.registerFont(TTFont("JPB", str(FONT_DIR / "meiryob.ttc"), subfontIndex=0))

PAGES = [
    dict(title="生産工程管理 操作マニュアル", role="共通", kind="cover"),
    dict(title="アプリの開き方と、権限の違い", role="共通", kind="login",
         lead="端末に設定されたアプリを開きます。利用登録済みのGoogleアカウントでの確認が終わると「工程一覧」が開きます。",
         steps=[
             ("設定済みのアプリを開く", "端末に設定されたアプリを開きます。Googleへのログインを求められたら、管理者に登録してもらったアカウントを選びます。"),
             ("確認画面が出た場合だけ、メールで確認", "メールアドレスを入力し「確認コードを送信」。届いた8桁の数字を入力して「確認する」→「アプリを開く」を押します。自動確認された場合は、この操作は不要です。"),
         ],
         notes=[("コードが届かない・使えない", "迷惑メールと入力アドレスを確認します。コードの有効期限は10分、再送は60秒後からです。届かない場合は、管理者にアカウント登録を確認してもらいます。")]),
    dict(title="職人編の目次", role="職人 / 作業員", kind="worker_toc",
         lead="職人の方は、この順に読めば日々の工程管理を始められます。事務の方も、工程操作は同じです。",
         toc=[(4,"工程一覧を見る・案件を探す"),(5,"1つの工程の担当・状態を変える"),(6,"全工程をまとめて変える"),(7,"研磨に出す・戻りを反映する"),(8,"鋭匙鉗子の配布担当・配布表"),(9,"出荷待ち・出荷完了・再開"),(10,"保存エラーと端末の表示設定")],
         notes=[("先に確認", "アプリの開き方と権限は2ページ。困ったときは19ページ、運用開始時の確認は20ページをご覧ください。")]),
    dict(title="工程一覧を見る・案件を探す", role="職人 / 作業員", kind="ledger",
         lead="1行が1つの製品です。起動時は未出荷の案件が表示され、ケリソンパンチ・鋭匙鉗子・その他の順に表が分かれます。",
         steps=[
             ("検索・絞り込みを開く", "「検索・絞り込み・並び順」を押し、得意先・品名・連番・担当などで検索します。「工程」「状況」「並び順」も選べます。"),
             ("製品を確認して、工程の欄を押す", "品名を押すと詳しい内容が見られます。担当や状態が表示された工程欄を押すと、工程の編集画面が開きます。"),
             ("見やすい大きさにする", "「33製品」は通常表示、「23製品（簡易view）」は大きめの表示です。倍率欄に40〜160%を入力できます。表の2本指ピンチでも拡大・縮小できます。"),
         ],
         notes=[("表の読み方", "鋭匙鉗子では「頭付け・幅取り」、ケリソンパンチでは「厚みとり」と表示します。PCはCtrl（Macは⌘）＋ホイールで拡大・縮小。通常のホイールや1本指はスクロールです。")]),
    dict(title="1つの工程の担当・状態を変える", role="職人 / 作業員", kind="process",
         lead="案件を確認し、変更したい工程の行だけを操作します。担当と状態は、別々に選びます。",
         steps=[
             ("対象の案件を確認する", "画面上の得意先・品名・連番・数量・納期を、手元の製品や指示と照合します。"),
             ("担当と状態を押して選ぶ", "担当は名前、解除は「未定」を押します。表示された状態から実際の作業状況に合わせて選びます。通常の「仕上げ」工程には「完了」の操作がありません。「最終仕上げ」は研磨の全数発送・全数戻り後だけ完了できます。"),
             ("「工程を保存」を押す", "画面はすぐに閉じて一覧へ戻り、通信による保存が続きます。保存中は同じ案件を再編集できません。エラーが出た場合は10ページへ。"),
         ],
         notes=[("状態の意味", "未着手＝まだ作業前、進行中＝作業中、完了＝その工程の作業済み、保留＝中断・確認待ちの目安として使います。"),
                ("保存するまでの扱い", "担当や状態を選んだだけでは確定しません。変更を反映するには「工程を保存」を押します。「閉じる」で閉じた通常の未保存入力は保持されません。")]),
    dict(title="全工程をまとめて変える", role="職人 / 作業員", kind="bulk",
         lead="同じ案件の5工程へ、同じ担当または同じ状態をまとめて入力できます。担当の一括変更と状態の一括変更は、別々の操作です。",
         steps=[
             ("希望する担当名、または状態を長押し", "押したまま少し待つと、上に「全」が現れます。長押しが成立する前に指を動かすと操作が取り消されます。"),
             ("指を離さず「全」へ動かし、そこで離す", "全工程に同じ担当または状態が入ります。「候補設定が必要」と出た担当は、一括変更できません。"),
             ("全工程を確認して「工程を保存」", "間違えた場合は「直前の一括変更を戻す」を押します。これは、最後の1回の一括変更を戻す操作です。保存後の訂正は、再度開いて変更します。"),
         ],
         notes=[("PCでの操作・担当候補", "対象の担当名や状態ボタンにTabキーで移動し、Alt＋↑でも一括入力できます。最終仕上げの完了条件は一括変更では回避できません。候補の変更は管理者へ依頼します。")]),
    dict(title="研磨に出す・戻りを反映する", role="職人 / 作業員", kind="polishing",
         lead="発送・戻りを案件ごとの数量で記録します。発送日は、工程一覧の「発」と研磨管理表の「発送日」で確認できます。",
         steps=[
             ("研磨に出したら、工程一覧の「研」を押す", "品名・連番・数量を確認して押します。確認画面を挟まず、未発送分すべてを発送として記録します。"),
             ("全数が戻った案件をチェックして反映", "「研磨管理表」→「研磨屋にある製品」で案件を選び、「選択した案件の戻りを反映」を押します。「今回反映」は未返却分すべて。最大100件です。"),
             ("戻り後に、最終仕上げへ進む", "「最終仕上げ待ち・仕上げ中」に切り替え、最終仕上げのボタンから工程画面を開きます。担当・状態を更新して保存します。"),
         ],
         notes=[("全数の発送・戻りを確認して反映", "通常の「仕上げ」工程に完了操作はありません。「最終仕上げ」の完了操作は、研磨へ実数量の全数を発送し、その全数が戻った後だけ使えます。未発送・一部発送・未返却では完了できず、一括変更でも回避できません。")]),
    dict(title="鋭匙鉗子の配布担当・配布表", role="職人 / 作業員", kind="distribution",
         lead="「担当・配布表」は、鋭匙鉗子の納期月ごとの割り振り表です。配布担当は、工程ごとの担当とは別に、1案件につき1人を選びます。",
         steps=[
             ("「納期の月」と、並び順を選ぶ", "「前月」「翌月」でも月を変えられます。「納期順」または「得意先順」を選び、必要なら担当者で絞り込みます。終了案件も見る場合は「出荷完了を含める」を選びます。"),
             ("案件の行で担当名を押す", "選ぶとすぐに保存されます。「未定」で解除できます。納期未設定の案件は月別表に出ないため、事務へ確認します。"),
             ("「配布表を1枚に印刷」を押す", "表示中の案件と並び順で、A4縦1枚に自動縮小します。ブラウザの印刷設定はA4・縦・倍率100%・ヘッダーとフッターをオフにします。"),
         ],
         notes=[("合計の範囲が違います", "画面下の担当別合計は、担当で絞り込んでも選択月全体です。印刷の合計は、印刷対象だけです。「出荷完了を含める」の選択は集計にも反映されます。配布表の印刷で、製品ラベルの印刷待ちは変わりません。")]),
    dict(title="出荷待ち・出荷完了・再開", role="職人 / 作業員（閲覧）／事務・管理者・所有者（操作）", kind="shipping",
         lead="「最終仕上げ」の完了操作は研磨へ全数量を発送し、その全数が戻った後だけ使えます。完了後は先行工程が未完了でも出荷待ちへ移ります。作業員は出荷待ち・終了リストの閲覧のみで、出荷完了・再開は編集者・管理者・所有者が行います。",
         steps=[
             ("最終仕上げと、研磨の全数を確認", "通常の「仕上げ」工程に完了操作はありません。未発送・一部発送・未返却では最終仕上げを完了できず、通常工程や一括変更でも回避できません。先行工程の完了は出荷待ちへ移す条件ではありません。"),
             ("出荷待ちタブで実際の出荷を確認", "出荷後、編集者・管理者・所有者が「出荷完了」を押すと終了リストへ移ります。"),
             ("終了案件を探す・必要なら戻す", "終了リストで期間を選んで検索します。編集者・管理者・所有者が「出荷待ちへ戻す」を行うと出荷待ちへ戻ります。作業員は閲覧のみです。"),
         ],
         notes=[("再作業・研磨戻りの訂正", "条件を満たさず誤って完了扱いになった未出荷案件は工程一覧に残るか戻り、作業員が工程を更新できます。案件全体の一括リセットはしません。再開後に必要な工程を変えて保存します。研磨の戻りを直すときは、再開してから7ページの「研磨状態に戻す」を使います。")]),
    dict(title="保存エラーと端末の表示設定", role="職人 / 作業員", kind="recovery",
         lead="保存エラーが出たときは、表示された案内から入力を確認します。表示倍率やライト・ダークの設定は、この端末だけに保存されます。",
         steps=[
             ("工程の保存に失敗したら、入力を開く", "「入力内容を開く」を押すと、保存できなかった工程入力を復元できます。別の画面を編集中なら、先にその画面を閉じます。"),
             ("保存済みの内容と照合して、保存し直す", "「別の端末で先に更新」と出た場合は、最新の内容を確認します。復元した入力は更新前の内容を含むため、必要な変更だけを残して再度保存してください。"),
             ("画面の見やすさを調整する", "一覧の倍率は4ページを参照。「設定」→「表示モード」で「端末に合わせる」「ライト」「ダーク」を選べます。作業員に表示される設定はこの端末の表示だけです。"),
         ],
         notes=[("事務・管理者へ依頼すること", "品名・数量・納期などの訂正は事務へ、担当候補や利用権限の変更は管理者へ依頼します。復元したい入力がある間は、ブラウザを再読み込みする前に内容を控えてください。")]),
    dict(title="事務編の目次", role="事務 / 編集者", kind="editor_toc",
         lead="受注内容を正確に登録し、職人へ渡すための操作です。編集者は、職人編にある工程・研磨・配布担当・出荷の操作も行えます。",
         toc=[(12,"概況を確認・案件を追加する"),(13,"注文情報の訂正・案件の削除"),(14,"PDF・画像・メール本文の取込"),(15,"取込キューを確認して反映する"),(16,"製品ラベルを印刷する"),(17,"製品番号・材料表示・研磨区分"),(18,"配布表・月別研磨代を確認する"),(19,"困ったときの早見表"),(20,"運用開始チェックと毎日の手順")],
         notes=[("共通の操作", "開き方と権限は2ページ。工程入力は5〜6ページ、研磨の発送・戻りは7ページ、配布表は8ページ、出荷完了・再開は9ページを参照します。")]),
    dict(title="概況を確認・案件を追加する", role="事務 / 編集者", kind="order",
         lead="「概況」で全体の件数を確認します。手入力で受注を登録する場合は「案件を追加」を使います。",
         steps=[
             ("「概況」の件数から対象を開く", "「進行中」「納期注意」「今月完了」「出荷待ち」「ラベル印刷待ち」を押すと、対象一覧を開けます。「納期注意」は期限超過〜あと2日の案件です。"),
             ("「案件を追加」で注文情報を入力", "必須は「得意先」「品名」です。運用上は数量・納期・連番・大分類・全長・型・刃幅も原本と照合します。品名からの自動補完は、空欄だけに入ります。"),
             ("ラベルの要否を選び「注文情報を保存」", "手入力案件でラベルが必要なら「製品ラベル」を「印刷待ち」にします。保存後、工程一覧に案件があることを確認します。"),
         ],
         notes=[("納期・数量を確認", "納期や数量が空でも手入力は保存できますが、納期未設定は月別配布表に出ず、数量が正しい整数でないと研磨への発送はできません。未確定の内容は、確認してから補います。")]),
    dict(title="注文情報の訂正・案件の削除", role="事務 / 編集者", kind="edit",
         lead="数量・納期・品名などを直すときは「注文情報」の編集を使います。工程の担当・状態を直すときは、5ページの工程画面を使います。",
         steps=[
             ("対象の案件を検索し、右端の鉛筆を押す", "一覧の右端「編集」列にある鉛筆のボタンを押します。「23製品（簡易view）」で編集列が出ないときは「33製品」に戻します。画面名は「案件を編集」です。"),
             ("訂正して「注文情報を保存」", "数量・納期・仕様などを原本と照合します。印刷済みラベルに関わる内容を直すと「再印刷待ち」へ戻ることがあるため、ラベルも確認します。"),
             ("誤登録を消す場合は「案件を削除」", "削除操作の前に対象を確認します。削除後に表示される「元に戻す」で直後の削除を戻せます。研磨屋に数量が残っている案件は削除できません。"),
         ],
         notes=[("出荷済み案件は、削除と区別", "出荷待ちタブから出荷完了を記録すると終了リストに残ります。誤って出荷完了にした場合は、編集者・管理者・所有者が「出荷待ちへ戻す」を使います。案件の削除は誤登録など不要な案件に使います。")]),
    dict(title="PDF・画像・メール本文の取込", role="事務 / 編集者", kind="import",
         lead="「注文を取り込む」で読み取り、まず「取込キュー」に候補を入れます。読み取りだけでは、製作する案件には登録されません。",
         steps=[
             ("取込方法を選ぶ", "「PDF・画像」はJPEG・PNG・WebP・PDFを選択し「PDF・画像を読み取る」。「本文を貼り付け」はメール本文と、必要なら件名を入れ「本文を読み取る」を押します。"),
             ("読取方法を確認する", "従来の読取またはAIを選びます。AIは所有者による事前設定が必要で、選ぶと注文書・貼り付けた本文や件名をGoogleへ送信します。読取結果は原本と確認します。"),
             ("「取込キュー」で全品目を確認する", "複数品目の注文書は、品目ごとの候補になることがあります。抜け・数量・納期・得意先を確認してから、15ページの操作で案件へ反映します。"),
         ],
         notes=[("編集者が使う取込方法", "編集者はファイルと本文貼り付けを利用します。Gmail検索とAIの設定・接続診断は所有者、得意先の読取ルールは管理者へ依頼します。本文は30,000文字までです。")]),
    dict(title="取込キューを確認して反映する", role="事務 / 編集者", kind="intake",
         lead="原本を見ながら、候補の内容を訂正します。読取結果の確からしさが高くても、人が確認してから反映します。",
         steps=[
             ("1品目ずつ確認する場合", "「内容を確認する」を開き、得意先・品名・数量・納期・連番・大分類・仕様を照合し「確認して案件へ反映」を押します。"),
             ("複数品目をまとめて確認する場合", "「まとめて確認・編集」で修正し、反映する品目だけをチェックします。得意先・品名・正の整数の数量が必要です。「選択した注文を反映」は1回100件までです。"),
             ("反映後、案件とラベル待ちを確認", "チェックしなかった品目は確認待ちに残ります。不要な候補は「この品目を削除」または選択削除で整理します。反映した案件はラベル印刷待ちになります。"),
         ],
         notes=[("重複・未保存入力", "同じ原本を取り込み直すと、別の候補ができることがあります。反映前に既存案件の連番・品名・数量を照合します。一括確認の入力は画面を閉じても保持しますが、ブラウザの再読み込みで破棄されます。")]),
    dict(title="製品ラベルを印刷する", role="事務 / 編集者", kind="labels",
         lead="「ラベル印刷」で案件を選び、プレビューを確認します。1回に最大9件、A4縦の上から1列9段に配置します。1枚のラベルは横15cm・縦3cmです。",
         steps=[
             ("印刷対象を選び、プレビューを確認", "初めは印刷待ちの先頭9件までが選択されます。得意先・品名・仕様・連番・数量・納期と材料表示を確認し、不要な選択を外します。"),
             ("「○枚を印刷」を押して紙に印刷", "A4・縦・倍率100%・ヘッダーとフッターをオフにします。最初の1枚は定規で15cm×3cmを確認します。"),
             ("紙を確認して、印刷完了を確定", "紙が正しく出たら「印刷完了・待ちから外す」。中止・失敗した場合は「キャンセル・待ちに残す」を押します。印刷画面を閉じるだけでは印刷済みになりません。"),
         ],
         notes=[("待ちに残ったラベル・再印刷", "すでに印刷した案件だけを選び「選択分を印刷済みにする」でも整理できます。再印刷は表示範囲を「印刷済み」や「すべての進行案件」にして選択します。納期月のマーカー色はプレビューで確認してください。")]),
    dict(title="製品番号・材料表示・研磨区分", role="事務 / 編集者", kind="material",
         lead="製品番号は、製品構成マスタとの照合に使います。材料表示は工程一覧と製品ラベル、研磨区分は月別の研磨代集計に関係します。",
         steps=[
             ("案件の「製品番号」を確認", "原本や製品の番号に合わせます。照合できないときは品名・番号を確認し、必要に応じて管理者へマスタの確認を依頼します。"),
             ("必要なら「材料表示（一覧・ラベル）」を訂正", "入力できる材料表示は「ｱﾘｼﾞ」「白銅」「ｳｽｲ」です。注文情報を保存すると、同じ製品の次回表示にも反映します。空欄にするとマスタの自動表示へ戻ります。"),
             ("研磨管理表の「研磨区分」を確認・訂正", "通常は「自動判定（区分）」です。編集者が区分を選ぶと、同じ製品と月別集計に保存・反映されます。「自動判定に戻す」で手動指定を解除できます。作業員は区分の確認のみです。"),
         ],
         notes=[("メニスカス・江部専用区分", "品名にメニスカスがある製品は「B(メニスカス)」へ自動判定します（半角表記にも対応）。嘉代の初期単価は3,300円／丁です。「江部電解」「江部磨き」は江部のみで計算します。未分類は内容を確認して訂正し、単価・マスタの変更は管理者へ依頼します。")]),
    dict(title="配布表・月別研磨代を確認する", role="事務 / 編集者", kind="office_totals",
         lead="配布表は「納期の月」、研磨代は「戻り月」で確認します。集計する基準が違うため、対象月をそれぞれ確認してください。",
         steps=[
             ("月別配布表を確認・印刷する", "鋭匙鉗子の配布担当は8ページの手順です。数量未入力の案件を確認し、納期順・得意先順、担当者、出荷完了の扱いを選んで印刷します。"),
             ("「研磨管理表」で戻り月を選ぶ", "下部の「月別の研磨代」で、江部・嘉代それぞれの金額と、区分別の戻り数量・単価・金額を確認します。発送月ではなく戻り月が基準です。"),
             ("「未確定」「要確認」を解消する", "未分類は17ページで訂正します。単価未設定は管理者へ確認します。「計算済み」は確認できた部分の金額です。月の単価保存・前月単価の入力は管理者の操作です。"),
         ],
         notes=[("研磨先別の計算", "通常は江部の通常料金＋嘉代の区分別料金を集計します。「江部電解」「江部磨き」は江部のみで、通常料金を重ねません。単価は選んだ月の画面で確認します。"),
                ("取消と合計の範囲", "取り消した戻りは、元の戻り月の研磨代から除外します。配布表の画面合計は月全体、印刷合計は印刷対象です。配布表の印刷はラベル履歴を変えません。")]),
    dict(title="困ったときの早見表", role="共通", kind="troubleshooting",
         lead="表示される言葉を手がかりに、次の操作を選びます。入力を復元したい場合は、再読み込みの前に内容を控えてください。",
         issues=[
             ("案件が見つからない", "検索・工程・状況の絞り込みを戻します。出荷済みなら終了リストの「すべて」。配布表なら納期の月・納期未設定・大分類を確認。", "4・8・9"),
             ("工程を保存できない", "「入力内容を開く」から復元して確認。別の端末の更新がある場合は、最新の内容と照合してから保存します。", "10"),
             ("出荷待ちに出ない", "研磨へ全数量を発送し、その全数が戻ったか確認。未発送・一部発送・未返却では最終仕上げを完了できません。", "7・9"),
             ("戻りの反映を押せない", "対象をチェックします。「更新あり・選択し直す」と出たら、その行を選び直して数量を確認します。", "7"),
             ("戻りを間違えて反映した", "「すべて・履歴」で対象の履歴を開き、「研磨状態に戻す」。直前の戻り全数量を取り消します。出荷済みなら先に終了リストで再開します。", "7・9"),
             ("担当者が候補にない", "管理者へ、工程ごとの担当候補または配布担当の候補の変更を依頼します。", "6・8"),
             ("ラベルが待ちに残る", "紙が出たことを確認して「印刷完了・待ちから外す」。すでに印刷した対象は「選択分を印刷済みにする」。", "16"),
             ("取込結果に抜け・誤読", "原本と照合し、取込キューで訂正。抜けた品目は手入力で追加します。反映前に重複も確認。", "12・15"),
             ("利用アカウントを確認", "許可されたアカウントで開き直します。本人確認・登録権限の確認は管理者へ。", "2"),
         ],
         notes=[("連絡時に伝える内容", "案件の連番・品名、押した操作、表示されたエラー、発生時刻を事務または管理者へ伝えます。")]),
    dict(title="運用開始チェックと毎日の手順", role="共通", kind="daily",
         lead="利用開始前に、職人と事務のアカウントでそれぞれ開き、担当する操作ができることを確認します。",
         checks=[
             "管理者がGoogleアカウントと権限を登録した。職人は「作業員」、事務は「編集者」。",
             "2ページの手順で開けた。職人・事務それぞれの画面を確認した。",
             "管理者が工程と配布表の担当候補を確認した。既存の割当も確認した。",
             "事務が既存案件の品名・数量・納期・大分類・連番を確認した。",
             "配布表と製品ラベルを試し刷りし、文字と寸法を確認した。",
             "保存エラー、注文訂正、権限変更について、連絡する担当者を決めた。",
         ],
         notes=[("この冊子の印刷・図について", "この冊子はA4縦・倍率100%で印刷してください。図と案件・数値は説明用です。2026年10月8日、研磨の戻り取消・区分・月別集計を最新の実装に合わせて更新しました。")]),
]

# A dedicated correction page keeps the actual controls readable on A4.
# Existing references below are written in the original 20-page numbering.
def shift_page_references(value):
    def shift(match):
        return re.sub(r"\d+", lambda number: str(int(number.group()) + (int(number.group()) >= 8)), match.group())
    return re.sub(r"\d+(?:[〜・]\d+)*ページ", shift, value)

for page in PAGES:
    for key in ("lead",):
        if key in page:
            page[key] = shift_page_references(page[key])
    for key in ("steps", "notes"):
        if key in page:
            page[key] = [(shift_page_references(title), shift_page_references(body)) for title, body in page[key]]
    if "toc" in page:
        page["toc"] = [(dest + (dest >= 8), title) for dest, title in page["toc"]]
    if "issues" in page:
        page["issues"] = [(title, shift_page_references(body),
                           re.sub(r"\d+", lambda m: str(int(m.group()) + (int(m.group()) >= 8)), ref))
                          for title, body, ref in page["issues"]]
PAGES[2]["toc"].insert(4, (8, "研磨の戻り取消・発送数量の訂正"))
PAGES.insert(7, dict(title="研磨の戻り取消・発送数量の訂正", role="職人 / 作業員", kind="polishing_correction",
    lead="戻りを間違えたときと、発送数量を間違えたときは、別の操作で直します。品名・連番・履歴の数量を確認してから操作してください。",
    steps=[
        ("「すべて・履歴」で対象案件を探す", "「研磨管理表」の表示を「すべて・履歴」にして検索します。右端の履歴（○回）を開きます。戻り済みなら「最終仕上げ待ち・仕上げ中」でも探せます。"),
        ("誤った戻りは「研磨状態に戻す」", "直前の戻り全数量を取り消します。発送日・発送数量は保ち、研磨屋の数量を戻します。最終仕上げは未着手へ戻り、取消記録は履歴に残ります。"),
        ("誤った発送は「発送数量を訂正」", "履歴から訂正画面を開き、取り消す丁数を入力します。画面下の「発送数量を訂正」を押して保存します。未返却分の範囲で訂正します。"),
    ],
    notes=[("出荷済み・月別研磨代への影響", "出荷済みの戻りを直す場合は、10ページで再開してから操作します。取り消した戻りは、元の戻り月の研磨代から除外されます。再び全数が戻ったら、7ページで戻りを反映し直します。")]))
for page in PAGES:
    if page["kind"] == "shipping":
        page["notes"] = [(title, body.replace('7ページの「研磨状態に戻す」', '8ページの「研磨状態に戻す」'))
                         for title, body in page["notes"]]
    if page["kind"] == "troubleshooting":
        page["issues"] = [(title, body, "8・10" if title == "戻りを間違えて反映した" else ref)
                          for title, body, ref in page["issues"]]
    if page["kind"] == "editor_toc":
        page["notes"] = [(title, body.replace("研磨の発送・戻りは7ページ", "研磨の発送・戻りは7ページ、取消・訂正は8ページ"))
                         for title, body in page["notes"]]

W, H = A4
M = 43
CW = W - 2 * M
INK = colors.HexColor("#202D3B")
MUTED = colors.HexColor("#526271")
BORDER = colors.HexColor("#BAC5CF")
BLUE = colors.HexColor("#175977")
ORANGE = colors.HexColor("#874720")
TEAL = colors.HexColor("#285D4D")
PALE = colors.HexColor("#F2F5F7")
WHITE = colors.white
layout_checks = []
page_number = 0
c = None

def tone(role):
    return ORANGE if role.startswith("事務") else BLUE

def box(x, top, width, height, fill=WHITE, stroke=BORDER, radius=5):
    if top + height > H - 40:
        raise ValueError(f"Page {page_number}: box below content bounds ({top+height:.1f})")
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(.65)
    c.roundRect(x, H - top - height, width, height, radius, fill=1, stroke=1)

def para(text, x, top, width, size=11, bold=False, color=INK,
         align=TA_LEFT, leading=None, max_height=None):
    style = ParagraphStyle("t", fontName="JPB" if bold else "JP", fontSize=size,
                           leading=leading or size*1.53, textColor=color,
                           alignment=align, wordWrap="CJK", spaceBefore=0, spaceAfter=0)
    p = Paragraph(escape(str(text)).replace("\n", "<br/>"), style)
    _, height = p.wrap(width, 2000)
    if max_height is not None and height > max_height + .1:
        raise ValueError(f"Page {page_number}: text overflows box: {text!r} ({height:.1f}>{max_height:.1f})")
    if top + height > H - 40:
        raise ValueError(f"Page {page_number}: text below content bounds ({text[:30]})")
    p.drawOn(c, x, H - top - height)
    layout_checks.append(dict(page=page_number, kind="text", x=round(x,2), top=round(top,2),
                              width=round(width,2), height=round(height,2), text=text))
    return height

def button(text, x, top, width, height=27, selected=False, color=BLUE, size=9):
    box(x, top, width, height, color if selected else WHITE,
        color if selected else BORDER, radius=4)
    lead = size*1.45
    lines = text.count("\n") + 1
    para(text, x+3, top+(height-lines*lead)/2-1, width-6, size=size, bold=selected,
         color=WHITE if selected else INK, align=TA_CENTER, leading=lead,
         max_height=height-2)

def arrow(x1, y1, x2, y2, color=BLUE, width=1.6):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(width)
    c.line(x1, H-y1, x2, H-y2)
    angle = math.atan2(y2-y1, x2-x1)
    s=6
    points=[(x2, y2),(x2-s*math.cos(angle-.48),y2-s*math.sin(angle-.48)),
            (x2-s*math.cos(angle+.48),y2-s*math.sin(angle+.48))]
    p=c.beginPath()
    p.moveTo(points[0][0],H-points[0][1])
    for x,y in points[1:]: p.lineTo(x,H-y)
    p.close()
    c.drawPath(p,fill=1,stroke=0)

def number(n, x, top, color=BLUE, radius=10):
    c.setFillColor(color)
    c.circle(x+radius,H-top-radius,radius,fill=1,stroke=0)
    para(str(n),x,top+2,radius*2,size=10,bold=True,color=WHITE,align=TA_CENTER)

def pencil(x,top,size=17):
    c.setStrokeColor(ORANGE);c.setLineWidth(2)
    c.line(x,H-top-size,x+size,H-top)
    c.line(x+3,H-top-size+1,x+size+1,H-top-3)
    c.line(x,H-top-size,x+4,H-top-size+1)
    c.line(x+size,H-top,x+size+3,H-top-3)

def frame(top, height, title):
    box(M,top,CW,height,fill=PALE)
    para(title,M+13,top+9,CW-26,size=9.3,bold=True,color=MUTED)
    return M+13, top+33, CW-26

def table(x, top, widths, headers, rows, row_h=32, size=9.2, header_h=29,
          highlight=None):
    total=sum(widths)
    box(x,top,total,header_h+len(rows)*row_h,fill=WHITE,radius=0)
    c.setFillColor(colors.HexColor("#E7EDF2"))
    c.rect(x,H-top-header_h,total,header_h,fill=1,stroke=0)
    if highlight is not None:
        c.setFillColor(colors.HexColor("#EAF2F6"))
        c.rect(x,H-top-header_h-(highlight+1)*row_h,total,row_h,fill=1,stroke=0)
    current=x
    for i,w in enumerate(widths):
        para(headers[i],current+5,top+5,w-10,size=size-.2,bold=True,
             leading=(size-.2)*1.35,max_height=header_h-6)
        if i:
            c.setStrokeColor(BORDER);c.setLineWidth(.4)
            c.line(current,H-top,current,H-top-header_h-len(rows)*row_h)
        for j,row in enumerate(rows):
            para(row[i],current+5,top+header_h+j*row_h+6,w-10,size=size,
                 leading=size*1.4,max_height=row_h-9)
        current+=w
    for j in range(len(rows)):
        y=top+header_h+j*row_h
        c.setStrokeColor(BORDER);c.setLineWidth(.4);c.line(x,H-y,x+total,H-y)
    return header_h+len(rows)*row_h

def flow(top, labels, color=BLUE, height=57, x=M, width=CW):
    gap=18
    item_width=(width-gap*(len(labels)-1))/len(labels)
    for i,label in enumerate(labels):
        xx=x+i*(item_width+gap)
        box(xx,top,item_width,height,fill=WHITE,stroke=color)
        para(label,xx+5,top+12,item_width-10,size=10,bold=True,align=TA_CENTER,
             max_height=height-16)
        if i<len(labels)-1: arrow(xx+item_width+3,top+height/2,xx+item_width+gap-3,top+height/2,color)

def draw_diagram(kind, top):
    if kind=="login":
        x,y,w=frame(top,199,"確認画面が表示された場合の操作")
        box(x,y,w,145)
        para("利用アカウントの確認",x+15,y+8,w-30,size=12,bold=True)
        para("メールアドレス",x+15,y+35,150,size=9)
        button("登録したアドレス",x+15,y+51,242)
        button("確認コードを送信",x+266,y+51,175,selected=True)
        para("確認コード（8桁）",x+15,y+85,160,size=9)
        button("メールに届いた数字",x+15,y+101,242)
        button("確認する",x+266,y+101,175,selected=True)
        return 199
    if kind=="ledger":
        x,y,w=frame(top,215,"工程一覧 / 画面の一部を簡略表示")
        button("工程一覧",x,y,78,selected=True)
        button("担当・配布表",x+85,y,103)
        button("研磨管理表",x+195,y,87)
        button("33製品",x+289,y,70)
        button("75 %",x+366,y,91)
        para("検索・絞り込み・並び順",x,y+36,w,size=9,bold=True)
        para("ケリソンパンチ",x,y+59,w,size=9.5,bold=True)
        table(x,y+79,[83,143,63,85,109],["得意先","品名・連番","納期","溶接","元作り"],
              [["見本医科","ケリソン\n見本-001","10/20","豊 / 完了","幹 / 進行中"]],row_h=40,size=8.5)
        para("鋭匙鉗子の表は、この下に続きます。工程欄を押すと編集できます。",x,y+153,w,size=8.8)
        return 215
    if kind=="process":
        x,y,w=frame(top,239,"工程画面 / 選択中のボタンは濃く表示")
        box(x,y,w,191)
        para("鋭匙鉗子 / 見本医科 / 見本-002 / 10丁",x+11,y+8,w-22,size=10.5,bold=True)
        para("元作り",x+11,y+39,85,size=10,bold=True)
        para("担当",x+101,y+38,35,size=9)
        for i,t in enumerate(["未定","豊","幹","望","鈴","河"]):
            button(t,x+141+i*47,y+33,40,selected=t=="幹")
        for i,t in enumerate(["未着手","進行中","完了","保留"]):
            button(t,x+101+i*86,y+71,78,selected=t=="進行中")
        para("ほかの工程も、各行で担当と状態を選べます。",x+11,y+116,w-22,size=9.5)
        button("閉じる",x+11,y+153,87)
        button("工程を保存",x+w-147,y+153,135,selected=True)
        return 239
    if kind=="bulk":
        x,y,w=frame(top,211,"長押し → 上へ動かす →「全」で離す")
        col=(w-24)/3
        for i,label in enumerate(["1  長押しする","2  指を上へ動かす","3  全工程へ入力"]):
            xx=x+i*(col+12)
            box(xx,y,col,132)
            para(label,xx+6,y+8,col-12,size=9.5,bold=True,align=TA_CENTER)
            if i<2:
                button("全\nここで離す",xx+col/2-28,y+34,56,height=42,selected=i==1)
                button("幹",xx+col/2-28,y+90,56,selected=True)
                if i==1: arrow(xx+col/2,y+87,xx+col/2,y+79,width=2)
                else:
                    c.setStrokeColor(BLUE);c.setLineWidth(2)
                    c.circle(xx+col/2,H-y-104,24,fill=0,stroke=1)
            else:
                for j,t in enumerate(["溶接：幹","元作り：幹","仕上げ：幹"]):
                    para(t,xx+10,y+40+j*25,col-20,size=10,align=TA_CENTER)
        para("状態でも同じ操作です。最後に「工程を保存」を押します。",x,y+145,w,size=9.5,bold=True)
        return 211
    if kind=="polishing":
        x,y,w=frame(top,181,"発送 → 戻り → 最終仕上げ / 発送日も確認")
        flow(y,["工程一覧\n「研」を押す","研磨屋に\nある製品","全数の戻り\nを反映","最終仕上げ\nへ進む"],height=54,x=x,width=w)
        para("全数が戻った案件をチェックして数量を確認",x,y+67,w,size=9.4)
        button("選択した案件の戻りを反映",x+90,y+95,300,selected=True)
        para("工程一覧：発 10/6 / 研磨管理表：発送日 10/6（説明用）",x,y+133,w,size=8.8,align=TA_CENTER)
        return 181
    if kind=="polishing_correction":
        x,y,w=frame(top,204,"研磨管理表 → すべて・履歴 → 対象の履歴（○回）")
        para("戻りを間違えた",x+10,y+9,205,size=11,bold=True,color=BLUE)
        para("発送数量を間違えた",x+255,y+9,220,size=11,bold=True,color=ORANGE)
        button("研磨状態に戻す",x+10,y+38,215,selected=True)
        button("発送数量を訂正",x+255,y+38,220,selected=True,color=ORANGE)
        para("直前の戻り全数量を取消\n発送日・発送数量は保持\n最終仕上げは未着手へ",x+10,y+82,215,size=10)
        para("取り消す丁数を入力\n未返却分の範囲で訂正\n画面下の同名ボタンで保存",x+255,y+82,220,size=10)
        return 204
    if kind=="distribution":
        x,y,w=frame(top,220,"担当・配布表 / 見本の納期月")
        button("納期の月  2026-10",x,y,157)
        button("納期順",x+165,y,90)
        button("配布表を1枚に印刷",x+264,y,218,selected=True)
        para("担当で絞り込み：全員 / 豊 / 幹 / 未定",x,y+38,w,size=9)
        table(x,y+59,[80,162,67,56,118],["得意先","製品名","納期","数量","配布担当"],
              [["見本医科","鋭匙鉗子 左曲","10/20","10","幹"],
               ["サンプル商会","鋭匙鉗子 直","10/28","5","未定"]],row_h=31,size=8.7)
        para("担当別合計：幹 10丁 / 未定 5丁（画面は月全体を集計）",x,y+163,w,size=8.8)
        return 220
    if kind=="shipping":
        x,y,w=frame(top,213,"最終仕上げ完了 → 出荷待ち → 出荷完了 → 終了リスト")
        flow(y,["最終仕上げ\n完了を保存","出荷待ち\n実物を確認","出荷完了\n編集者以上","終了リスト\nへ移動"],height=60,x=x,width=w)
        button("出荷完了",x+27,y+86,206,selected=True)
        button("出荷待ちへ戻す",x+260,y+86,195)
        arrow(x+354,y+125,x+96,y+125)
        para("作業員は閲覧のみ。再開した案件は出荷待ちへ戻ります。",x,y+144,w,size=9.3)
        return 213
    if kind=="recovery":
        x,y,w=frame(top,213,"工程の保存失敗時 / 入力内容は復元できます")
        box(x,y,w,91,fill=WHITE,stroke=ORANGE)
        para("工程を保存できませんでした。入力内容は残しています。",x+11,y+10,w-22,size=10,bold=True)
        button("入力内容を開く",x+11,y+46,192,selected=True)
        arrow(x+w/2,y+101,x+w/2,y+117)
        box(x,y+123,w,42)
        para("復元した工程入力を確認 →「工程を保存」",x+8,y+135,w-16,size=10.5,bold=True,align=TA_CENTER)
        return 213
    if kind=="order":
        x,y,w=frame(top,239,"案件を追加 / 架空の入力例")
        box(x,y,w,192)
        rows=[("得意先（必須）","見本医科"),("品名（必須）","鋭匙鉗子 18cm 左曲 3mm"),
              ("数量 / 納期 / 連番","10 / 2026-10-20 / 見本-002"),("製品ラベル","印刷待ち")]
        for j,(label,value) in enumerate(rows):
            para(label,x+10,y+10+j*34,136,size=9.1,bold=True)
            button(value,x+151,y+6+j*34,w-164,size=9)
        button("注文情報を保存",x+w-194,y+155,181,selected=True)
        return 239
    if kind=="edit":
        x,y,w=frame(top,225,"一覧の右端の鉛筆で、注文情報を開きます")
        box(x,y,w,40)
        para("対象案件の行 → 右端「編集」列",x+12,y+11,w-82,size=10,bold=True)
        pencil(x+w-45,y+9)
        table(x,y+52,[138,187,158],["目的","使う操作","結果"],
              [["注文内容を訂正","注文情報を保存","案件の内容を更新"],
               ["出荷が完了した","出荷待ちで出荷完了","終了リストに残す"],
               ["不要な誤登録を消す","案件を削除","一覧から削除"]],row_h=33,size=9.2)
        return 225
    if kind=="import":
        x,y,w=frame(top,228,"取り込む → 候補を確認する → 案件にする")
        button("PDF・画像",x,y,140,selected=True,color=ORANGE)
        button("本文を貼り付け",x+150,y,165)
        para("読取方法：従来の読取 / AI",x,y+39,w,size=10,bold=True)
        flow(y+68,["原本を\n読み取る","取込キュー\n確認・訂正","確認して\n案件へ反映"],color=ORANGE,height=62,x=x,width=w)
        box(x,y+145,w,39)
        para("この段階で案件登録：内容を確認して「反映」した後",x+8,y+155,w-16,
             size=9.8,bold=True,align=TA_CENTER,color=ORANGE)
        return 228
    if kind=="intake":
        x,y,w=frame(top,245,"まとめて確認・編集 / 反映する品目だけチェック")
        table(x,y,[27,72,141,46,65,132],["選択","得意先","品名","数量","納期","確認"],
              [["✓","見本医科","鋭匙鉗子 左曲","10","10/20","原本と照合済み"],
               ["✓","見本医科","ケリソン 直","5","10/28","原本と照合済み"],
               ["□","見本医科","確認中の品目","?","未定","確認待ちに残す"]],row_h=34,size=8.3)
        button("選択した注文を反映",x+78,y+147,325,selected=True,color=ORANGE)
        para("チェックした2品目が案件へ。未選択の1品目は確認待ちに残ります。",x,y+184,w,size=8.7)
        return 245
    if kind=="labels":
        x,y,w=frame(top,236,"印刷後に、紙の結果を確認して確定します")
        box(x,y,173,183)
        para("A4縦 / 最大9件",x+7,y+8,159,size=9.5,bold=True,align=TA_CENTER)
        for j in range(9):
            box(x+21,y+34+j*16,131,15,radius=0)
            para("ラベル 1" if j==0 else str(j+1),x+24,y+35+j*16,125,size=7.3,align=TA_CENTER)
        para("紙が正しく出た",x+199,y+17,w-200,size=10,bold=True)
        button("印刷完了・待ちから外す",x+197,y+43,270,selected=True,color=ORANGE)
        para("中止した / 紙が出なかった",x+199,y+100,w-200,size=10,bold=True)
        button("キャンセル・待ちに残す",x+197,y+126,270)
        para("印刷画面を閉じるだけでは\n印刷済みになりません。",x+199,y+163,w-200,size=9.4)
        return 236
    if kind=="material":
        x,y,w=frame(top,217,"製品番号からの照合と、事務による確認・訂正")
        flow(y,["製品番号\nを照合","製品構成\nマスタ","材料表示\n研磨区分"],color=ORANGE,height=62,x=x,width=w)
        box(x,y+80,w,87)
        para("材料表示（一覧・ラベル）",x+11,y+89,w-22,size=10,bold=True)
        box(x+12,y+117,w-24,27)
        para("入力例：ｱﾘｼﾞ・白銅・ｳｽｲ",x+21,y+123,w-42,size=9.4)
        para("空欄で自動表示に戻す / 保存すると同じ製品にも反映",x+12,y+151,w-24,size=8.6)
        return 217
    if kind=="office_totals":
        x,y,w=frame(top,220,"月の選び方を確認します / 架空の数量・単価")
        box(x,y,231,163)
        box(x+245,y,w-245,163)
        para("担当・配布表",x+10,y+10,211,size=11,bold=True)
        para("基準：納期の月",x+10,y+42,211,size=10,bold=True,color=ORANGE)
        para("鋭匙鉗子の割り振り\n画面合計：月全体\n印刷合計：印刷対象",x+10,y+71,211,size=10)
        para("月別の研磨代",x+255,y+10,w-265,size=11,bold=True)
        para("基準：戻り月",x+255,y+42,w-265,size=10,bold=True,color=ORANGE)
        para("江部・嘉代を別々に集計\n通常：江部＋嘉代区分別\n取消した戻りは除外",x+255,y+71,w-265,size=10)
        return 220
    if kind=="daily":
        x,y,w=frame(top,189,"毎日の流れ / 職人と事務の受け渡し")
        para("事務",x,y+1,60,size=10.5,bold=True,color=ORANGE)
        flow(y+25,["受注の\n登録・確認","ラベル\n配布表","出荷確認\n終了処理"],color=ORANGE,height=48,x=x,width=w)
        para("職人",x,y+83,60,size=10.5,bold=True,color=BLUE)
        flow(y+107,["対象案件\nを確認","工程・研磨\nを更新","完了・数量\nを伝える"],height=48,x=x,width=w)
        return 189
    raise ValueError(kind)

def header(page, n):
    col=tone(page["role"])
    c.setFillColor(col);c.rect(M,H-31,30,4,fill=1,stroke=0)
    para(page["role"],M+40,20,310,size=8.8,bold=True,color=col)
    para("生産工程管理 / 操作マニュアル",W-M-225,20,225,size=8.2,color=MUTED,align=TA_RIGHT)
    height=para(page["title"],M,54,CW,size=20,bold=True,leading=28)
    y=54+height+12
    if page.get("lead"):
        y+=para(page["lead"],M,y,CW,size=10.8)+17
    return y

def footer(page, n):
    c.setStrokeColor(BORDER);c.setLineWidth(.5)
    c.line(M,34,W-M,34)
    c.setFont("JP",8)
    c.setFillColor(MUTED)
    c.drawString(M,20,f"{DATE}版 / 図・入力例は説明用")
    c.setFont("JPB",9)
    c.drawRightString(W-M,20,f"{n} / {len(PAGES)}")

def steps_block(items, top, role):
    y=top
    for i,(title,body) in enumerate(items,1):
        number(i,M,y+1,tone(role))
        h=para(title,M+30,y,CW-30,size=11.3,bold=True)
        y+=h+3
        y+=para(body,M+30,y,CW-30,size=10.5)+13
    return y

def note(title, text, top, role):
    title_style=ParagraphStyle("nt",fontName="JPB",fontSize=10,leading=15,wordWrap="CJK")
    body_style=ParagraphStyle("nb",fontName="JP",fontSize=10,leading=15.3,wordWrap="CJK")
    t=Paragraph(escape(title),title_style);_,ht=t.wrap(CW-26,2000)
    b=Paragraph(escape(text),body_style);_,hb=b.wrap(CW-26,2000)
    height=ht+hb+24
    box(M,top,CW,height,fill=PALE,stroke=tone(role))
    para(title,M+13,top+9,CW-26,size=10,bold=True,color=tone(role),leading=15)
    para(text,M+13,top+9+ht+5,CW-26,size=10,leading=15.3)
    return top+height+12

def cover():
    c.setFillColor(BLUE);c.rect(M,H-72,50,5,fill=1,stroke=0)
    para("受注から出荷まで、毎日の操作を一冊に。",M,91,CW,size=12,color=MUTED)
    para("生産工程管理",M,139,CW,size=32,bold=True,leading=46)
    para("操作マニュアル",M,188,CW,size=27,bold=True,leading=39)
    para("職人（作業員）・事務（編集者）",M,246,CW,size=15,bold=True)
    flow(306,["受注を登録","担当・工程を更新","研磨・仕上げ","出荷完了"],height=58)
    for top,title,sub,dest,col in [(395,"職人編","工程・研磨・配布担当・出荷",3,BLUE),
                                   (485,"事務編","受注・取込・ラベル・集計",12,ORANGE)]:
        box(M,top,CW,76,fill=PALE,stroke=col)
        para(title,M+15,top+10,180,size=17,bold=True,color=col)
        para(sub,M+15,top+40,CW-135,size=10.5)
        para(f"目次 {dest}ページ",W-M-128,top+26,113,size=11,bold=True,align=TA_RIGHT)
        c.linkRect("",f"p{dest}",(M,H-top-76,W-M,H-top),relative=0,thickness=0)
    para(f"A4縦 / 図解入り / {DATE}版",M,735,CW,size=10.5,bold=True,color=MUTED)
    footer(PAGES[0],1)

def toc_page(page,y):
    col=tone(page["role"])
    for dest,title in page["toc"]:
        box(M,y,CW,43,fill=WHITE,stroke=BORDER)
        para(title,M+13,y+11,CW-77,size=11,bold=True)
        para(f"{dest:02d}",W-M-53,y+8,38,size=14,bold=True,color=col,align=TA_RIGHT)
        c.linkRect("",f"p{dest}",(M,H-y-43,W-M,H-y),relative=0,thickness=0)
        y+=49
    y+=12
    for title,text in page.get("notes",[]): y=note(title,text,y,page["role"])
    if page["kind"]=="worker_toc":
        para("基本の流れ",M,y+9,CW,size=11.5,bold=True,color=col)
        flow(y+39,["案件を確認","担当・状態を選ぶ","工程を保存"],height=54)
    return y

def role_matrix(y):
    para("職人と事務の操作範囲",M,y,CW,size=11.5,bold=True)
    y+=24
    rows=[["工程・研磨・配布担当・出荷","できる","できる"],
          ["概況・受注登録・取込・ラベル","使えない","できる"],
          ["材料表示・研磨区分の訂正","閲覧のみ","できる"],
          ["利用者・共有の担当候補・単価","管理者へ依頼","管理者へ依頼"]]
    table(M,y,[279,115,CW-394],["操作","職人 / 作業員","事務 / 編集者"],rows,row_h=29,size=8.7,header_h=29)
    return y+29+len(rows)*29+12

def trouble(page,top):
    x=M; widths=[127,326,CW-453]
    total=30
    heights=[]
    for title,body,ref in page["issues"]:
        st=ParagraphStyle("chk",fontName="JP",fontSize=10,leading=15,wordWrap="CJK")
        p=Paragraph(escape(body),st);_,height=p.wrap(widths[1]-16,2000)
        heights.append(max(55,height+20))
    box(x,top,CW,total+sum(heights),radius=0)
    c.setFillColor(colors.HexColor("#E7EDF2"));c.rect(x,H-top-30,CW,30,fill=1,stroke=0)
    xx=x
    for w,t in zip(widths,["困ったこと","確認・操作","参照頁"]):
        para(t,xx+8,top+7,w-16,size=10,bold=True);xx+=w
    y=top+30
    for h,(title,body,ref) in zip(heights,page["issues"]):
        c.setStrokeColor(BORDER);c.setLineWidth(.5);c.line(x,H-y,x+CW,H-y)
        para(title,x+8,y+10,widths[0]-16,size=10,bold=True,max_height=h-16)
        para(body,x+widths[0]+8,y+10,widths[1]-16,size=10,leading=15,max_height=h-16)
        para(ref,x+widths[0]+widths[1]+4,y+11,widths[2]-8,size=9,align=TA_CENTER,max_height=h-16)
        y+=h
    return y+15

def daily_checks(page,y):
    para("利用開始前のチェック",M,y,CW,size=11.5,bold=True)
    y+=26
    for text in page["checks"]:
        box(M,y+3,10,10,radius=0)
        y+=para(text,M+24,y,CW-24,size=10.4)+11
    return y+9

def build_markdown():
    lines=["# 生産工程管理 操作マニュアル", "", f"{DATE}版。A4縦{len(PAGES)}ページ。", "",
           "対象：職人（権限：作業員）／事務（権限：編集者）。", "",
           "図は説明用の簡略図、入力例と数値は架空。PDFの図解は tools/build-user-manual.py で生成。", "",
           "利用者は、端末に設定されたアプリを開いて使います。", ""]
    for i,page in enumerate(PAGES,1):
        lines.extend([f"## {i:02d}ページ　{page['title']}", "", f"対象：{page['role']}", ""])
        if page.get("lead"): lines.extend([page["lead"],""])
        if page.get("toc"):
            lines.extend([f"- {dest}ページ：{title}" for dest,title in page["toc"]]);lines.append("")
        for j,(title,body) in enumerate(page.get("steps",[]),1):
            lines.extend([f"{j}. **{title}**：{body}",""])
        for title,text in page.get("notes",[]):lines.extend([f"**{title}**：{text}",""])
        for title,body,ref in page.get("issues",[]):lines.extend([f"- **{title}**：{body}（{ref}ページ）",""])
        for text in page.get("checks",[]):lines.extend([f"- [ ] {text}",""])
    lines.extend(["## 作成時の確認元", "",
                  "- src/index.html、src/app.js、src/access.html、src/access.js：画面名・操作・本人確認。",
                  "- apps-script/AccessControl.gs：作業員・編集者・管理者・所有者の権限。",
                  "- apps-script/Repository.gs、Config.gs、Polishing.gs、ProductMaster.gs：保存・出荷条件・研磨・製品表示。",
                  "- tests/account-roles-ui.test.mjs、worker-process.test.mjs、ledger-display.test.mjs、polishing-ui.test.mjs：関連仕様。",
                  "", "再生成：Codexの同梱Pythonで tools/build-user-manual.py を実行。日本語フォントはWindowsのMeiryoを使用。", ""])
    SOURCE.parent.mkdir(parents=True,exist_ok=True)
    SOURCE.write_text("\n".join(lines),encoding="utf-8")

def build_pdf():
    global c,page_number
    OUT.parent.mkdir(parents=True,exist_ok=True)
    c=canvas.Canvas(str(OUT),pagesize=A4,pageCompression=1)
    c.setTitle("生産工程管理 操作マニュアル - 職人（作業員）・事務（編集者）")
    c.setAuthor("生産工程管理")
    c.setSubject("A4縦・職人と事務の操作手順・図解・権限別目次")
    c.setViewerPreference("DisplayDocTitle","true")
    for n,page in enumerate(PAGES,1):
        page_number=n
        c.bookmarkPage(f"p{n}")
        level=1 if (4<=n<=11 or 13<=n<=19) else 0
        c.addOutlineEntry(f"{n:02d} {page['title']}",f"p{n}",level=level,closed=False)
        if n==1:
            cover();c.showPage();continue
        y=header(page,n)
        if page["kind"].endswith("toc"):
            toc_page(page,y)
        elif page["kind"]=="troubleshooting":
            y=trouble(page,y)
            for title,text in page.get("notes",[]):y=note(title,text,y,page["role"])
        else:
            y+=draw_diagram(page["kind"],y)+15
            if n==2:
                y=steps_block(page["steps"],y,page["role"])
                y=role_matrix(y)
            elif page["kind"]=="daily":
                y=daily_checks(page,y)
            else:
                y=steps_block(page.get("steps",[]),y,page["role"])
            for title,text in page.get("notes",[]):y=note(title,text,y,page["role"])
        footer(page,n);c.showPage()
    c.save()
    reader=PdfReader(OUT)
    assert len(reader.pages)==len(PAGES)
    for i,page in enumerate(reader.pages,1):
        assert abs(float(page.mediabox.width)-W)<.1 and abs(float(page.mediabox.height)-H)<.1
        txt=page.extract_text()
        assert f"{i} / {len(PAGES)}" in txt
        assert PAGES[i-1]["title"] in txt.replace("\n"," ") or i==1, (i,PAGES[i-1]["title"])
    QA.parent.mkdir(parents=True,exist_ok=True)
    QA.write_text(json.dumps(dict(pages=len(PAGES),page_size="A4 portrait",text_boxes=layout_checks),
                             ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(dict(pdf=str(OUT),pages=len(PAGES),bytes=OUT.stat().st_size,
                          source=str(SOURCE),layout_checks=len(layout_checks)),ensure_ascii=False))

if __name__=="__main__":
    build_pdf()
    build_markdown()
