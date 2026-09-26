"""Give the frozen app a CA store independent of the build machine's Python.

Both urllib and realtime-py's websockets client create default SSL contexts.
Configure OpenSSL before either creates a context; keep verification enabled
and honor an explicit administrator-provided SSL_CERT_FILE.
"""
import os
from pathlib import Path

import certifi


def configure_tls() -> str:
    bundle = certifi.where()
    if not Path(bundle).is_file():
        raise RuntimeError('Victor is missing its bundled trusted certificates')
    return os.environ.setdefault('SSL_CERT_FILE', bundle)
