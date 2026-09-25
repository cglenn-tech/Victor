"""Exercise Victor against the installed realtime SDK and a local WebSocket.

No production credentials, Supabase project or captured data are used.
Run separately from tests that replace config/auth modules globally.
"""
import asyncio
from contextlib import suppress
import json
from pathlib import Path
import sys
import time
import types
import unittest
from unittest.mock import patch

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosedOK

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules['config'] = types.SimpleNamespace(BASE_URL='https://victor.invalid', APP_VERSION='1.1.1')
sys.modules['auth'] = types.SimpleNamespace(read_credential=lambda: 'fictional-device-token')
import realtime_client as rc


class RealtimeConnection(unittest.IsolatedAsyncioTestCase):
    async def check_connection(self, rejected=False):
        received = []
        gateway_paths = []
        response_received = asyncio.Event()

        async def server(socket):
            gateway_paths.append(socket.request.path)
            async for raw in socket:
                msg = json.loads(raw)
                received.append(msg)
                reply = {'topic': msg['topic'], 'event': 'phx_reply', 'ref': msg.get('ref'),
                         'payload': {'status': 'ok', 'response': {}}}
                if msg['event'] == 'phx_join':
                    reply['payload'] = ({'status': 'error', 'response': {'reason': 'not authorized'}}
                                        if rejected else {'status': 'ok', 'response': {'postgres_changes': []}})
                    await socket.send(json.dumps(reply))
                    if not rejected:
                        await socket.send(json.dumps({'topic': msg['topic'], 'event': 'presence_state', 'ref': None,
                            'payload': {'browser': {'metas': [{'phx_ref': 'browser-1', 'type': 'browser'}]}}}))
                elif msg['event'] == 'presence':
                    await socket.send(json.dumps(reply))
                    for event in ['start', 'status_request', 'stop']:
                        await socket.send(json.dumps({'topic': msg['topic'], 'event': 'broadcast', 'ref': None,
                            'payload': {'type': 'broadcast', 'event': event, 'payload': {}}}))
                elif msg['event'] == 'broadcast':
                    if msg['payload']['event'] == 'status':
                        response_received.set()
                elif msg['event'] == 'phx_leave':
                    with suppress(ConnectionClosedOK):
                        await socket.send(json.dumps(reply))

        rc._credentials = None
        rc._credentials_token = None
        rc._browser_present = False
        rc._current_state = 'idle'
        rc._last_session_check = 123
        rc._recording_event.set()
        async with serve(server, '127.0.0.1', 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            creds = {'supabase_url': f'http://127.0.0.1:{port}', 'anon_key': 'fictional-public-key',
                     'access_token': 'fictional-user-jwt', 'device_id': 'device-1', 'expires_at': time.time()+900}
            with patch.object(rc, '_fetch_credentials', return_value=creds):
                task = asyncio.create_task(rc._connect_once())
                try:
                    if rejected:
                        with self.assertRaisesRegex(RuntimeError, 'rejected'):
                            await asyncio.wait_for(task, timeout=3)
                    else:
                        await asyncio.wait_for(response_received.wait(), timeout=3)
                        # Wait for the synchronous start/stop callbacks to be dispatched.
                        for _ in range(50):
                            if rc._last_session_check == 0 and not rc._recording_event.is_set():
                                break
                            await asyncio.sleep(.01)
                        self.assertTrue(rc._browser_present)
                        self.assertEqual(rc._last_session_check, 0)
                        self.assertFalse(rc._recording_event.is_set())
                finally:
                    if not task.done():
                        task.cancel()
                        with suppress(asyncio.CancelledError):
                            await task

        self.assertIn('apikey=fictional-public-key', gateway_paths[0])
        self.assertNotIn('fictional-user-jwt', gateway_paths[0])
        join = next(msg for msg in received if msg['event'] == 'phx_join')
        self.assertEqual(join['payload']['access_token'], 'fictional-user-jwt')
        self.assertTrue(join['payload']['config']['private'])
        tracks = [msg for msg in received if msg['event'] == 'presence']
        self.assertEqual(bool(tracks), not rejected)
        if tracks:
            self.assertEqual(tracks[0]['payload']['payload']['version'], '1.1.1')
        self.assertIsNone(rc._channel)

    async def test_gateway_auth_presence_and_commands_with_real_sdk(self):
        await self.check_connection()

    async def test_rejected_subscription_never_claims_connected_or_tracks(self):
        await self.check_connection(rejected=True)


if __name__ == '__main__':
    unittest.main()
