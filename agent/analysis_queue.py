"""Account-scoped, durable analysis queue. Capture time never becomes upload time.

Only pending local frames and job receipts are retained. Submitted jobs can be
resumed without their images. Completed text is acknowledged after SQLite saves
the observation, so a crash between analysis and sync does not lose the result.
"""
import json
import time
import uuid
from dataclasses import asdict
from pathlib import Path

import config
import model_client
import vision
from episode import BatchItem, StructuredObservation


class ObservationQueue:
    def __init__(self, conn):
        self.conn = conn
        self.last_error = None
        self._next_poll = 0.0
        self._items = []
        self._jobs = []
        self._first_add = 0.0
        row = conn.execute("SELECT value FROM session_state WHERE key = 'analysis_queue'").fetchone()
        if row:
            saved = json.loads(row[0])
            self._items = saved.get('items', [])
            self._jobs = saved.get('jobs', [])
            self._first_add = saved.get('first_add', 0)

    def __len__(self):
        return len(self._items) + sum(len(j['items']) for j in self._jobs)

    @property
    def status(self):
        return 'error' if self.last_error else ('analysis_pending' if self._jobs else 'recording')

    def checkpoint(self):
        value = json.dumps({'items': self._items, 'jobs': self._jobs, 'first_add': self._first_add})
        self.conn.execute("INSERT INTO session_state(key, value) VALUES ('analysis_queue', ?) "
                          "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (value,))
        self.conn.commit()

    def _seal(self):
        if not self._items:
            return
        self._jobs.append({'id': str(uuid.uuid4()), 'items': self._items,
                           'created': self._first_add, 'attempts': 0})
        self._items = []
        self._first_add = 0
        self.checkpoint()

    def add(self, obs):
        if len(self) >= 250:
            Path(obs.screenshot_path).unlink(missing_ok=True)
            self.last_error = 'Analysis backlog is full; waiting for Runpod'
            return self._process()
        if self._items and (self._items[-1]['app'], self._items[-1]['window_title']) != (obs.app, obs.window_title):
            self._seal()
        if not self._items:
            self._first_add = time.time()
        self._items.append(asdict(BatchItem(obs.screenshot_path, obs.timestamp, obs.app or '',
            obs.window_title or '', obs.browser_url or '', obs.file_path or '', list(obs.entities or []))))
        self.checkpoint()
        if len(self._items) >= config.OBSERVATION_BATCH_SIZE:
            self._seal()
        return self.maybe_idle_flush()

    def maybe_idle_flush(self):
        # Bound time since the FIRST frame, including a single static screenshot.
        if self._items and time.time() - self._first_add >= getattr(config, 'OBSERVATION_MAX_WAIT_SECONDS', 30):
            self._seal()
        return self._process()

    def flush(self, force=False):
        if force:
            self._seal()
        return self._process()

    def _process(self):
        if not self._jobs:
            return None
        job = self._jobs[0]
        if job.get('result'):
            return StructuredObservation(**job['result'])
        if time.monotonic() < self._next_poll:
            return None
        self._next_poll = time.monotonic() + 5
        if time.time() - job['created'] > 3600:
            self.last_error = 'Analysis expired before completion'
            self._drop()
            return None
        try:
            result = vision._analyze_batch([BatchItem(**i) for i in job['items']], job=job.get('ticket'))
        except model_client.PendingAnalysis as pending:
            job['ticket'] = pending.job
            self.last_error = None
            self.checkpoint()
            # Runpod now owns the submitted input; no need to retain local images.
            self._delete_frames(job['items'])
            return None
        except vision._PermanentBatchError:
            result = None
            job['attempts'] = 3
        if result is not None:
            result.id = job['id']  # same result ID across retries and process restarts
            job['result'] = asdict(result)
            self.last_error = None
            self.checkpoint()
            self._delete_frames(job['items'])
            return result
        job['attempts'] += 1
        self.last_error = 'Runpod analysis failed; retrying' if job['attempts'] < 3 else 'Runpod could not analyze a screenshot batch'
        self._next_poll = time.monotonic() + min(30, job['attempts'] * 10)
        if job['attempts'] >= 3:
            self._drop()
        else:
            self.checkpoint()
        return None

    @staticmethod
    def _delete_frames(items):
        for item in items:
            Path(item['screenshot_path']).unlink(missing_ok=True)

    def _drop(self):
        self._delete_frames(self._jobs[0]['items'])
        self._jobs.pop(0)
        self.checkpoint()

    def acknowledge(self, observation_id):
        if self._jobs and self._jobs[0]['id'] == observation_id and self._jobs[0].get('result'):
            self._drop()

    def discard(self):
        # Shutdown saves the queue in the account's encrypted DB. It never sends
        # a new screenshot. Expired unsubmitted frames are purged at next startup.
        self.checkpoint()
