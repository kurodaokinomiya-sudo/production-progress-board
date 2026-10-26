"""Verify A4 layout, screen assets, Japanese fonts, and render contact sheets."""
from pathlib import Path
import json
from PIL import Image
from pypdf import PdfReader
from reportlab.pdfbase.ttfonts import TTFont

ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / 'output/pdf/生産工程管理_操作マニュアル_実画面版.pdf'
TMP = ROOT / 'tmp/pdfs'
reader = PdfReader(PDF)
texts = [page.extract_text() for page in reader.pages]
assert len(reader.pages) == 21
assert '職人編の目次' in texts[2] and '事務編の目次' in texts[11]
assert '実画面版' in texts[0]
assert '○件を案件へ反映' in texts[15]
assert '設定済みのアプリを開く' in texts[1]
assert '印刷完了・待ちから外す' in texts[16]
assert '研磨状態に戻す' in texts[7] and '発送数量を訂正' in texts[7]
assert 'B(メニスカス)' in texts[17] and '3,300' in texts[17]
assert '江部' in texts[18] and '嘉代' in texts[18] and '未確定' in texts[18]
assert '元の戻り月' in texts[18]
assert '戻りを間違えて反映した' in texts[19]
assert '8ページの「研磨状態に戻す」' in texts[9].replace('\n', '')
assert '取消・訂正は8ページ' in texts[11]
assert '8・10' in texts[19]
assert all('QR' not in t and '�' not in t for t in texts)
for i, page in enumerate(reader.pages, 1):
    assert abs(float(page.mediabox.width) - 595.2756) < .1
    assert abs(float(page.mediabox.height) - 841.8898) < .1
    assert f'{i} / 21' in texts[i-1]
    assert '2026年10月8日版' in texts[i-1]
    for f in page['/Resources']['/Font'].get_object().values():
        f = f.get_object()
        if f.get('/Subtype') == '/TrueType':
            desc = f['/FontDescriptor'].get_object()
            assert any(k in desc for k in ['/FontFile','/FontFile2','/FontFile3'])
for name in ['meiryo.ttc','meiryob.ttc']:
    font = TTFont('check-'+name, 'C:/Windows/Fonts/'+name, subfontIndex=0)
    missing = sorted({c for t in texts for c in t if ord(c) >= 32 and ord(c) not in font.face.charToGlyph})
    assert not missing, (name, missing)
links = [a.get_object() for page in reader.pages for a in page.get('/Annots', [])]
assert len(links) == 19
assert not any(a.get('/A', {}).get('/S') == '/URI' for a in links)
page_numbers = {page.indirect_reference.idnum: i for i, page in enumerate(reader.pages, 1)}
destinations = [page_numbers[link['/Dest'][0].idnum] for link in links]
assert destinations == [3, 12, *range(4, 12), *range(13, 22)], destinations
manifest = json.loads((ROOT/'docs/manual-screenshots/manifest.json').read_text(encoding='utf-8'))
assets = [item for group in manifest.values() for item in group]
for item in assets:
    with Image.open(ROOT/'docs/manual-screenshots'/item['file']) as im:
        assert im.width >= 1200 and im.height >= 700, (item['file'], im.size)
        x,y,w,h = (item['clip'][key] for key in ['x','y','width','height'])
        assert 0 <= x < im.width and 0 <= y < im.height and w > 0 and h > 0
        assert x+w <= im.width and y+h <= im.height
layout = json.loads((TMP/'screenshot-manual-layout.json').read_text(encoding='utf-8'))
expected_figures = sum(len(items) for kind, items in manifest.items() if kind != 'cover')
assert len(layout['screenshots']) == expected_figures
for block in layout['screenshots']:
    assert block['image']['top']+block['image']['height'] < 795
pages = sorted(TMP.glob('screenshot-manual-page-*.png'))
assert len(pages) == 21
tw, pad, gutter = 690, 22, 22
th = round(tw*297/210)
for i in range((len(pages)+3)//4):
    sheet = Image.new('RGB', (pad*2+tw*2+gutter, pad*2+th*2+gutter), '#d5dce3')
    for j,p in enumerate(pages[i*4:i*4+4]):
        im = Image.open(p).convert('RGB')
        im.thumbnail((tw,th),Image.Resampling.LANCZOS)
        sheet.paste(im,(pad+(j%2)*(tw+gutter),pad+(j//2)*(th+gutter)))
    sheet.save(TMP/f'screenshot-manual-contact-{i+1}.png')
report = dict(pages=21,paper='A4 portrait',japanese_fonts_embedded=True,missing_glyphs=[],
              internal_toc_links=19,external_links=0,screen_captures=len({item['file'] for item in assets}),
              page_figures=len(layout['screenshots']),rendered_pages=len(pages),pdf_bytes=PDF.stat().st_size)
(TMP/'screenshot-manual-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
