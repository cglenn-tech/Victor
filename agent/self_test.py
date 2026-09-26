"""Offline startup check for the actual packaged Mac executable.

Uses fictional records and an ephemeral encryption key. Never captures the
screen, reads saved credentials, opens the user's database, or calls a server.
"""
from pathlib import Path
import secrets
import ssl
import sqlite3
import sys
import tempfile
import traceback


def check_certificate_store() -> str:
    import certifi
    from tls_config import configure_tls

    path = Path(configure_tls()).resolve()
    bundled_path = Path(certifi.where()).resolve()
    if getattr(sys, 'frozen', False):
        bundle_root = Path(sys._MEIPASS).resolve()
        # PyInstaller's Mac bundle links data from Frameworks into Resources.
        if bundle_root.name == 'Frameworks' and bundle_root.parent.name == 'Contents':
            bundle_root = bundle_root.parent
        assert bundled_path.is_relative_to(bundle_root), 'CA store is outside the app'
    context = ssl.create_default_context()
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
    assert context.cert_store_stats()['x509_ca'] > 0, 'No trusted certificates loaded'
    assert path.is_file(), 'Configured CA store is missing'
    return 'Verified TLS certificate store: PASS'


def run_connection_check() -> int:
    """Public HTTPS check only: no device credentials, capture, or account writes."""
    import urllib.error
    import urllib.request
    import config

    lines = [f'Victor {config.APP_VERSION} connection check']
    result = 0
    try:
        lines.append(check_certificate_store())
        # The authenticated route must reject this credential-free request.
        # Reaching its HTTP response proves TLS completed successfully.
        try:
            with urllib.request.urlopen(config.BASE_URL + '/api/device/heartbeat', timeout=20) as response:
                raise RuntimeError(f'Heartbeat unexpectedly returned HTTP {response.status}')
        except urllib.error.HTTPError as exc:
            if exc.code != 401:
                raise RuntimeError(f'Website returned HTTP {exc.code}') from None
        lines.append('Website HTTPS connection (no credentials): PASS')
    except Exception as exc:
        lines.append(f'Connection check: FAIL ({type(exc).__name__})')
        result = 1
    text = '\n'.join(lines) + '\n'
    (Path(tempfile.gettempdir()) / 'victor-connection-check.log').write_text(text)
    if sys.stdout is not None:
        print(text, end='')
    return result


def run_self_test() -> int:
    lines = []
    result = 0
    try:
        lines.append(check_certificate_store())
        # Explicit imports let PyInstaller discover the same dependencies that
        # are loaded lazily when the capture worker starts.
        import main  # noqa: F401
        import consent_manager  # noqa: F401
        import capture  # noqa: F401
        import realtime_client  # noqa: F401
        import Security  # noqa: F401
        import ScreenCaptureKit as SC
        import analysis_queue  # noqa: F401
        import session_consent  # noqa: F401
        assert hasattr(SC.SCScreenshotManager, 'captureImageWithFilter_configuration_completionHandler_')
        assert hasattr(SC.SCContentFilter, 'initWithDesktopIndependentWindow_')
        lines.append('Packaged ScreenCaptureKit window API: PASS')
        import database
        from episode import StructuredObservation
        from episode_engine import EpisodeEngine

        lines.append('Packaged runtime imports: PASS')
        original_key_provider = database._get_or_create_keychain_key
        key = secrets.token_hex(32)
        database._get_or_create_keychain_key = lambda: key
        try:
            with tempfile.TemporaryDirectory(prefix='victor-self-test-') as directory:
                path = Path(directory) / 'fictional.db'
                conn = database._connect_encrypted(path)
                try:
                    engine = EpisodeEngine()
                    engine.ingest_observation(StructuredObservation(
                        'test-observation', 'Review fictional agreement',
                        'Reviewed the fictional payment schedule for Client Alpha.',
                        '2026-01-05T10:00:00Z', '2026-01-05T10:01:00Z',
                        ['Word'], ['Client Alpha'], 'drafting', 'Client Alpha / test',
                    ))
                    episode = engine.force_close_active()
                    database.save_work_snapshot(conn, episode)
                finally:
                    conn.close()

                conn = database._connect_encrypted(path)
                try:
                    parents = database.get_unsynced_episodes(conn)
                    children = database.get_unsynced_observations(conn)
                    assert len(parents) == len(children) == 1
                    assert children[0]['episode_id'] == parents[0]['id']
                    assert parents[0]['observation_count'] == 1
                finally:
                    conn.close()
                lines.append('Encrypted work snapshot survives reopen: PASS')

                plain = sqlite3.connect(str(path))
                try:
                    try:
                        plain.execute('SELECT count(*) FROM sqlite_master').fetchone()
                    except sqlite3.DatabaseError:
                        lines.append('Database rejects reads without its key: PASS')
                    else:
                        raise RuntimeError('Packaged database encryption is inactive')
                finally:
                    plain.close()
        finally:
            database._get_or_create_keychain_key = original_key_provider
    except Exception:
        lines.append(traceback.format_exc())
        result = 1
    lines.append('Self-test: ' + ('PASS' if result == 0 else 'FAIL'))
    (Path(tempfile.gettempdir()) / 'victor-self-test.log').write_text('\n'.join(lines) + '\n')
    return result
