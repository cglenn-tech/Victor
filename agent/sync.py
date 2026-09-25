"""Durable, account-bound sync. SQLite is the queue; retries never discard work."""
import json
import threading
import urllib.request
import auth
import config
import database
from bh_logging import get_logger

log = get_logger('sync')
_wake = threading.Event()
_guard = threading.Lock()
_worker_thread = None
_worker_identity = None


def start() -> None:
    global _worker_thread, _worker_identity
    identity = (auth.read_user_id(), auth.read_credential())
    if not all(identity):
        return
    with _guard:
        if _worker_thread and _worker_thread.is_alive() and _worker_identity == identity:
            _wake.set()
            return
        _worker_identity = identity
        _worker_thread = threading.Thread(target=_worker, args=identity, name='sync-worker', daemon=True)
        _worker_thread.start()


def enqueue_episode(_episode_dict: dict) -> None:
    _wake.set()


def enqueue_observation(_obs_dict: dict) -> None:
    _wake.set()


def enqueue_cleanup(_invalid_ids: list[str]) -> None:
    _wake.set()  # invalidation is persisted in the same durable episode queue


def _same_account(owner: str, token: str) -> bool:
    return auth.read_user_id() == owner and auth.read_credential() == token


def _worker(owner: str, token: str) -> None:
    conn = database.connect(owner)
    try:
        while _same_account(owner, token):
            _wake.clear()
            try:
                sync_pending(conn, owner, token)
            except Exception as exc:
                log.warning('sync.pending_retry', error=type(exc).__name__)
            _wake.wait(15)
    finally:
        conn.close()


def sync_pending(conn, owner: str, token: str) -> None:
    # A child can only leave this device after its parent exists remotely.
    blocked = set()
    for episode in database.get_unsynced_episodes(conn):
        if not _same_account(owner, token):
            return
        episode.pop('evidence_paths', None)
        try:
            _post('/api/episodes/sync', episode, token)
            database.mark_synced(conn, episode['id'], episode['agent_revision'])
        except Exception as exc:
            blocked.add(episode['id'])
            log.warning('sync.episode_pending', error=type(exc).__name__)
    for observation in database.get_unsynced_observations(conn):
        if not _same_account(owner, token):
            return
        if observation.get('episode_id') in blocked:
            continue
        try:
            _post('/api/observations/sync', {'observations': [observation]}, token)
            database.mark_observation_synced(conn, observation['id'])
        except Exception as exc:
            log.warning('sync.observation_pending', error=type(exc).__name__)


def _post(path: str, body: dict, token: str) -> dict:
    req = urllib.request.Request(
        f'{config.BASE_URL}{path}', data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}, method='POST',
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())
