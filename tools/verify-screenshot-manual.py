"""Check the rendered manual and publish the verified PDF and Markdown."""

import argparse
import hashlib
import json
from pathlib import Path
from runpy import run_path
from shutil import copy2

from PIL import Image
from pypdf import PdfReader
from reportlab.pdfbase.ttfonts import TTFont


BUILDER = run_path(str(Path(__file__).with_name('build-current-screenshot-manual.py')))
QA = BUILDER['QA']
OUT = BUILDER['OUT']
MARKDOWN = BUILDER['MARKDOWN']
PDF = QA / OUT.name
CONTENT = json.loads(BUILDER['CONTENT'].read_text(encoding='utf-8'))
MANIFEST = json.loads(
    (BUILDER['ASSETS'] / BUILDER['CAPTURE_KEY'] / 'manifest.json').read_text(encoding='utf-8')
)
LAYOUT = json.loads((QA / 'layout.json').read_text(encoding='utf-8'))
W, H = BUILDER['W'], BUILDER['H']


def without_spaces(text):
    return ''.join(text.split())


def outline_items(entries):
    for entry in entries:
        if isinstance(entry, list):
            yield from outline_items(entry)
        else:
            yield entry


def verify():
    reader = PdfReader(PDF)
    topics = CONTENT['pages']
    count = len(topics)
    assert len(reader.pages) == LAYOUT['pages'] == count
    assert MANIFEST['localDemoOnly'] and not MANIFEST['errors']
    release = BUILDER['RELEASE']
    expected_version = json.loads((release / 'version.json').read_text(encoding='utf-8'))['versionNumber']
    assert MANIFEST['version'] == LAYOUT['version'] == expected_version
    assert {topic['role'] for topic in topics} == {'作業者・編集者', '編集者'}
    assert not {'accounts', 'assignees', 'owner'} & {topic['id'] for topic in topics}
    assert '�' not in ''.join(p.extract_text() for p in reader.pages)
    version_dir = release / 'deployed-version/download'
    for file, key in [('Index.html', 'bundleSha256'), ('Access.html', 'accessSha256')]:
        assert hashlib.sha256((version_dir / file).read_bytes()).hexdigest() == MANIFEST[key], file

    page_ids = {topic['id']: page.indirect_reference.idnum for topic, page in zip(topics, reader.pages)}
    targets = [(entry.title, reader.get_destination_page_number(entry)) for entry in outline_items(reader.outline)]
    all_text = ''
    links = 0
    for index, (page, topic) in enumerate(zip(reader.pages, topics), 1):
        assert abs(float(page.mediabox.width) - W) < .1
        assert abs(float(page.mediabox.height) - H) < .1
        page_text = page.extract_text()
        assert f'{index} / {count}' in page_text and CONTENT['edition'] + '版' in page_text
        assert without_spaces(topic['title']) in without_spaces(page_text), topic['title']
        assert (topic['title'], index - 1) in targets, topic['title']
        if topic.get('images'):
            assert page.images, f'{topic["id"]} is missing its image'
            for key in topic['images']:
                role = MANIFEST['images'][key].get('role')
                if topic['role'] == '編集者':
                    assert role == 'editor', key
                elif key != 'editor-navigation' and key != 'login':
                    assert role == 'worker', key
        for font in page['/Resources']['/Font'].get_object().values():
            font = font.get_object()
            if font.get('/Subtype') == '/TrueType':
                assert '/FontFile2' in font['/FontDescriptor'].get_object()
                assert '/ToUnicode' in font

        expected = [link for link in LAYOUT['links'] if link['page'] == index]
        annotations = [annot.get_object() for annot in page.get('/Annots', [])]
        assert len(expected) == len(annotations), topic['id']
        for link, annot in zip(expected, annotations):
            assert annot['/Subtype'] == '/Link'
            assert all(abs(float(a) - b) < .1 for a, b in zip(annot['/Rect'], link['rect']))
            if link['target'] == 'app':
                assert annot['/A']['/URI'] == BUILDER['APP_URL']
            else:
                assert annot['/Dest'][0].idnum == page_ids[link['target']], link
        links += len(annotations)
        all_text += page_text + '\n'

    for word in (
        '発注を編集', '追加で入庫', '備考を保存', 'この製品の修正を次回にも使う',
        '月→連番順', '受注履行完了', '印刷完了・待ちから外す', '他端末の更新を確認',
    ):
        assert word in without_spaces(all_text), word
    for excluded in ('利用アカウントと権限を管理する', 'この月の単価を保存', 'メールを探す', '閲覧のみ', '所有者'):
        assert excluded not in without_spaces(all_text), excluded
    for filename in ('meiryo.ttc', 'meiryob.ttc'):
        font = TTFont(filename, f'C:/Windows/Fonts/{filename}', subfontIndex=0)
        missing = {c for c in all_text if ord(c) >= 32 and ord(c) not in font.face.charToGlyph}
        assert not missing, (filename, sorted(missing))
    for item in LAYOUT['screenshots'] + LAYOUT['text_boxes']:
        assert 0 <= item['x'] < item['x'] + item['width'] <= W, item
        assert 0 <= item['top'] < item['top'] + item['height'] <= BUILDER['BOTTOM'], item
    for figure in LAYOUT['screenshots']:
        assert figure['width'] >= 130, figure
        assert figure['source_width'] >= 1.8 * figure['width'], figure

    rendered = sorted(QA.glob('page-*.png'))
    assert len(rendered) == count, f'Render all pages first: {len(rendered)}'
    for image in rendered:
        assert image.stat().st_mtime_ns >= PDF.stat().st_mtime_ns, image
        with Image.open(image) as page:
            assert page.width >= 900 and abs(page.height / page.width - H / W) < .005, image
            page.verify()

    report = {
        'edition': CONTENT['edition'], 'version': MANIFEST['version'], 'pages': count,
        'screenshots': len(LAYOUT['screenshots']), 'callouts': sum(len(f['callouts']) for f in LAYOUT['screenshots']),
        'links': links, 'outline_entries': len(targets), 'rendered_pages': len(rendered),
        'pdf_bytes': PDF.stat().st_size, 'browser_errors': MANIFEST['errors'],
        'japanese_fonts_embedded': True, 'bundle_hashes_match': True,
    }
    (QA / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def publish():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.exists() and '2026年10月30日' in PdfReader(OUT).metadata.title:
        archive = OUT.parent / 'archive' / f'2026-10-30_{OUT.name}'
        archive.parent.mkdir(parents=True, exist_ok=True)
        if not archive.exists():
            copy2(OUT, archive)
    for source, target in ((PDF, OUT), (QA / MARKDOWN.name, MARKDOWN)):
        pending = target.with_suffix(target.suffix + '.new')
        copy2(source, pending)
        pending.replace(target)
        assert target.read_bytes() == source.read_bytes(), target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    print(json.dumps(verify(), ensure_ascii=False))
    if args.publish:
        publish()
