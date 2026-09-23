"""Open a URL in the user's default browser.

PyInstaller's frozen macOS app often fails silently with webbrowser.open().
Prefer the platform shell helpers, then fall back to the stdlib.
"""
from __future__ import annotations

import os
import subprocess
import sys


def open_url(url: str) -> bool:
    """Open *url* in the default browser. Returns True on apparent success."""
    if not url:
        return False

    try:
        if sys.platform == "darwin":
            result = subprocess.run(
                ["open", url],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                print(f"[browser] opened via open: {url}")
                return True
            print(f"[browser] open failed ({result.returncode}): {result.stderr.strip()}")
        elif sys.platform == "win32":
            # os.startfile is the reliable Windows path for http(s) URLs.
            os.startfile(url)  # type: ignore[attr-defined]
            print(f"[browser] opened via startfile: {url}")
            return True
    except Exception as exc:
        print(f"[browser] platform open failed: {exc}")

    try:
        import webbrowser

        ok = webbrowser.open(url)
        print(f"[browser] opened via webbrowser ({ok}): {url}")
        return bool(ok)
    except Exception as exc:
        print(f"[browser] webbrowser open failed: {exc}")
        return False
