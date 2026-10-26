"""Build the real-screen version of the illustrated A4 user manual.

Reuses the page copy and table-of-contents data in build-user-manual.py while
replacing its explanatory diagrams with actual application screenshots. Requires
Pillow, reportlab and pypdf from the bundled Python runtime.
"""
from pathlib import Path
import importlib.util
import json
import sys
from html import escape

from PIL import Image
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
BASE_SCRIPT = ROOT / "tools" / "build-user-manual.py"
spec = importlib.util.spec_from_file_location("user_manual_builder", BASE_SCRIPT)
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)

OUT = ROOT / "output" / "pdf" / "生産工程管理_操作マニュアル_実画面版.pdf"
SOURCE = ROOT / "docs" / "操作マニュアル_実画面版.md"
MANIFEST = ROOT / "docs" / "manual-screenshots" / "manifest.json"
IMAGE_DIR = MANIFEST.parent
QA = ROOT / "tmp" / "pdfs" / "screenshot-manual-layout.json"
DATE = "2026年10月8日"
W, H = A4
M = base.M
CW = base.CW
INK = base.INK
MUTED = base.MUTED
BORDER = base.BORDER
BLUE = base.BLUE
ORANGE = base.ORANGE
PALE = base.PALE
WHITE = base.WHITE

PDF = None
PAGE_NO = 0
LAYOUT = []
SCREENSHOTS = {}
CAPTION = "実際のアプリ画面を説明用データで撮影。画面配置は端末幅や設定で変わります。2026年10月8日、研磨の画面・説明を最新の実装に合わせて更新しました。"
SCREENSHOT_KINDS = {
    page["kind"] for page in base.PAGES
    if page["kind"] not in {"cover", "worker_toc", "editor_toc", "troubleshooting", "daily"}
}
OPTIONAL_KINDS = {"cover"}


def read_manifest():
    if not MANIFEST.exists():
        raise FileNotFoundError(
            f"Screenshot manifest is missing: {MANIFEST}. "
            "Add docs/manual-screenshots/manifest.json and its JPEG files first."
        )
    raw = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Screenshot manifest root must be an object keyed by kind.")
    missing = sorted(SCREENSHOT_KINDS - raw.keys())
    if missing:
        raise ValueError("Missing screenshot kinds: " + ", ".join(missing))
    result = {}
    for kind in SCREENSHOT_KINDS | (OPTIONAL_KINDS & raw.keys()):
        entries = raw[kind]
        if not isinstance(entries, list) or not entries:
            raise ValueError(f"Manifest kind {kind!r} must contain a non-empty list.")
        result[kind] = []
        for index, entry in enumerate(entries, 1):
            if not isinstance(entry, dict) or not isinstance(entry.get("file"), str):
                raise ValueError(f"Manifest entry {kind}[{index - 1}] needs a file name.")
            image_path = (IMAGE_DIR / entry["file"]).resolve()
            if IMAGE_DIR.resolve() not in image_path.parents:
                raise ValueError(f"Screenshot path escapes {IMAGE_DIR}: {entry['file']}")
            if image_path.suffix.lower() not in {".jpg", ".jpeg"}:
                raise ValueError(f"Screenshot must be JPEG: {entry['file']}")
            if not image_path.is_file():
                raise FileNotFoundError(f"Screenshot is missing: {image_path}")
            with Image.open(image_path) as image:
                source_width, source_height = image.size
                image.verify()
            if source_width < 1 or source_height < 1:
                raise ValueError(f"Invalid screenshot dimensions: {image_path}")
            raw_clip = entry.get("clip")
            if raw_clip is None:
                clip = {"x": 0, "y": 0, "width": source_width, "height": source_height}
            else:
                if not isinstance(raw_clip, dict):
                    raise ValueError(f"{kind}[{index - 1}].clip must be an object.")
                clip_values = [raw_clip.get(key) for key in ("x", "y", "width", "height")]
                if any(not isinstance(value, int) or isinstance(value, bool) for value in clip_values):
                    raise ValueError(f"{kind}[{index - 1}].clip needs integer x, y, width and height.")
                clip = dict(zip(("x", "y", "width", "height"), clip_values))
                if (clip["x"] < 0 or clip["y"] < 0 or clip["width"] <= 0 or clip["height"] <= 0
                        or clip["x"] + clip["width"] > source_width
                        or clip["y"] + clip["height"] > source_height):
                    raise ValueError(
                        f"Clip is outside {entry['file']} ({source_width}x{source_height}): {clip}."
                    )
            width, height = clip["width"], clip["height"]
            caption = str(entry.get("caption", "")).strip()
            callouts = entry.get("callouts", [])
            if not isinstance(callouts, list):
                raise ValueError(f"{kind}[{index - 1}].callouts must be a list.")
            clean_callouts = []
            for callout in callouts:
                if not isinstance(callout, dict):
                    raise ValueError(f"Invalid callout in {kind}[{index - 1}].")
                number = callout.get("number")
                x, y = callout.get("x"), callout.get("y")
                if not isinstance(number, int) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                    raise ValueError(f"Callout needs numeric number, x and y in {kind}[{index - 1}].")
                if not (0 <= x <= width and 0 <= y <= height):
                    raise ValueError(f"Callout coordinate is outside {entry['file']}: ({x}, {y}).")
                clean_callouts.append({"number": number, "x": float(x), "y": float(y)})
            result[kind].append({
                "path": image_path, "width": width, "height": height,
                "source_width": source_width, "source_height": source_height,
                "clip": clip,
                "caption": caption, "callouts": clean_callouts,
            })
    return result


def text_height(text, width, size=10.5, bold=False, leading=None):
    style = ParagraphStyle(
        "measure", fontName="JPB" if bold else "JP", fontSize=size,
        leading=leading or size * 1.53, wordWrap="CJK", spaceBefore=0, spaceAfter=0,
    )
    p = Paragraph(escape(str(text)), style)
    return p.wrap(width, 4000)[1]


def steps_height(items):
    y = 0
    for title, body in items:
        y += text_height(title, CW - 30, 11.3) + 3
        y += text_height(body, CW - 30, 10.5) + 13
    return y


def notes_height(items):
    total = 0
    for title, body in items:
        total += text_height(title, CW - 26, 10, True, 15)
        total += text_height(body, CW - 26, 10, False, 15.3) + 24 + 12
    return total


def page_steps(page):
    steps = list(page.get("steps", []))
    if page["kind"] == "intake":
        steps = [
            (title, body.replace("「選択した注文を反映」は1回100件までです。",
                                 "「○件を案件へ反映」は1回100件までです。"))
            for title, body in steps
        ]
    return steps


def draw_callout(image, callout, x, top, draw_width, draw_height):
    px = x + callout["x"] / image["width"] * draw_width
    py = top + callout["y"] / image["height"] * draw_height
    radius = 8.2
    # Place the numbered badge near its target, shifting inward near image edges.
    dx = 17 if px < x + draw_width - 24 else -17
    dy = -17 if py > top + 22 else 17
    bx = min(max(px + dx, x + radius + 1), x + draw_width - radius - 1)
    by = min(max(py + dy, top + radius + 1), top + draw_height - radius - 1)
    vx, vy = px - bx, py - by
    length = max((vx * vx + vy * vy) ** .5, 1)
    sx, sy = bx + vx / length * radius, by + vy / length * radius
    PDF.setStrokeColor(ORANGE)
    PDF.setLineWidth(1.5)
    PDF.line(sx, H - sy, px, H - py)
    PDF.setFillColor(ORANGE)
    PDF.circle(bx, H - by, radius, fill=1, stroke=0)
    style = ParagraphStyle("callout", fontName="JPB", fontSize=8.5,
                           leading=10, textColor=WHITE, alignment=TA_CENTER)
    p = Paragraph(str(callout["number"]), style)
    _, ph = p.wrap(radius * 2, radius * 2)
    p.drawOn(PDF, bx - radius, H - by - ph / 2)


def draw_screenshot_item(image, x, top, max_width, max_height):
    scale = min(max_width / image["width"], max_height / image["height"])
    draw_width = image["width"] * scale
    draw_height = image["height"] * scale
    draw_x = x + (max_width - draw_width) / 2
    clip = image["clip"]
    full_width = image["source_width"] * scale
    full_height = image["source_height"] * scale
    full_x = draw_x - clip["x"] * scale
    full_top = top - clip["y"] * scale
    clip_path = PDF.beginPath()
    clip_path.rect(draw_x, H - top - draw_height, draw_width, draw_height)
    PDF.saveState()
    PDF.clipPath(clip_path, stroke=0, fill=0)
    PDF.drawImage(ImageReader(str(image["path"])), full_x, H - full_top - full_height,
                  width=full_width, height=full_height, preserveAspectRatio=True,
                  anchor="c", mask="auto")
    PDF.restoreState()
    PDF.setStrokeColor(BORDER)
    PDF.setLineWidth(.55)
    PDF.rect(draw_x, H - top - draw_height, draw_width, draw_height, fill=0, stroke=1)
    for callout in image["callouts"]:
        draw_callout(image, callout, draw_x, top, draw_width, draw_height)
    return draw_x, draw_width, draw_height


def screenshot_figure(kind, top, available_height):
    images = SCREENSHOTS[kind]
    gap = 5
    caption_padding = 3
    caption_heights = [
        max(text_height(image["caption"] or f"{kind}画面", CW,
                        size=8.2, leading=10.3), 10.3)
        for image in images
    ]
    # Small crops stay near their natural pixel-to-point size so text remains
    # readable; full desktop captures still use the page width.
    natural_widths = [min(CW, image["width"] * .65) for image in images]
    natural_heights = [natural_widths[i] * image["height"] / image["width"]
                       for i, image in enumerate(images)]
    caption_space = sum(caption_heights) + len(images) * caption_padding
    image_space = max(available_height - caption_space - gap * (len(images) - 1), 1)
    fit_scale = min(1, image_space / max(sum(natural_heights), 1))
    image_widths = [width * fit_scale for width in natural_widths]
    y = top
    for index, image in enumerate(images):
        max_width = image_widths[index]
        x = M + (CW - max_width) / 2
        max_height = natural_heights[index] * fit_scale
        draw_x, draw_width, draw_height = draw_screenshot_item(image, x, y, max_width, max_height)
        caption_top = y + draw_height + 3
        caption = image["caption"] or f"{kind}画面"
        style = ParagraphStyle("shot-caption", fontName="JP", fontSize=8.2,
                               leading=10.3, textColor=MUTED, alignment=TA_CENTER,
                               wordWrap="CJK")
        p = Paragraph(escape(caption), style)
        _, ch = p.wrap(CW, caption_heights[index])
        if ch > caption_heights[index] + .1:
            raise ValueError(f"Caption overflow for {image['path'].name}: {ch:.1f}pt.")
        p.drawOn(PDF, M, H - caption_top - ch)
        LAYOUT.append({
            "page": PAGE_NO, "kind": "screenshot", "screenshot_kind": kind,
            "file": str(image["path"].relative_to(ROOT)), "caption": caption,
            "image": {"x": round(draw_x, 2), "top": round(y, 2),
                      "width": round(draw_width, 2), "height": round(draw_height, 2),
                      "pixel_width": image["width"], "pixel_height": image["height"],
                      "clip": image["clip"],
                      "source_pixel_width": image["source_width"],
                      "source_pixel_height": image["source_height"]},
            "callouts": image["callouts"],
        })
        y += draw_height + caption_padding + caption_heights[index]
        if index < len(images) - 1:
            y += gap
    if y > top + available_height + .1:
        raise ValueError(f"Screenshot figure for {kind} exceeds its allocated area.")
    return y - top


def screenshot_available(page, y):
    steps = page.get("steps", [])
    notes = page.get("notes", [])
    reserved = steps_height(steps) + notes_height(notes)
    if page["kind"] == "login":
        # Page 2 also carries the role matrix; keep its login screenshot compact.
        role_matrix_height = 42 + 29 + 4 * 29 + 12
        reserved += role_matrix_height
    footer_safe_top = H - 47
    return min(310, footer_safe_top - y - reserved - 17)


def draw_header(page):
    col = base.tone(page["role"])
    PDF.setFillColor(col)
    PDF.rect(M, H - 31, 30, 4, fill=1, stroke=0)
    base.para(page["role"], M + 40, 20, 310, size=8.8, bold=True, color=col)
    base.para("生産工程管理 / 操作マニュアル", W - M - 225, 20, 225,
              size=8.2, color=MUTED, align=base.TA_RIGHT)
    title_height = base.para(page["title"], M, 54, CW, size=20, bold=True, leading=28)
    y = 54 + title_height + 12
    if page.get("lead"):
        y += base.para(page["lead"], M, y, CW, size=10.8) + 17
    return y


def draw_footer(page, n):
    PDF.setStrokeColor(BORDER)
    PDF.setLineWidth(.5)
    PDF.line(M, 34, W - M, 34)
    PDF.setFont("JP", 8)
    PDF.setFillColor(MUTED)
    PDF.drawString(M, 20, f"{DATE}版 / 実画面・掲載データは説明用")
    PDF.setFont("JPB", 9)
    PDF.drawRightString(W - M, 20, f"{n} / {len(base.PAGES)}")


def draw_cover():
    base.cover()
    # The native cover is reused, with an explicit real-screen badge and a small
    # ledger thumbnail in the open area below the audience cards.
    PDF.setFillColor(ORANGE)
    PDF.roundRect(W - M - 95, H - 238, 95, 24, 6, fill=1, stroke=0)
    base.para("実画面版", W - M - 91, 221, 87, size=11, bold=True,
              color=WHITE, align=TA_CENTER, leading=14)
    PDF.setFillColor(WHITE)
    PDF.rect(M - 3, H - 760, CW + 6, 38, fill=1, stroke=0)
    base.para(f"A4縦 / 実画面版 / {DATE}版", M, 735, CW,
              size=10.5, bold=True, color=MUTED)
    thumb = SCREENSHOTS.get("cover", SCREENSHOTS["ledger"])[0]
    thumb_x, thumb_top, thumb_w, thumb_h = M, 580, CW, 140
    _, draw_w, draw_h = draw_screenshot_item(thumb, thumb_x, thumb_top, thumb_w, thumb_h)
    base.para("実際の画面例", thumb_x, thumb_top + draw_h + 4, thumb_w,
              size=8, color=MUTED, align=TA_CENTER)
    # The reused cover footer has the simplified-manual label; replace it.
    PDF.setFillColor(WHITE)
    PDF.rect(0, 0, W, 39, fill=1, stroke=0)
    draw_footer(base.PAGES[0], 1)


def build_markdown():
    lines = [
        "# 生産工程管理 操作マニュアル（実画面版）", "",
        f"{DATE}版。A4縦{len(base.PAGES)}ページ。", "",
        "対象：職人（権限：作業員）／事務（権限：編集者）。", "",
        "画面写真は説明用データで撮影した実アプリ画面です。案件・数値は説明用です。", "",
        "本文・目次は通常版と共通です。図は画面写真と番号付きの案内に置き換えています。", "",
    ]
    for i, page in enumerate(base.PAGES, 1):
        lines.extend([f"## {i:02d}ページ　{page['title']}", "", f"対象：{page['role']}", ""])
        if page.get("lead"):
            lines.extend([page["lead"], ""])
        if page.get("toc"):
            lines.extend([f"- {dest}ページ：{title}" for dest, title in page["toc"]])
            lines.append("")
        for j, (title, body) in enumerate(page_steps(page), 1):
            lines.extend([f"{j}. **{title}**：{body}", ""])
        for title, text in page.get("notes", []):
            if page["kind"] == "daily" and title == "この冊子の印刷・図について":
                text = CAPTION
                title = "図注"
            lines.extend([f"**{title}**：{text}", ""])
        for title, body, ref in page.get("issues", []):
            lines.extend([f"- **{title}**：{body}（{ref}ページ）", ""])
        for text in page.get("checks", []):
            lines.extend([f"- [ ] {text}", ""])
        if page["kind"] in SCREENSHOT_KINDS:
            lines.append("図：実際のアプリ画面を説明用データで撮影。")
            for image in SCREENSHOTS[page["kind"]]:
                if image["caption"]:
                    lines.append(f"- {image['caption']}")
            lines.append("")
    lines.extend([
        "## 作成時の確認元", "",
        "- tools/build-user-manual.py：共通のページ本文・目次・表組み。",
        "- src/index.html、src/app.js、src/access.html、src/access.js：画面名・操作・本人確認。",
        "- apps-script/AccessControl.gs、Repository.gs、Polishing.gs、ProductMaster.gs：権限・保存・研磨・製品表示。",
        "", "再生成：Codexの同梱Pythonで tools/build-screenshot-manual.py を実行。", "",
    ])
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    SOURCE.write_text("\n".join(lines), encoding="utf-8")


def build_pdf():
    global PDF, PAGE_NO, LAYOUT, SCREENSHOTS
    SCREENSHOTS = read_manifest()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    PDF = canvas.Canvas(str(OUT), pagesize=A4, pageCompression=1)
    PDF.setTitle("生産工程管理 操作マニュアル - 実画面版")
    PDF.setAuthor("生産工程管理")
    PDF.setSubject("A4縦・職人と事務の実アプリ画面付き操作手順")
    PDF.setViewerPreference("DisplayDocTitle", "true")
    base.c = PDF
    base.layout_checks = []
    LAYOUT = []
    for n, page in enumerate(base.PAGES, 1):
        PAGE_NO = n
        base.page_number = n
        PDF.bookmarkPage(f"p{n}")
        level = 1 if (4 <= n <= 11 or 13 <= n <= 19) else 0
        PDF.addOutlineEntry(f"{n:02d} {page['title']}", f"p{n}", level=level, closed=False)
        if n == 1:
            draw_cover()
            PDF.showPage()
            continue
        y = draw_header(page)
        if page["kind"].endswith("toc"):
            y = base.toc_page(page, y)
        elif page["kind"] == "troubleshooting":
            y = base.trouble(page, y)
            for title, text in page.get("notes", []):
                y = base.note(title, text, y, page["role"])
        else:
            if page["kind"] == "daily":
                figure_height = base.draw_diagram(page["kind"], y)
            else:
                available = screenshot_available(page, y)
                if available < 70:
                    raise ValueError(
                        f"Page {n} has only {available:.1f}pt for its screenshot after reserving text."
                    )
                figure_height = screenshot_figure(page["kind"], y, available)
            y += figure_height + 15
            if n == 2:
                y = base.steps_block(page_steps(page), y, page["role"])
                y = base.role_matrix(y)
            elif page["kind"] == "daily":
                y = base.daily_checks(page, y)
            else:
                y = base.steps_block(page_steps(page), y, page["role"])
            for title, text in page.get("notes", []):
                if page["kind"] == "daily" and title == "この冊子の印刷・図について":
                    text = CAPTION
                y = base.note(title, text, y, page["role"])
        if y > H - 39:
            raise ValueError(f"Page {n} text exceeds footer-safe area: {y:.1f}pt.")
        draw_footer(page, n)
        PDF.showPage()
    PDF.save()
    reader = PdfReader(OUT)
    assert len(reader.pages) == len(base.PAGES)
    for i, page in enumerate(reader.pages, 1):
        assert abs(float(page.mediabox.width) - W) < .1
        assert abs(float(page.mediabox.height) - H) < .1
        txt = page.extract_text()
        assert f"{i} / {len(base.PAGES)}" in txt
        assert base.PAGES[i - 1]["title"] in txt.replace("\n", " ") or i == 1
    QA.parent.mkdir(parents=True, exist_ok=True)
    QA.write_text(json.dumps({
        "pages": len(base.PAGES), "page_size": "A4 portrait", "screenshots": LAYOUT,
        "text_boxes": base.layout_checks,
        "caption": CAPTION,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    build_markdown()
    print(json.dumps({"pdf": str(OUT), "markdown": str(SOURCE),
                      "pages": len(base.PAGES), "screenshot_count": len(LAYOUT),
                      "qa": str(QA)}, ensure_ascii=False))


if __name__ == "__main__":
    build_pdf()
