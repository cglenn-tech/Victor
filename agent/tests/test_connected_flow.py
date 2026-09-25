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
                ENABLE_CAPTURE_LEASES=False, CAPTURE_INTERVAL_SECONDS=.01, APP_VERSION='1.1.1').items():
    setattr(config, k, v)
sys.modules['config'] = config
credentials = {'owner': 'owner-a', 'token': 'token-a'}
auth = types.ModuleType('auth')
auth.read_user_id = lambda: credentials['owner']
auth.read_credential = lambda: credentials['token']
auth.store_device_id = Mock()
auth.read_device_id = lambda: None
auth.store_user_id = Mock(side_effect=lambda owner: credentials.update(owner=owner))
auth._api_bearer = Mock()
auth.delete_credential = Mock(side_effect=lambda: credentials.update(token=None))
sys.modules['auth'] = auth
observer = types.ModuleType('observer')
observer.Observation = object
observer._CONSENT_BLOCKED = object()
observer.observe = Mock(return_value=None)
observer.reset = Mock()
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
        model_client.bind_session('owner-a', 'token-a')
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

    def test_work_snapshot_rolls_back_parent_when_child_save_fails(self):
        so = observation('Alpha', self.now-60, self.now-30)
        self.engine.ingest_observation(so)
        with patch.object(database, 'save_observation', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                main._close_and_save(self.conn, self.engine.active)
        self.assertEqual(database.get_unsynced_episodes(self.conn), [])
        self.assertEqual(database.get_unsynced_observations(self.conn), [])
        main._close_and_save(self.conn, self.engine.active)
        parents = database.get_unsynced_episodes(self.conn)
        children = database.get_unsynced_observations(self.conn)
        self.assertEqual(len(parents), 1)
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0]['episode_id'], parents[0]['id'])

    def test_startup_recovers_from_network_failure_and_revocation_needs_reconnect(self):
        from urllib.error import HTTPError
        stop = Mock()
        stop.is_set.return_value = False
        callback = Mock()
        with patch.object(auth, '_api_bearer', side_effect=[OSError('offline'), {'ok': True, 'user_id': 'owner-a'}]) as api:
            self.assertTrue(main._establish_session('owner-a', 'token-a', stop, callback))
            self.assertEqual(api.call_count, 2)
            stop.wait.assert_called_once_with(5)
        callback.assert_called_with('connecting')
        with patch.object(auth, '_api_bearer', side_effect=HTTPError('https://victor.invalid',401,'revoked',{},None)):
            self.assertFalse(main._establish_session('owner-a', 'token-a', stop, callback))
        self.assertIsNone(credentials['token'])
        callback.assert_called_with('reconnect_required')
        stopped = threading.Event()
        stopped.set()
        with patch.object(auth, '_api_bearer') as api:
            self.assertFalse(main._establish_session('owner-a', 'token-a', stopped))
            api.assert_not_called()

    def test_legacy_token_recovers_missing_owner_from_authenticated_server(self):
        credentials['owner'] = None
        with patch.object(auth, '_api_bearer', return_value={'ok': True, 'user_id': 'owner-a', 'device_id': 'device-a'}):
            self.assertTrue(main._establish_session(None, 'token-a', threading.Event()))
        self.assertEqual(credentials['owner'], 'owner-a')
        with patch.object(auth, '_api_bearer', return_value={'ok': True, 'user_id': 'owner-b'}):
            self.assertFalse(main._establish_session('owner-a', 'token-a', threading.Event()))
        self.assertEqual(credentials['owner'], 'owner-a')

    def test_worker_shutdown_persists_completed_work_without_new_analysis(self):
        stop = threading.Event()
        so = observation('Alpha', self.now-60, self.now-30)
        def cycle(conn, engine, batcher, consent, gap):
            engine.ingest_observation(so)
            stop.set()
        with patch.object(main, '_establish_session', return_value=True), \
             patch.object(main, '_cycle', side_effect=cycle), \
             patch.object(rc, 'start'), patch.object(sync, 'start'), \
             patch.object(rc, 'is_recording_active', return_value=True), \
             patch.object(model_client, 'chat_completion') as analyze:
            main.main(stop_event=stop)
            analyze.assert_not_called()
        parents = database.get_unsynced_episodes(self.conn)
        children = database.get_unsynced_observations(self.conn)
        self.assertEqual(len(parents), 1)
        self.assertEqual([c['id'] for c in children], [so.id])
        self.assertFalse(database.check_dirty_shutdown(self.conn))

    def test_cancelled_model_request_never_sends_screenshot(self):
        stop = threading.Event()
        model_client.bind_session('owner-a', 'token-a', stop)
        stop.set()
        with patch('urllib.request.urlopen') as network:
            self.assertIsNone(model_client.chat_completion([{'role': 'user', 'content': 'fictional screenshot'}]))
            network.assert_not_called()

    def test_recovered_single_image_batch_does_not_lose_previous_result(self):
        batcher = vision.ObservationBatcher()
        frames = []
        for number in range(2):
            path = Path(self.temp.name) / f'frame{number}.jpg'
            path.touch()
            frames.append(types.SimpleNamespace(screenshot_path=str(path), timestamp=iso(self.now),
                app='Word', window_title='Alpha', browser_url='', file_path='', entities=['Alpha']))
        first = observation('Alpha', self.now-60, self.now-30)
        second = observation('Alpha', self.now-30, self.now)
        with patch.object(config, 'OBSERVATION_BATCH_SIZE', 1), \
             patch.object(vision, '_analyze_batch', side_effect=[None, first, second]):
            self.assertIsNone(batcher.add(frames[0]))
            self.assertIs(batcher.add(frames[1]), first)
            self.assertEqual(len(batcher), 1)
            self.assertIs(batcher.flush(force=True), second)
        self.assertTrue(all(not Path(f.screenshot_path).exists() for f in frames))

    def test_pause_ends_at_evidence_time_instead_of_delayed_model_response(self):
        ep = Episode('e', 'Alpha', iso(self.now-1200), None)
        ep.pause_timing(at=self.now-900)
        ep.close(at=iso(self.now-600))
        self.assertEqual(ep.active_seconds, 300)
        ep = Episode('e', 'Alpha', iso(self.now-1200), None)
        ep.pause_timing(at=self.now-900)
        ep.add_structured_observation(observation('Alpha', self.now-600, self.now-300))
        ep.close(at=iso(self.now-300))
        self.assertEqual(ep.active_seconds, 600)

    def test_windows_exit_waits_for_worker_to_finish_saving(self):
        import app_windows
        app = app_windows.WindowsApp()
        saved = threading.Event()
        def worker(stop_event):
            stop_event.set()
            time.sleep(.02)
            saved.set()
        with patch.dict(sys.modules, {'session_monitor_windows': types.SimpleNamespace(start=Mock())}), \
             patch.object(app_windows, 'open_url'), patch.object(main, 'main', side_effect=worker):
            app.run()
        self.assertTrue(saved.is_set())
        self.assertFalse(app._agent_thread.is_alive())


if __name__ == '__main__':
    unittest.main()
