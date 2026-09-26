"""Real TLS handshakes, including a Mac with no developer Python CA store."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import socket
import ssl
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from tls_test_support import local_tls_server

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tls_config import configure_tls


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'fictional connection test')

    def log_message(self, *args):
        pass


class TLSConnection(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.cert, context = local_tls_server(directory.name)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.url = f'https://127.0.0.1:{self.server.server_port}'
        environment = patch.dict(os.environ, {'SSL_CERT_DIR': directory.name, 'NO_PROXY': '127.0.0.1'})
        environment.start()
        self.addCleanup(environment.stop)
        # urllib caches the HTTPS context with its process-wide opener.
        opener = patch('urllib.request._opener', None)
        opener.start()
        self.addCleanup(opener.stop)
        os.environ.pop('SSL_CERT_FILE', None)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_missing_python_trust_fails_then_bundled_ca_connects(self):
        os.environ['SSL_CERT_FILE'] = '/nonexistent/developer-python/cert.pem'
        with self.assertRaises(urllib.error.URLError):
            urllib.request.build_opener().open(self.url, timeout=3)
        # A clean installed app has no SSL_CERT_FILE override. Simulate its
        # packaged CA with an ephemeral test CA, never weaken verification.
        os.environ.pop('SSL_CERT_FILE')
        with patch('tls_config.certifi.where', return_value=self.cert):
            configure_tls()
        with urllib.request.urlopen(self.url, timeout=3) as response:
            self.assertEqual(response.read(), b'fictional connection test')

    def test_untrusted_certificate_is_rejected(self):
        configure_tls()
        with self.assertRaises(urllib.error.URLError) as caught:
            urllib.request.urlopen(self.url, timeout=3)
        self.assertIsInstance(caught.exception.reason, ssl.SSLCertVerificationError)

    def test_wrong_hostname_is_rejected(self):
        with patch('tls_config.certifi.where', return_value=self.cert):
            configure_tls()
        with socket.create_connection(self.server.server_address, timeout=3) as connection:
            with self.assertRaises(ssl.SSLCertVerificationError):
                ssl.create_default_context().wrap_socket(connection, server_hostname='wrong.invalid')

    def test_administrator_ca_override_is_preserved(self):
        os.environ['SSL_CERT_FILE'] = self.cert
        self.assertEqual(configure_tls(), self.cert)
        with urllib.request.urlopen(self.url, timeout=3) as response:
            self.assertEqual(response.status, 200)

    def test_missing_packaged_ca_fails_explicitly(self):
        with patch('tls_config.certifi.where', return_value='/nonexistent/victor/cacert.pem'):
            with self.assertRaisesRegex(RuntimeError, 'missing.*certificates'):
                configure_tls()


if __name__ == '__main__':
    unittest.main()
