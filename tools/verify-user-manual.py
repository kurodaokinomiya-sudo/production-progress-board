"""Inspect PDF structure and build contact sheets for visual review."""
from pathlib import Path
import json
from PIL import Image
from pypdf import PdfReader
from reportlab.pdfbase.ttfonts import TTFont

ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / "output/pdf/生産工程管理_操作マニュアル.pdf"
TMP = ROOT / "tmp/pdfs"
reader = PdfReader(PDF)
assert len(reader.pages) == 21
font = TTFont("test_regular", "C:/Windows/Fonts/meiryo.ttc", subfontIndex=0)
bold = TTFont("test_bold", "C:/Windows/Fonts/meiryob.ttc", subfontIndex=0)
texts = [page.extract_text() for page in reader.pages]
for i, page in enumerate(reader.pages, 1):
    assert abs(float(page.mediabox.width) - 595.2756) < .1
    assert abs(float(page.mediabox.height) - 841.8898) < .1
    assert f"{i} / 21" in texts[i-1]
    assert "2026年10月8日版" in texts[i-1]
    assert "�" not in texts[i-1]
    for f in page["/Resources"]["/Font"].get_object().values():
        f = f.get_object()
        if f.get("/Subtype") == "/TrueType":
            desc = f["/FontDescriptor"].get_object()
            assert any(key in desc for key in ["/FontFile", "/FontFile2", "/FontFile3"])
assert "職人編の目次" in texts[2]
assert "事務編の目次" in texts[11]
assert all("QR" not in text for text in texts)
assert "設定済みのアプリを開く" in texts[1]
assert "8桁" in texts[1] and "60秒" in texts[1] and "10分" in texts[1]
assert "直前の一括変更を戻す" in texts[5]
assert "確認画面を挟まず" in texts[6]
assert "研磨状態に戻す" in texts[7] and "発送数量を訂正" in texts[7]
assert "100%" in texts[8] and "画面下の担当別合計" in texts[8]
assert "100件" in texts[15]
assert "印刷完了・待ちから外す" in texts[16]
assert "同じ製品" in texts[17] and "B(メニスカス)" in texts[17]
assert "江部" in texts[18] and "嘉代" in texts[18] and "元の戻り月" in texts[18]
assert "戻りを間違えて反映した" in texts[19]
assert '8ページの「研磨状態に戻す」' in texts[9].replace('\n', '')
assert '取消・訂正は8ページ' in texts[11]
assert '8・10' in texts[19]
missing = sorted({ch for text in texts for ch in text if ord(ch) >= 32 and ord(ch) not in font.face.charToGlyph})
missing_bold = sorted({ch for text in texts for ch in text if ord(ch) >= 32 and ord(ch) not in bold.face.charToGlyph})
assert not missing, missing
assert not missing_bold, missing_bold
links = [a.get_object() for page in reader.pages for a in page.get("/Annots", [])]
assert len(links) == 19
assert sum(a.get("/Subtype") == "/Link" for a in links) == 19
external = [a["/A"]["/URI"] for a in links if a.get("/A", {}).get("/S") == "/URI"]
assert not external
page_numbers = {page.indirect_reference.idnum: i for i, page in enumerate(reader.pages, 1)}
destinations = [page_numbers[link["/Dest"][0].idnum] for link in links]
assert destinations == [3, 12, *range(4, 12), *range(13, 22)], destinations
pages = sorted(TMP.glob("manual-page-*.png"))
assert len(pages) == 21
thumb_w, padding, gutter = 690, 22, 22
thumb_h = round(thumb_w * 297 / 210)
for j in range((len(pages)+3)//4):
    group = pages[j*4:j*4+4]
    sheet = Image.new("RGB", (padding*2+thumb_w*2+gutter, padding*2+thumb_h*2+gutter), (213,220,227))
    for k, path in enumerate(group):
        img = Image.open(path).convert("RGB")
        img.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
        sheet.paste(img, (padding+(k%2)*(thumb_w+gutter), padding+(k//2)*(thumb_h+gutter)))
    sheet.save(TMP / f"manual-contact-{j+1}.png")
report = dict(pages=21, size="A4 portrait", embedded_japanese_fonts=True,
              missing_glyphs=missing, links=len(links), cover_app_links=len(external),
              text_lengths=[len(t) for t in texts], rendered_pages=len(pages), contact_sheets=(len(pages)+3)//4)
(TMP / "manual-verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
