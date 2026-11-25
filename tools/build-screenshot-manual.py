"""Build the current actual-screen manual using the stable project command."""
from pathlib import Path
import runpy

if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).with_name('build-current-screenshot-manual.py')),run_name='__main__')
