"""Headless regression tests for the shipped capture/sync/review data contract.

Only OS capture, credentials, and HTTP are faked. Grouping, SQLite, queueing,
image preparation, batch parsing and session gates run their production code.
Run separately: python -m unittest discover -s agent/tests -p test_connected_flow.py -v
"""
import json
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
config = types.ModuleType('config')
for k, v in dict(PRIVATE_MODE=False, MAX_EPISODE_SECONDS=28800, INACTIVITY_PAUSE_SECONDS=300,
                MIN_EPISODE_DURATION_MINUTES=.5, MAX_KEY_OBSERVATIONS=8,
                BASE_URL='https://victor.invalid', OBSERVATION_BATCH_SIZE=5,
                OBSERVATION_FLUSH_IDLE_SECONDS=600, MIN_OBSERVATION_BATCH=2,
                VISION_ANALYSIS_SIZE=(1440,900), VISION_JPEG_QUALITY=85,
                VISION_MAX_ENCODED_BYTES=3*1024*1024, MODEL_MAX_RETRIES=0,
                ENABLE_CAPTURE_LEASES=False).items():
    setattr(config, k, v)
sys.modules['config'] = config
credentials = {'owner': 'owner-a', 'token': 'token-a'}
auth = types.ModuleType('auth')
auth.read_user_id = lambda: credentials['owner']
auth.read_credential = lambda: credentials['token']
auth.store_device_id = Mock()
auth._api_bearer = Mock()
sys.modules['auth'] = auth
observer = types.ModuleType('observer')
observer.Observation = object
observer._CONSENT_BLOCKED = object()
observer.observe = Mock(return_value=None)
observer.is_user_work = lambda _: True
sys.modules['observer'] = observer
logging = types.ModuleType('bh_logging')
logging.get_logger = lambda _: Mock()
sys.modules['bh_logging'] = logging
dotenv = types.ModuleType('dotenv')
dotenv.load_dotenv = lambda: None
sys.modules['dotenv'] = dotenv

import database
import main
import sync
import vision
import model_client
import realtime_client as rc
from episode import Episode, StructuredObservation
from episode_engine import EpisodeEngine


def iso(epoch):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(epoch))


def observation(matter, start, end):
    import uuid
    return StructuredObservation(str(uuid.uuid4()), 'Draft agreement',
        f'Reviewed and revised the payment terms for {matter}, including the installment schedule and the language describing overdue balances.',
        iso(start), iso(end), ['Microsoft Word'], [matter], 'drafting', matter)


class ConnectedFlow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        config.DB_PATH = Path(self.temp.name) / 'legacy.db'
        config.SCREENSHOTS_DIR = Path(self.temp.name)
        credentials.update(owner='owner-a', token='token-a')
        self.conn = database.connect('owner-a')
        self.now = int(time.time())
        self.engine = EpisodeEngine()
        rc.force_stop()
        rc._last_session_check = 0

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def test_two_clients_in_word_have_different_parents_and_correct_links(self):
        a = observation('Client Alpha / matter 1', self.now-120, self.now-90)
        b = observation('Client Beta / matter 2', self.now-60, self.now-30)
        main._handle_observation(self.conn, self.engine, a)
        first = self.engine.active.id
        main._handle_observation(self.conn, self.engine, b)
        second = self.engine.active.id
        self.assertNotEqual(first, second)
        rows = database.get_unsynced_observations(self.conn)
        self.assertEqual({r['id']: r['episode_id'] for r in rows}, {a.id: first, b.id: second})
        self.assertEqual(len(database.get_unsynced_episodes(self.conn)), 2)
        for ep in database.get_unsynced_episodes(self.conn):
            self.assertEqual(ep['observation_count'], 1)
        self.assertEqual(self.engine.force_close_active().id, second)
        self.assertIsNone(self.engine.active)
        self.engine.ingest_observation(observation('Client Alpha / matter 1', self.now, self.now))
        self.assertIsNotNone(self.engine.active)

    def test_durable_retries_send_parents_before_children(self):
        main._handle_observation(self.conn, self.engine, observation('Alpha', self.now-60, self.now-30))
        calls = []
        def offline(path, body, token):
            calls.append(path)
            raise OSError('offline')
        with patch.object(sync, '_post', side_effect=offline):
            sync.sync_pending(self.conn, 'owner-a', 'token-a')
        self.assertEqual(calls, ['/api/episodes/sync'])
        self.assertEqual(len(database.get_unsynced_observations(self.conn)), 1)
        with patch.object(sync, '_post', side_effect=lambda path, body, token: calls.append(path)):
            sync.sync_pending(self.conn, 'owner-a', 'token-a')
        self.assertEqual(calls[-2:], ['/api/episodes/sync', '/api/observations/sync'])
        self.assertEqual(database.get_unsynced_episodes(self.conn), [])
        self.assertEqual(database.get_unsynced_observations(self.conn), [])

    def test_upload_ack_does_not_hide_newer_snapshot(self):
        main._handle_observation(self.conn, self.engine, observation('Alpha', self.now-60, self.now-30))
        old = database.get_unsynced_episodes(self.conn)[0]
        main._close_and_save(self.conn, self.engine.active)
        database.mark_synced(self.conn, old['id'], old['agent_revision'])
        self.assertEqual(len(database.get_unsynced_episodes(self.conn)), 1)

    def test_other_login_cannot_see_or_upload_first_accounts_queue(self):
        main._handle_observation(self.conn, self.engine, observation('Alpha', self.now-60, self.now-30))
        credentials.update(owner='owner-b', token='token-b')
        other = database.connect('owner-b')
        try:
            self.assertEqual(database.get_unsynced_episodes(other), [])
            self.assertEqual(database.get_unsynced_observations(other), [])
            with patch.object(sync, '_post') as post:
                sync.sync_pending(self.conn, 'owner-a', 'token-a')
                post.assert_not_called()
        finally:
            other.close()
        self.assertNotEqual(database.account_db_path('owner-a'), database.account_db_path('owner-b'))
        self.assertFalse(config.DB_PATH.exists())

    def test_idle_frames_do_not_reset_activity_and_partial_batch_is_flushed(self):
        self.engine.ingest_observation(observation('Alpha', self.now-1200, self.now-600))
        batcher = Mock()
        batcher.maybe_idle_flush.return_value = None
        main._cycle(self.conn, self.engine, batcher, None, None)
        self.assertTrue(self.engine.active._is_paused)
        self.assertLessEqual(self.engine.active.active_seconds, 901)
        batcher.maybe_idle_flush.assert_called_once()

    def test_active_duration_uses_utc_and_excludes_pause(self):
        ep = Episode('e', 'Alpha', '2026-09-24T13:00:00Z', '2026-09-24T14:00:00Z')
        ep._total_paused_seconds = 1800
        self.assertEqual(ep.active_seconds, 1800)
        self.assertEqual(ep.duration_minutes, 30)

    def test_server_stop_and_unavailable_network_close_capture_gate(self):
        with patch.object(rc, '_call_heartbeat', return_value=True):
            self.assertTrue(rc.is_recording_active())
        rc._last_session_check = 0
        with patch.object(rc, '_call_heartbeat', return_value=False):
            self.assertFalse(rc.is_recording_active())
        rc._local_recording = True  # old/local UI cannot bypass the server lease
        self.assertFalse(rc.is_recording_active())

    def test_image_batch_is_deleted_and_not_routed_under_new_credentials(self):
        from PIL import Image
        screenshot = Path(self.temp.name) / 'frame.jpg'
        Image.new('RGB', (1440,900), 'white').save(screenshot)
        batcher = vision.ObservationBatcher()
        frame = types.SimpleNamespace(screenshot_path=str(screenshot), timestamp=iso(self.now), app='Word', window_title='Alpha', browser_url='', file_path='', entities=['Alpha'])
        batcher.add(frame)
        result = {'title': 'Draft agreement', 'observation': observation('Alpha', self.now, self.now).observation,
                  'startTime': iso(self.now), 'endTime': iso(self.now), 'applications': ['Word'], 'entities': ['Alpha'], 'activityType': 'drafting', 'matter': 'Alpha'}
        with patch.object(model_client, 'chat_completion', return_value=json.dumps(result)):
            so = batcher.flush(force=True)
        self.assertEqual(so.matter, 'Alpha')
        self.assertFalse(screenshot.exists())
        model_client.bind_session('owner-a', 'token-a')
        credentials.update(owner='owner-b', token='token-b')
        with patch('urllib.request.urlopen') as network:
            self.assertIsNone(model_client.chat_completion([{'role':'user','content':'old data'}]))
            network.assert_not_called()


if __name__ == '__main__':
    unittest.main()
