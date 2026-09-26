"""Pending Runpod jobs survive restart and keep their original capture times."""
import json
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

# Reuse the isolated OS/auth fixture; production SQLite and analysis code run.
from test_connected_flow import config, database, credentials, model_client, main, observation
from analysis_queue import ObservationQueue
from episode_engine import EpisodeEngine
from session_consent import SessionConsentManager
from window_identity import WindowIdentity


class AnalysisQueueTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        config.DB_PATH = Path(self.temp.name) / 'legacy.db'
        config.SCREENSHOTS_DIR = Path(self.temp.name)
        credentials.update(owner='owner-a', token='token-a')
        self.conn = database.connect('owner-a')
        self.now = int(time.time())
        self.frame = Path(self.temp.name) / 'frame.jpg'
        from PIL import Image
        Image.new('RGB', (20, 20), 'white').save(self.frame)
        self.so = observation('Alpha', self.now-86400, self.now-86370)
        self.obs = types.SimpleNamespace(screenshot_path=str(self.frame), timestamp=self.so.start_time,
            app='Word', window_title='Alpha', browser_url='', file_path='', entities=[])

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def test_cold_start_is_polled_without_resubmitting_images_after_restart(self):
        q = ObservationQueue(self.conn)
        q.add(self.obs)
        with patch.object(model_client, 'chat_completion', side_effect=model_client.PendingAnalysis('signed-job')) as submit:
            self.assertIsNone(q.flush(force=True))
        self.assertEqual(submit.call_count, 1)
        self.assertFalse(self.frame.exists())
        restored = ObservationQueue(self.conn)
        response = dict(title=self.so.title, observation=self.so.observation, startTime='invented today', endTime='invented today', applications=['Word'], entities=['Alpha'], activityType='drafting', matter='Alpha')
        with patch.object(model_client, 'chat_completion', return_value=json.dumps(response)) as poll:
            result = restored.flush(force=True)
        self.assertEqual(poll.call_args.kwargs['job'], 'signed-job')
        self.assertEqual(result.start_time, self.so.start_time)
        self.assertEqual(result.end_time, self.so.start_time)
        engine = EpisodeEngine()
        main._handle_observation(self.conn, engine, result)
        # Crash after the save but before acknowledgement must not duplicate work.
        restored = ObservationQueue(self.conn)
        main._handle_observation(self.conn, EpisodeEngine(), restored.flush(force=True))
        self.assertEqual(len(database.get_unsynced_episodes(self.conn)), 1)
        restored.acknowledge(result.id)
        self.assertEqual(len(ObservationQueue(self.conn)), 0)

    def test_one_screenshot_is_submitted_within_thirty_seconds_and_queue_is_owner_scoped(self):
        q = ObservationQueue(self.conn)
        q.add(self.obs)
        with patch('analysis_queue.time.time', return_value=time.time()+31), patch.object(model_client, 'chat_completion', side_effect=model_client.PendingAnalysis('job')) as submit:
            q.maybe_idle_flush()
        submit.assert_called_once()
        other = database.connect('owner-b')
        try:
            self.assertEqual(len(ObservationQueue(other)), 0)
        finally:
            other.close()

    def test_delayed_completion_does_not_inflate_work_duration(self):
        engine = EpisodeEngine()
        engine.ingest_observation(self.so)
        ep = engine.force_close_active()
        self.assertEqual(ep.started_at, self.so.start_time)
        self.assertEqual(ep.ended_at, self.so.end_time)
        self.assertEqual(ep.active_seconds, 30)

    def test_session_consent_requires_explicit_start_and_expires_on_stop(self):
        consent = SessionConsentManager()
        window = WindowIdentity('Word', 1, 2, 1.0, consent.session_epoch)
        self.assertFalse(consent.is_authorized(window))
        consent.begin_session()
        window.session_epoch = consent.session_epoch
        self.assertTrue(consent.is_authorized(window))
        consent.end_session()
        self.assertFalse(consent.is_authorized(window))
        consent.begin_session()
        self.assertFalse(consent.is_authorized(window))


if __name__ == '__main__':
    unittest.main()
