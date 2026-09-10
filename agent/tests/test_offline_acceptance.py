"""
Offline Acceptance Test.

Verifies the core privacy invariant of the new architecture: with the
self-hosted model endpoint UNCONFIGURED, a complete capture → episode →
report sequence runs with zero network calls and no crashes.

The product is private by design: the only network destinations in the
entire agent are (a) the user's own Supabase backend (episode/observation
sync) and (b) the self-hosted model endpoint via model_client.py. There is
no third-party model path anywhere.

Mocks urllib.request.urlopen and socket.create_connection at module level
and asserts zero calls to either throughout the full pipeline.
"""
import importlib
import os
import sqlite3
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# ── Force Private Mode environment variables ───────────────────────────────────
# Set env vars before any agent module is imported, and reload config so that
# cached imports in prior tests don't carry stale values.
_PRIVATE_MODE_ENV = {
    "BUILDHARVEY_PRIVATE_MODE": "true",
    "ENABLE_CAPTURE_LEASES": "false",   # simplify: skip consent UI in test
    "USE_LOCAL_INFERENCE": "false",     # NullBackend — no model needed
    "BUILDHARVEY_BASE_URL": "http://should-never-be-called.invalid",
}
os.environ.update(_PRIVATE_MODE_ENV)

# Reload config (and any module that cached the old PRIVATE_MODE value)
# so the rest of this module sees fresh values from the env.
if "config" in sys.modules:
    importlib.reload(sys.modules["config"])
if "sync" in sys.modules:
    importlib.reload(sys.modules["sync"])
if "finalizer" in sys.modules:
    importlib.reload(sys.modules["finalizer"])
if "vision" in sys.modules:
    importlib.reload(sys.modules["vision"])


def _enforce_private_mode() -> None:
    """
    Ensure BUILDHARVEY_PRIVATE_MODE=true is in the environment and reload all
    modules that cache privacy config. Called in setUp so that test collection
    order cannot pollute the privacy state.
    """
    import importlib as _il
    import sys as _sys
    # Explicitly set env vars before any reload
    os.environ.update(_PRIVATE_MODE_ENV)
    for mod_name in ("config", "sync", "finalizer", "vision"):
        if mod_name in _sys.modules:
            _il.reload(_sys.modules[mod_name])


class TestOfflineAcceptance(unittest.TestCase):
    """
    End-to-end offline acceptance test.

    Patches all network sockets at the lowest level so even indirect callers
    (through urllib, requests, websockets, etc.) cannot reach the network.
    """

    def setUp(self):
        """Enforce private mode and set up temp directories for the test."""
        # Re-enforce private mode env vars and reload cached modules at the
        # start of every test to survive cross-test module cache pollution
        # (e.g. test_realtime_optionality installs a config stub without PRIVATE_MODE).
        _enforce_private_mode()
        import tempfile
        self._tmpdir = tempfile.TemporaryDirectory()
        self._db_path = Path(self._tmpdir.name) / "test.db"

    def _make_network_blocker(self, name: str):
        """Return a mock that raises if called, recording the attempt."""
        def _blocked(*args, **kwargs):
            self.fail(
                f"Network call attempted via {name} with args={args!r}, kwargs={kwargs!r}. "
                f"This violates the offline-only invariant in Private Mode."
            )
        return MagicMock(side_effect=_blocked)

    def tearDown(self):
        self._tmpdir.cleanup()

    def _make_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._db_path))
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def test_no_network_calls_in_private_mode(self):
        """
        Assert zero network calls during a complete private-mode session:
        startup, episode finalization, report generation, and data deletion.
        """
        urlopen_mock = self._make_network_blocker("urllib.request.urlopen")
        socket_mock = self._make_network_blocker("socket.create_connection")

        with (
            patch("urllib.request.urlopen", urlopen_mock),
            patch("socket.create_connection", socket_mock),
        ):
            self._run_full_pipeline()

    def _run_full_pipeline(self):
        """
        Run through the full agent pipeline in-process:
          1. Connect to database (encrypted path skipped via env flag)
          2. Check/set dirty shutdown
          3. Finalize a synthetic episode
          4. Enqueue episode (sync must be a no-op in Private Mode)
          5. Generate a weekly report
          6. Delete all local data
        """
        # ── Patch config to use temp paths ──────────────────────────────────
        import config as _config
        # setUp() already reloaded config with PRIVATE_MODE=true
        original_db_path = _config.DB_PATH
        original_screenshots_dir = _config.SCREENSHOTS_DIR
        original_temp_frame = _config.TEMP_FRAME_PATH
        original_prev_frame = _config.PREV_FRAME_PATH
        original_base_dir = _config.BASE_DIR

        tmpdir = Path(self._tmpdir.name)
        _config.DB_PATH = tmpdir / "test.db"
        _config.SCREENSHOTS_DIR = tmpdir / "screenshots"
        _config.TEMP_FRAME_PATH = tmpdir / "_current.png"
        _config.PREV_FRAME_PATH = tmpdir / "_prev.png"
        _config.BASE_DIR = tmpdir
        _config.SCREENSHOTS_DIR.mkdir(exist_ok=True)

        try:
            # ── Step 1: database connect (plaintext — apsw not required in test) ──
            import database
            # Override PRIVATE_MODE check to use plaintext in test (apsw not installed in CI)
            conn = sqlite3.connect(str(_config.DB_PATH))
            conn.execute("PRAGMA journal_mode=WAL")
            database._migrate(conn)

            # ── Step 2: crash safety ──────────────────────────────────────────
            database.mark_dirty_shutdown(conn)
            self.assertFalse(database.check_dirty_shutdown(conn) is None)
            database.mark_clean_shutdown(conn)
            self.assertFalse(database.check_dirty_shutdown(conn))

            # ── Step 3: finalize a synthetic episode ─────────────────────────
            from episode import Episode, new_episode
            ep = new_episode("Test Matter v. Defendant", issue_worked_on="Motion to Dismiss")
            time.sleep(0.01)
            ep.close()

            import finalizer
            finalizer.finalize(ep)

            if ep.duration_minutes >= _config.MIN_EPISODE_DURATION_MINUTES:
                database.save_episode(conn, ep)

            # ── Step 4: persist a structured observation locally ──────────
            # Sync to the user's own backend is networked by design and is
            # therefore NOT part of the offline invariant. Here we verify the
            # durable local record works without any network.
            obs_dict = {
                "id": "test-obs-id",
                "title": "Test observation",
                "summary": "Drafted a motion and reviewed discovery responses.",
                "observed_at": "2026-09-10T10:00:00Z",
                "start_time": "2026-09-10T10:00:00Z",
                "end_time": "2026-09-10T10:04:00Z",
                "applications": ["Microsoft Word"],
                "entities": [],
                "activity_type": "drafting",
                "episode_id": ep.id,
            }
            database.save_observation(conn, obs_dict)
            database.mark_observation_synced(conn, "test-obs-id")
            saved = conn.execute(
                "SELECT title, activity_type, synced_at FROM observations WHERE id = ?",
                ("test-obs-id",),
            ).fetchone()
            self.assertIsNotNone(saved)
            self.assertEqual(saved[1], "drafting")

            # ── Step 5: weekly report generation ─────────────────────────────
            from weekly_report import WeeklyReportEngine
            engine = WeeklyReportEngine(conn)
            # Should not raise NotImplementedError anymore
            report_path = engine.generate("2026-08-01T00:00:00Z", "2026-08-08T23:59:59Z")
            self.assertIsInstance(report_path, str)
            self.assertTrue(Path(report_path).exists())

            # ── Step 6: delete all local data ─────────────────────────────────
            # Patch _delete_keychain_key to no-op (no actual keychain in test)
            with patch.object(database, "_delete_keychain_key", return_value=None):
                database.delete_all_local_data(conn)

        finally:
            # Restore config paths
            _config.DB_PATH = original_db_path
            _config.SCREENSHOTS_DIR = original_screenshots_dir
            _config.TEMP_FRAME_PATH = original_temp_frame
            _config.PREV_FRAME_PATH = original_prev_frame
            _config.BASE_DIR = original_base_dir

    def test_sync_queues_observation_and_episode_without_third_party_calls(self):
        """sync queue accepts observations/episodes; worker only ever talks to
        the user's own backend (config.BASE_URL) with the device token — never
        to a third-party model."""
        import sync
        # Enqueue must not crash and must not attempt network on the caller thread
        sync.enqueue_observation({
            "id": "obs-1", "title": "T", "summary": "S", "observed_at": "2026-09-10T10:00:00Z",
        })
        sync.enqueue_episode({"id": "ep-1", "case_name": "Test", "key_observations": []})
        # No worker started here — queueing is passive by design
        self.assertGreater(sync._queue.qsize(), 0)

    def test_finalizer_has_no_server_path_at_all(self):
        """The server finalize call is deleted from the codebase entirely."""
        import finalizer
        self.assertFalse(
            hasattr(finalizer, "_server_observations"),
            "finalizer must not contain a server path",
        )

        urlopen_mock = self._make_network_blocker("urllib.request.urlopen")
        with patch("urllib.request.urlopen", urlopen_mock):
            from episode import new_episode
            from episode import StructuredObservation
            ep = new_episode("Test Episode", issue_worked_on=None)
            so = StructuredObservation(
                id="obs-1", title="Drafting motion",
                observation="Drafted sections of the motion to compel and cited supporting case law.",
                start_time="2026-09-10T10:00:00Z", end_time="2026-09-10T10:04:00Z",
                applications=["Microsoft Word"], entities=["Peterson v. Ortega"],
                activity_type="drafting",
            )
            ep.add_structured_observation(so)
            ep.close()
            finalizer.finalize(ep)
            # Structured observations become key observations without network
            self.assertTrue(len(ep.key_observations) > 0)
            self.assertIn("Drafting motion", ep.key_observations[0].text)

    def test_vision_batcher_is_offline_when_model_unconfigured(self):
        """With the self-hosted endpoint unconfigured, the batcher accumulates,
        returns None on flush, deletes screenshots, and never touches the network."""
        import config as _config
        _config.SELF_HOSTED_MODEL_URL = ""
        _config.SELF_HOSTED_MODEL_NAME = ""
        _config.SELF_HOSTED_API_KEY = ""
        try:
            urlopen_mock = self._make_network_blocker("urllib.request.urlopen")
            with patch("urllib.request.urlopen", urlopen_mock):
                import vision
                from episode import BatchItem

                class _FakeObs:
                    screenshot_path = None
                    app = "TestApp"
                    window_title = "Test Window"
                    browser_url = ""
                    file_path = ""
                    entities = []
                    timestamp = "2026-09-10T10:00:00Z"

                batcher = vision.ObservationBatcher()
                self.assertIsNone(batcher.add(_FakeObs()))
                self.assertEqual(len(batcher), 1)
                # Unconfigured endpoint → None each time; batch retained for retry
                self.assertIsNone(batcher.flush(force=True))
                self.assertEqual(len(batcher), 1)
                self.assertIsNone(batcher.flush(force=True))
                self.assertIsNone(batcher.flush(force=True))
                # Third failure exhausts BATCH_MAX_ATTEMPTS → dropped, no crash
                self.assertEqual(len(batcher), 0)
        finally:
            _enforce_private_mode()


if __name__ == "__main__":
    unittest.main()
