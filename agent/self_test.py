"""Offline startup check for the actual packaged Mac executable.

Uses fictional records and an ephemeral encryption key. Never captures the
screen, reads saved credentials, opens the user's database, or calls a server.
"""
from pathlib import Path
import secrets
import sqlite3
import tempfile
import traceback


def run_self_test() -> int:
    lines = []
    result = 0
    try:
        # Explicit imports let PyInstaller discover the same dependencies that
        # are loaded lazily when the capture worker starts.
        import main  # noqa: F401
        import consent_manager  # noqa: F401
        import capture  # noqa: F401
        import realtime_client  # noqa: F401
        import Security  # noqa: F401
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
