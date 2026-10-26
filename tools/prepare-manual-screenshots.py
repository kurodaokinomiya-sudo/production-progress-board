"""Prepare local capture pages without changing application source files."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'tmp' / 'manual-session'
TARGET.mkdir(parents=True, exist_ok=True)
html = (ROOT / 'src/index.html').read_text(encoding='utf-8')
html = html.replace('href="../tokens.css"', 'href="/tokens.css"').replace('href="styles.css"', 'href="/src/styles.css"')
html = html.replace('<script src="app.js"', '<script src="/src/app.js"')
html = html.replace('<script>\n', '<script>\n      localStorage.setItem("production-board-theme", "light");\n', 1)
html = html.replace('</body>', '<script src="/tools/manual-screenshots-fixture.js" defer></script>\n  </body>')
(TARGET / 'index.html').write_text(html, encoding='utf-8')
access = (ROOT / 'src/access.html').read_text(encoding='utf-8')
access = access.replace('href="../tokens.css"', 'href="/tokens.css"').replace('href="access.css"', 'href="/src/access.css"')
access = access.replace('src="access.js"', 'src="/src/access.js"').replace('<?= appUrl ?>', '/tmp/manual-session/index.html')
(TARGET / 'access.html').write_text(access, encoding='utf-8')
(ROOT / 'docs/manual-screenshots').mkdir(parents=True, exist_ok=True)
print(TARGET)
