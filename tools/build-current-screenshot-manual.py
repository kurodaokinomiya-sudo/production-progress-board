"""Generate the Japanese A4 quick-reference manual and its Markdown edition."""

from html import escape
from io import BytesIO
import json
from pathlib import Path
import re

from PIL import Image
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


ROOT = Path(__file__).resolve().parents[1]
EDITION_KEY = '2026-11-20'
CONTENT = ROOT / f'docs/manual-content-{EDITION_KEY}.json'
ASSETS = ROOT / 'docs/manual-screenshots'
RELEASE = ROOT / 'output/release-2026-11-20-stock-width'
CAPTURE_KEY = f'{EDITION_KEY}-v121'
OUT = ROOT / 'output/pdf/生産工程管理_操作マニュアル_実画面版.pdf'
MARKDOWN = ROOT / 'docs/操作マニュアル_実画面版.md'
QA = ROOT / 'tmp/pdfs' / f'manual-{CAPTURE_KEY}'
APP_URL = (
    'https://script.google.com/macros/s/'
    'AKfycbwVlF96mdaxEptRwXWeh2oAZ0-s0INe6jMHaB1BWhImXd8x_hbn7hSKcpMY7v2ERzJmpA/exec'
)

W, H = A4
M = 43
CW = W - 2 * M
BOTTOM = H - 50
INK = colors.HexColor('#182C37')
ACCENT = colors.HexColor('#075C62')
MUTED = colors.HexColor('#465D66')
PALE = colors.HexColor('#EDF6F5')
BORDER = colors.HexColor('#C8D8DB')
NOTE = colors.HexColor('#FAF5EA')
NOTE_INK = colors.HexColor('#6A491F')
UI_LABEL = re.compile(r'(「[^」\n]+」)')

# Each chapter begins at the matching page ID. Later topics stay in the
# chapter up to the next boundary, so adding a topic updates the navigation.
CHAPTERS = [
    ('はじめに', 'login'),
    ('工程と配布', 'ledger'),
    ('注文とラベル', 'dashboard'),
    ('研磨と出荷', 'polishing'),
    ('碓井材料在庫', 'materials'),
    ('Tezoe製品在庫', 'stock-overview'),
    ('困ったとき', 'help'),
]
COVER_GROUPS = [
    ('作業者・編集者の共通手順', [
        ('アプリを開く', 'ログインと初回の本人確認', 'login'),
        ('工程を更新する', '担当と状態の入力、保存', 'process'),
        ('配布表を使う', '担当の割り振りと印刷', 'distribution'),
    ]),
    ('編集者の手順', [
        ('注文を取り込む', '注文書とメールの読取', 'import'),
        ('出荷完了を記録する', '出荷待ちから完了・再開を記録', 'completed'),
        ('Tezoe製品在庫', '受注、入出庫、製品の備考', 'stock-overview'),
    ]),
]

# Crop only the figure as placed in this document. Keep the JPEG originals.
# The bounds are fractions of the original extent.
CROPS = {
    'ledger': (0, 0, 1, .48),
    'worker-navigation': (0, 0, .49, 1),
    'zoom': (0, 0, 1, .72),
    'bulk-held': (0, .20, 1, .55),
    'distribution': (0, .055, 1, .81),
    'completed': (0, 0, 1, .89),
    'dashboard': (0, 0, 1, .59),
    'intake-review': (0, 0, 1, .637),
    'polishing': (0, .05, 1, .73),
    'polishing-custom': (.03, 0, .475, 1),
    'stock-overview': (0, 0, 1, .546),
}


def register_fonts():
    for name, file in [('JP', 'meiryo.ttc'), ('JPB', 'meiryob.ttc')]:
        pdfmetrics.registerFont(TTFont(name, str(Path('C:/Windows/Fonts') / file), subfontIndex=0))
    pdfmetrics.registerFontFamily('JP', normal='JP', bold='JPB')


def make_paragraph(text, size=11.2, bold=False, color=INK, leading=None, controls=False):
    copy = escape(text)
    if controls:
        copy = UI_LABEL.sub(r'<b>\1</b>', copy)
    style = ParagraphStyle(
        'manual', fontName='JPB' if bold else 'JP', fontSize=size,
        leading=leading or size * 1.52, textColor=color, wordWrap='CJK',
    )
    return Paragraph(copy, style)


def paragraph_height(text, width, **style):
    return make_paragraph(text, **style).wrap(width, H)[1]


class Manual:
    def __init__(self, content, manifest, output):
        self.data = content
        self.pages = content['pages']
        self.captures = manifest['images']
        self.version = manifest['version']
        self.capture_scale = manifest['viewport']['deviceScaleFactor']
        self.number = {topic['id']: n for n, topic in enumerate(self.pages, start=1)}
        self.topic = {topic['id']: topic for topic in self.pages}
        assert len(self.number) == len(self.pages), 'Duplicate page ID'
        starts = [self.number[key] - 1 for _, key in CHAPTERS] + [len(self.pages)]
        assert starts[0] == 2 and starts == sorted(set(starts)), 'Invalid chapter order'
        self.chapters = [(title, self.pages[a:b]) for (title, _), a, b in zip(CHAPTERS, starts, starts[1:])]
        self.figure_layout = []
        self.text_layout = []
        self.link_layout = []
        self.page_n = 0
        self.pdf = canvas.Canvas(str(output), pagesize=A4, pageCompression=1)
        self.pdf.setTitle(f"{content['title']} {content['subtitle']} {content['edition']}")
        self.pdf.setAuthor('HAKOBI')
        self.pdf.setSubject(f'生産工程管理 v{self.version} 対応')

    def text(self, copy, x, y, width, **style):
        para = make_paragraph(copy, **style)
        _, height = para.wrap(width, H)
        para.drawOn(self.pdf, x, H - y - height)
        self.text_layout.append({'page': self.page_n, 'text': copy, 'x': x, 'top': y,
                                 'width': width, 'height': height})
        return height

    def box(self, x, y, width, height, color, border=None, radius=5):
        self.pdf.setFillColor(color)
        if border:
            self.pdf.setStrokeColor(border)
            self.pdf.setLineWidth(.6)
        self.pdf.roundRect(x, H - y - height, width, height, radius, fill=1, stroke=bool(border))

    def link(self, key, x, y, width, height):
        bounds = (x, H - y - height, x + width, H - y)
        if key == 'app':
            self.pdf.linkURL(APP_URL, bounds, relative=0, thickness=0)
        else:
            self.pdf.linkRect('', key, bounds, relative=0, thickness=0)
        self.link_layout.append({'page': self.page_n, 'target': key, 'rect': bounds})

    def footer(self):
        self.pdf.setStrokeColor(BORDER)
        self.pdf.setLineWidth(.6)
        self.pdf.line(M, 42, W - M, 42)
        self.pdf.setFont('JP', 8.5)
        self.pdf.setFillColor(MUTED)
        self.pdf.drawString(M, 24, f"{self.data['edition']}版  v{self.version}対応")
        self.pdf.drawRightString(W - M, 24, f'{self.page_n} / {len(self.pages)}')
        if self.page_n != 2:
            self.pdf.setFillColor(ACCENT)
            self.pdf.drawCentredString(W / 2, 24, '目次へ戻る')
            self.link('contents', W / 2 - 35, H - 39, 70, 24)

    def label(self, text, x, y, width):
        return self.text(text, x, y, width, size=9.5, bold=True, color=ACCENT, leading=14)

    def chapter_heading(self, topic, chapter):
        self.label(chapter, M, 29, 160)
        self.text(topic['role'], M + 160, 29, CW - 160, size=9.2, color=MUTED, leading=14)
        y = 51
        y += self.text(topic['title'], M, y, CW, size=22, bold=True, leading=31) + 7
        if topic.get('lead'):
            y += self.text(topic['lead'], M, y, CW, leading=17.3) + 12
        if topic.get('path'):
            path = topic['path']
            height = paragraph_height(path, CW - 22, size=10.4, bold=True, leading=16) + 13
            self.box(M, y, CW, height, PALE)
            self.text(path, M + 11, y + 6, CW - 22, size=10.4, bold=True, color=ACCENT, leading=16)
            y += height + 12
        return y

    def capture(self, key):
        entry = self.captures[key]
        file = (ASSETS / entry['file']).resolve()
        assert ASSETS.resolve() in file.parents and file.is_file(), file
        with Image.open(file) as original:
            width, height = original.size
            fractions = CROPS.get(key, (0, 0, 1, 1))
            crop = tuple(round(a * b) for a, b in zip(fractions, (width, height, width, height)))
            left, top, right, bottom = crop
            image = str(file)
            if crop != (0, 0, width, height):
                jpeg = BytesIO()
                original.crop(crop).save(jpeg, format='JPEG', quality=95, subsampling=0, optimize=True)
                jpeg.seek(0)
                image = ImageReader(jpeg)
        return entry, file, image, crop, right - left, bottom - top

    def callouts(self, focus, crop, x, y, width, height, max_step):
        left, top, _, _ = crop
        scale = width / (crop[2] - left)
        shown = []
        for mark in focus:
            n = mark['step']
            a, b, c, d = mark['box']
            if n > max_step or not (left <= a < c <= crop[2] and top <= b < d <= crop[3]):
                continue
            lx = x + (a - left) * scale
            ly = y + (b - top) * scale
            bw = (c - a) * scale
            bh = (d - b) * scale
            self.pdf.setStrokeColor(ACCENT)
            self.pdf.setLineWidth(1.35)
            self.pdf.roundRect(lx, H - ly - bh, bw, bh, 2, fill=0, stroke=1)
            radius = 7.2
            cx = min(x + width - radius - 2, max(x + radius + 2, lx - 1))
            cy = min(y + height - radius - 2, max(y + radius + 2, ly - 1))
            self.pdf.setFillColor(ACCENT)
            self.pdf.setStrokeColor(colors.white)
            self.pdf.setLineWidth(1)
            self.pdf.circle(cx, H - cy, radius, fill=1, stroke=1)
            self.pdf.setFont('JPB', 8)
            self.pdf.setFillColor(colors.white)
            self.pdf.drawCentredString(cx, H - cy - 2.9, str(n))
            shown.append(n)
        return shown

    def figures(self, topic, y, limit):
        keys = topic.get('images', [])
        if not keys:
            return y
        items = [self.capture(key) for key in keys]
        beside = topic['id'] == 'material-receive' and len(items) == 2
        gap = 14
        column_width = (CW - gap) / 2 if beside else CW
        captions = [paragraph_height(item[0]['caption'], column_width, size=9, leading=13) for item in items]
        natural_widths = [min(column_width, item[4] / self.capture_scale) for item in items]
        natural_heights = [
            width * img_height / img_width
            for width, (_, _, _, _, img_width, img_height) in zip(natural_widths, items)
        ]
        if beside:
            scale = min(1, min((limit - cap - 13) / height for cap, height in zip(captions, natural_heights)))
        else:
            available = limit - sum(captions) - 13 * len(keys)
            scale = min(1, available / sum(natural_heights))
        if scale <= 0:
            raise ValueError(f"{topic['id']} has no space for its figures")
        edge = y
        for index, (key, item, width, height, cap_h) in enumerate(
            zip(keys, items, natural_widths, natural_heights, captions)
        ):
            entry, file, image, crop, pixels_w, pixels_h = item
            width, height = width * scale, height * scale
            col_x = M + index * (column_width + gap) if beside else M
            x = col_x + (column_width - width) / 2
            top = y if beside else edge
            self.pdf.drawImage(image, x, H - top - height, width=width, height=height)
            self.pdf.setStrokeColor(BORDER)
            self.pdf.setLineWidth(.65)
            self.pdf.rect(x, H - top - height, width, height, fill=0, stroke=1)
            marks = self.callouts(entry.get('focus', []), crop, x, top, width, height, len(topic.get('steps', [])))
            self.figure_layout.append({'page': self.page_n, 'key': key, 'file': str(file), 'crop': crop,
                                       'x': x, 'top': top, 'width': width, 'height': height,
                                       'source_width': pixels_w, 'source_height': pixels_h, 'callouts': marks})
            caption_y = top + height + 4
            self.text(entry['caption'], col_x, caption_y, column_width, size=9, color=MUTED, leading=13)
            edge = max(edge, caption_y + cap_h + 9)
        return edge

    def cover(self, topic):
        self.pdf.setFillColor(ACCENT)
        self.pdf.rect(M, H - 58, 34, 3, fill=1, stroke=0)
        self.label(self.data['subtitle'], M, 69, CW)
        self.text(self.data['title'], M, 91, CW, size=30, bold=True, leading=43)
        self.text(f"{self.data['edition']}改訂  ／  v{self.version}対応", M, 142, CW, size=11, color=MUTED)
        self.text(topic['lead'], M, 175, CW, size=11.6, leading=18)
        y = self.figures(topic, 226, 235) + 14
        gap = 12
        width = (CW - gap) / 2
        height = 55
        for column, (audience, links) in enumerate(COVER_GROUPS):
            x = M + column * (width + gap)
            self.text(audience, x, y, width, size=11.2, bold=True, color=ACCENT)
            for index, (title, summary, key) in enumerate(links):
                top = y + 22 + index * (height + gap)
                self.box(x, top, width, height, PALE, BORDER)
                self.text(title, x + 12, top + 9, width - 68, size=13, bold=True, color=ACCENT)
                self.text(summary, x + 12, top + 32, width - 24, size=9.6, color=MUTED)
                self.text(f'{self.number[key]}ページ', x + width - 54, top + 12, 50, size=9.1, color=ACCENT)
                self.link(key, x, top, width, height)
        y += 23 + max(len(links) for _, links in COVER_GROUPS) * (height + gap)
        button = '目次から探す'
        self.text(button, M, y, CW, size=11.3, bold=True, color=ACCENT)
        self.link('contents', M, y - 2, 90, 22)
        self.text('画面例は説明用の案件、数量、アカウントで撮影しています。', M, y + 30, CW,
                  size=9.3, color=MUTED)

    def contents(self, topic):
        self.text(topic['title'], M, 46, CW, size=27, bold=True, leading=36)
        self.text(topic['lead'], M, 91, CW, color=MUTED)
        columns = [self.chapters[:3], self.chapters[3:]]
        gap = 26
        width = (CW - gap) / 2
        for index, chapters in enumerate(columns):
            x = M + index * (width + gap)
            y = 124
            for title, topics in chapters:
                self.box(x, y, width, 23, PALE, radius=4)
                self.text(title, x + 8, y + 3, width - 64, size=11.4, bold=True, color=ACCENT)
                audience = '編集者' if topics[0]['role'] == '編集者' else '共通'
                self.text(audience, x + width - 40, y + 5, 36, size=9, color=MUTED)
                y += 27
                for entry in topics:
                    key = entry['id']
                    height = self.text(entry['title'], x + 2, y, width - 30, size=10.2, leading=15)
                    self.pdf.setFont('JPB', 9.7)
                    self.pdf.setFillColor(ACCENT)
                    self.pdf.drawRightString(x + width - 2, H - y - 11, str(self.number[key]))
                    self.link(key, x, y - 1, width, height + 3)
                    y += height + 4
                y += 8
            if y > BOTTOM:
                raise ValueError('Table of contents overflow')

    def step_height(self, topic):
        width = CW - 32
        return sum(
            paragraph_height(title, width, size=12, bold=True, leading=17.3) +
            paragraph_height(body, width, leading=17.3, controls=True) + 10
            for title, body in topic.get('steps', [])
        )

    def steps(self, topic, y):
        for n, (title, body) in enumerate(topic.get('steps', []), 1):
            self.box(M, y + 1, 19, 19, ACCENT, radius=4)
            self.pdf.setFont('JPB', 10.2)
            self.pdf.setFillColor(colors.white)
            self.pdf.drawCentredString(M + 9.5, H - y - 14.3, str(n))
            x, width = M + 32, CW - 32
            y += self.text(title, x, y, width, size=12, bold=True, leading=17.3) + 2
            y += self.text(body, x, y, width, leading=17.3, controls=True) + 8
        return y

    def rows(self, pairs, y, label_width):
        for label, body in pairs:
            width = CW - label_width - 20
            height = max(
                paragraph_height(label, label_width - 20, size=10.6, bold=True, leading=16.5),
                paragraph_height(body, width, size=10.7, leading=16.5, controls=True),
            ) + 18
            self.box(M, y, label_width, height - 1, PALE, radius=2)
            self.pdf.setStrokeColor(BORDER)
            self.pdf.setLineWidth(.45)
            self.pdf.line(M + label_width, H - y - height, W - M, H - y - height)
            self.text(label, M + 9, y + 8, label_width - 20, size=10.6, bold=True, color=ACCENT, leading=16.5)
            self.text(body, M + label_width + 10, y + 8, width, size=10.7, leading=16.5, controls=True)
            y += height
        return y + 13

    def note_height(self, topic):
        if 'note' not in topic:
            return 0
        title, body = topic['note']
        return (paragraph_height(title, CW - 24, size=10.6, bold=True, leading=16) +
                paragraph_height(body, CW - 24, size=10.6, leading=16, controls=True) + 21)

    def note(self, topic, y):
        height = self.note_height(topic)
        if not height:
            return y
        title, body = topic['note']
        self.box(M, y, CW, height, NOTE)
        ty = y + 8 + self.text(title, M + 12, y + 8, CW - 24, size=10.6, bold=True, color=NOTE_INK, leading=16)
        self.text(body, M + 12, ty + 3, CW - 24, size=10.6, leading=16, controls=True)
        return y + height + 10

    def related_title(self, topic, key):
        target = self.topic[key]
        if topic['role'] != target['role'] and target['role'] == '編集者':
            return target['title'] + '（編集者）'
        return target['title']

    def related(self, topic, y):
        keys = topic.get('related', [])
        if not keys:
            return y
        gap = 12
        width = (CW - gap * (len(keys) - 1)) / len(keys)
        for index, key in enumerate(keys):
            x = M + index * (width + gap)
            title = self.related_title(topic, key)
            label = f'{title}　{self.number[key]}ページ'
            height = self.text(label, x, y, width, size=9.6, bold=True, color=ACCENT, leading=14.5)
            self.link(key, x, y - 1, width, height + 2)
        return y + 30

    def detail(self, topic, chapter):
        y = self.chapter_heading(topic, chapter)
        layout = topic.get('layout')
        if layout in ('roles', 'help'):
            if layout == 'roles':
                y = self.figures(topic, y, 150) + 9
            y = self.rows(topic['rows'], y, 93 if layout == 'roles' else 128)
        else:
            reserved = self.step_height(topic) + self.note_height(topic) + 12
            reserved += 43 if topic.get('related') else 0
            reserved += 28 if topic['id'] == 'login' else 0
            y = self.figures(topic, y, min(380, BOTTOM - y - reserved)) + 5
            y = self.steps(topic, y)
        y = self.note(topic, y)
        if topic['id'] == 'login':
            self.text('HAKOBIを開く', M, y, CW, size=11, bold=True, color=ACCENT)
            self.link('app', M, y - 2, 103, 21)
            y += 26
        y = self.related(topic, y + 3)
        if y > BOTTOM:
            raise ValueError(f"{topic['id']} exceeds the page at {y:.1f} pt")

    def draw(self):
        chapter_title = {}
        first_topics = {}
        for title, topics in self.chapters:
            first_topics[topics[0]['id']] = title
            chapter_title.update({topic['id']: title for topic in topics})
        for self.page_n, topic in enumerate(self.pages, 1):
            key = topic['id']
            self.pdf.bookmarkPage(key)
            if self.page_n < 3:
                self.pdf.addOutlineEntry(topic['title'], key)
            else:
                if key in first_topics:
                    self.pdf.addOutlineEntry(first_topics[key], key, level=0)
                self.pdf.addOutlineEntry(topic['title'], key, level=1)
            if key == 'cover':
                self.cover(topic)
            elif key == 'contents':
                self.contents(topic)
            else:
                self.detail(topic, chapter_title[key])
            self.footer()
            self.pdf.showPage()
        self.pdf.save()

    def write_markdown(self, path):
        lines = [
            f"# {self.data['title']}", '',
            f"{self.data['subtitle']}。{self.data['edition']}改訂。v{self.version}対応。", '',
            '画面例は説明用データを使っています。', '',
            '## 目次', '',
        ]
        for chapter, topics in self.chapters:
            audience = '編集者' if topics[0]['role'] == '編集者' else '共通'
            lines.extend([f'### {chapter}（{audience}）', ''])
            lines.extend(f"- [{topic['title']}](#{topic['id']})" for topic in topics)
            lines.append('')
        for topic in self.pages[2:]:
            key = topic['id']
            lines.extend([f'<a id="{key}"></a>', '', f"## {topic['title']}", '', topic['role'], ''])
            if topic.get('lead'):
                lines.extend([topic['lead'], ''])
            if topic.get('path'):
                lines.extend([f"**{topic['path']}**", ''])
            for key in topic.get('images', []):
                entry = self.captures[key]
                lines.extend([f"![{entry['caption']}](manual-screenshots/{entry['file']})", ''])
            for n, (title, body) in enumerate(topic.get('steps', []), 1):
                lines.extend([f'{n}. **{title}**', f'   {body}', ''])
            for title, body in topic.get('rows', []):
                lines.extend([f'- **{title}**  {body}', ''])
            if 'note' in topic:
                title, body = topic['note']
                lines.extend([f'**{title}**', '', body, ''])
            if topic['id'] == 'login':
                lines.extend([f'[HAKOBIを開く]({APP_URL})', ''])
            links = [f"[{self.related_title(topic, key)}](#{key})" for key in topic.get('related', [])]
            if links:
                lines.extend(['　'.join(links), ''])
        path.write_text('\n'.join(lines), encoding='utf-8')


def build():
    data = json.loads(CONTENT.read_text(encoding='utf-8'))
    manifest = json.loads((ASSETS / CAPTURE_KEY / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['localDemoOnly'] and not manifest['errors'], 'Clean local capture required'
    register_fonts()
    QA.mkdir(parents=True, exist_ok=True)
    output = QA / OUT.name
    manual = Manual(data, manifest, output)
    manual.draw()
    manual.write_markdown(QA / MARKDOWN.name)
    layout = {
        'pages': len(manual.pages), 'edition': data['edition'], 'version': manual.version,
        'screenshots': manual.figure_layout, 'text_boxes': manual.text_layout, 'links': manual.link_layout,
    }
    (QA / 'layout.json').write_text(json.dumps(layout, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'pdf': str(output), 'pages': len(manual.pages),
                      'figures': len(manual.figure_layout), 'bytes': output.stat().st_size}, ensure_ascii=False))


if __name__ == '__main__':
    build()
