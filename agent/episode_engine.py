"""
Episode Engine — passive auto-grouping state machine.

State machine:
  IDLE → ACTIVE → TRANSITIONING → ACTIVE (or IDLE on safety net / force close)

Rules:
  - Claude's suggested_episode_name always drives episode naming.
  - Inactivity > 5 min → pause timing (episode stays open).
  - Inactivity > 8 h → close episode (safety net).
  - 2-signal hysteresis: first start_new_episode → transitioning state.
    Second consecutive start_new_episode → auto-close current and open new.
    Any continue_current_episode while transitioning → snap back to active.
"""
import calendar
import time
from dataclasses import dataclass, field
from typing import Literal, Optional

import config
from bh_logging import get_logger
from episode import Episode, ScreenshotEvidence, StructuredObservation, new_episode
from observer import Observation

log = get_logger("engine")


@dataclass
class EngineResult:
    active_episode: Optional[Episode]
    closed_episode: Optional[Episode] = None


class EpisodeEngine:
    def __init__(self) -> None:
        self.active: Optional[Episode] = None
        self._state: Literal["idle", "active", "transitioning"] = "idle"

        # 2-signal hysteresis fields
        self._consecutive_new_episode: int = 0
        self._candidate_name: str = ""

        # In-memory metadata context (app/URL/window) — never persisted
        self._current_app: str = ""
        self._current_url: str = ""
        self._current_window: str = ""

        # Current activity identity (from the latest structured observation)
        self._current_activity_type: str = ""
        self._current_matter: str = ""
        self._current_applications: list[str] = []

        # Observation held while awaiting 2-signal confirmation of a switch
        self._pending_observation: Optional[StructuredObservation] = None

    # ── Public API ─────────────────────────────────────────────────────────────

    def ingest_observation(
        self, so: StructuredObservation
    ) -> Optional[EngineResult]:
        """Only a matching explicit matter can extend an episode.

        Unknown work stays separate for review. App/type overlap is never proof
        that two observations concern the same client. No deferred assignment:
        the returned episode owns this observation immediately.
        """
        if not self.active:
            return self._open_episode_from_observation(so)
        if self._same_activity(so):
            self._attach(so)
            return EngineResult(active_episode=self.active)
        closed = self.active
        closed.close(at=max(closed.started_at, so.start_time))
        self.active = None
        self._state = "idle"
        result = self._open_episode_from_observation(so)
        result.closed_episode = closed
        return result

    def _same_activity(self, so: StructuredObservation) -> bool:
        def normalized(value):
            return " ".join(value.casefold().split())
        return bool(so.matter and self._current_matter and
                    normalized(so.matter) == normalized(self._current_matter) and
                    (so.activity_type == "administrative") == (self._current_activity_type == "administrative"))

    def _attach(self, so: StructuredObservation) -> None:
        """Attach an observation to the active episode and update activity identity."""
        self.active.add_structured_observation(so)
        self._current_activity_type = so.activity_type or self._current_activity_type
        if so.applications:
            merged = list(self._current_applications)
            for app in so.applications:
                if app.lower() not in [a.lower() for a in merged]:
                    merged.append(app)
            self._current_applications = merged[:10]

    def _open_episode_from_observation(
        self, so: StructuredObservation, name: Optional[str] = None
    ) -> EngineResult:
        ep = new_episode(so.matter or name or f"Unassigned: {so.title or 'work'}", issue_worked_on=None,
                         work_type="administrative" if so.activity_type == "administrative" else "project")
        ep.started_at = so.start_time
        self._current_matter = so.matter
        self.active = ep
        self._state = "active"
        self._consecutive_new_episode = 0
        self._candidate_name = ""
        self._pending_observation = None
        self._current_activity_type = so.activity_type or ""
        self._current_applications = list(so.applications or [])
        ep.add_structured_observation(so)
        ep.resume_timing()
        log.info("engine.episode_opened", episode=ep.case_name)
        return EngineResult(active_episode=ep)

    def _close_and_open_from_observation(
        self, so: StructuredObservation
    ) -> EngineResult:
        """Second differing observation confirmed — close current, open new."""
        closed = self.active
        # The held observation belongs to the activity we are switching into
        pending = self._pending_observation
        self.active = None
        self._state = "idle"
        self._pending_observation = None

        name = self._candidate_name or so.title
        result = self._open_episode_from_observation(so, name=name)
        if pending is not None:
            result.active_episode.add_structured_observation(pending)
        result.closed_episode = closed
        closed.close()
        return result

    def ingest_vision(
        self, evidence: Optional[ScreenshotEvidence], obs: Observation
    ) -> Optional[EngineResult]:
        """
        Process a Claude vision result.

        evidence=None means the API call failed or the screenshot was rejected —
        retain context, do not change episode state.

        Returns EngineResult (with optional closed_episode) or None.
        """
        if evidence is None:
            return None

        if self._state == "idle":
            return self._open_episode(evidence.suggested_episode_name, evidence)

        if self._state == "transitioning":
            if evidence.start_new_episode:
                # Second consecutive signal → confirmed switch
                return self._close_and_open(self._candidate_name, evidence)
            else:
                # continue_current_episode while transitioning → snap back
                self._state = "active"
                self._consecutive_new_episode = 0
                self._candidate_name = ""
                return self._continue_episode(evidence)

        # state == "active"
        if evidence.continue_current_episode:
            return self._continue_episode(evidence)

        if evidence.start_new_episode:
            return self._handle_transition(evidence)

        # Neither signal set (shouldn't happen after validation, but be safe)
        return self._continue_episode(evidence)

    def ingest_metadata(self, obs: Observation) -> None:
        """
        Process a metadata-only observation (no screenshot or no API key).

        Updates last_user_activity_at on the active episode and tracks current
        app/URL/window context. Never opens or closes an Episode.
        """
        self._current_app = obs.app or ""
        self._current_url = obs.browser_url or ""
        self._current_window = obs.window_title or ""

        if self.active:
            self.active.last_user_activity_at = time.time()
            self.active.add_raw_observation(obs)

    def ingest_metadata_activity_only(self) -> None:
        """An unchanged screen is not evidence of new activity."""
        pass

    def get_context(self) -> dict:
        """Return current episode context for the vision prompt."""
        if not self.active:
            return {
                "current_episode_name": "",
                "current_objective": "",
                "episode_duration_minutes": 0,
                "recent_actions": [],
                "known_entities": [],
            }

        recent_actions = [e.actions for e in self.active._evidence[-3:]]
        known = []
        seen: set[str] = set()
        for ev in self.active._evidence:
            for ent in ev.entities:
                name = ent.get("name", "")
                if name and name not in seen:
                    seen.add(name)
                    known.append(name)

        return {
            "current_episode_name": self.active.case_name,
            "current_objective": self.active._objective,
            "episode_duration_minutes": self.active.duration_minutes,
            "recent_actions": recent_actions,
            "known_entities": known,
        }

    def check_inactivity(self, now: float) -> Optional[Episode]:
        """
        Pause timing after INACTIVITY_PAUSE_SECONDS idle.
        Close and return the active episode after MAX_EPISODE_SECONDS (safety net).
        Returns the closed episode or None.
        """
        if not self.active:
            return None

        idle = now - self.active.last_user_activity_at
        elapsed = now - calendar.timegm(
            time.strptime(self.active.started_at, "%Y-%m-%dT%H:%M:%SZ")
        )

        # Safety net: 8 h total elapsed → force close
        if elapsed > config.MAX_EPISODE_SECONDS:
            return self._force_close(reason=f"8-h safety net [{elapsed:.0f}s elapsed]")

        # Pause after 5 min idle (episode stays open)
        if idle > config.INACTIVITY_PAUSE_SECONDS and not self.active._is_paused:
            self.active.pause_timing(at=self.active.last_user_activity_at + config.INACTIVITY_PAUSE_SECONDS)
            log.info("engine.timing_paused", episode=self.active.case_name, idle_s=round(idle))

        return None

    def force_close_active(self) -> Optional[Episode]:
        """
        Immediately close and return the active episode on explicit web Stop signal.
        """
        if not self.active:
            return None
        return self._force_close(reason="user stop")

    def check_deterministic_boundary(
        self, obs: Observation, current: Optional[Episode]
    ) -> Optional[bool]:
        """
        Check for deterministic episode boundary signals that don't require a
        model call.

        Returns:
          True  — new episode should be opened (definitive boundary detected)
          False — continue current episode (same app/matter, no boundary)
          None  — ambiguous; caller should invoke local model for classification

        Deterministic boundary signals (True):
          - App bundle_id changed to a different application
          - Known document-name pattern changed significantly in window title

        Definitive continue signals (False):
          - Same app and same window title (no content shift)

        Ambiguous (None — invoke model):
          - Same app but window title shifted to unknown content
        """
        if not current:
            # No active episode — ambiguous (model decides whether to open one)
            return None

        current_app = self._current_app
        current_window = self._current_window
        new_app = obs.app or ""
        new_window = obs.window_title or ""

        # App changed → definitive boundary
        if current_app and new_app and current_app != new_app:
            return True

        # Same app, same window title → definitely continue
        if new_app == current_app and new_window == current_window:
            return False

        # Same app, window title changed → ambiguous
        return None

    # ── Private helpers ────────────────────────────────────────────────────────

    def _open_episode(
        self, suggested_name: str, evidence: ScreenshotEvidence
    ) -> EngineResult:
        ep = new_episode(suggested_name, issue_worked_on=None, work_type="project")
        ep._objective = evidence.objective
        ep._evidence.append(evidence)
        ep.last_meaningful_evidence_at = time.time()

        # Resume timing in case this was opened after a pause
        ep.resume_timing()

        self.active = ep
        self._state = "active"
        self._consecutive_new_episode = 0
        self._candidate_name = ""
        log.info("engine.episode_opened", episode=ep.case_name)
        return EngineResult(active_episode=ep)

    def _continue_episode(self, evidence: ScreenshotEvidence) -> EngineResult:
        ep = self.active
        ep._evidence.append(evidence)
        ep.last_user_activity_at = time.time()
        ep.last_meaningful_evidence_at = time.time()

        # Resume timing if we were paused
        if ep._is_paused:
            ep.resume_timing()
            log.info("engine.timing_resumed", episode=ep.case_name)

        # Allow Claude to refine the name toward something more specific
        if (
            evidence.suggested_episode_name
            and evidence.suggested_episode_name != ep.case_name
            and len(evidence.suggested_episode_name) > len(ep.case_name)
        ):
            old_name = ep.case_name
            ep.case_name = evidence.suggested_episode_name
            ep._objective = evidence.objective
            log.info("engine.episode_renamed", old=old_name, new=ep.case_name)
        elif evidence.objective and not ep._objective:
            ep._objective = evidence.objective

        log.debug("engine.episode_continued", episode=ep.case_name)
        return EngineResult(active_episode=ep)

    def _handle_transition(self, evidence: ScreenshotEvidence) -> EngineResult:
        """
        First start_new_episode signal → move to transitioning state.
        Store the candidate name and wait for confirmation on the next cycle.
        """
        self._candidate_name = evidence.suggested_episode_name
        self._consecutive_new_episode = 1
        self._state = "transitioning"
        log.info("engine.transitioning", candidate=self._candidate_name, current=self.active.case_name)
        return EngineResult(active_episode=self.active)

    def _close_and_open(self, name: str, evidence: ScreenshotEvidence) -> EngineResult:
        """Auto-close current and open new episode (passive mode, 2-signal confirmed)."""
        closed = self.active
        closed.close()
        self._state = "idle"
        self.active = None
        self._consecutive_new_episode = 0
        self._candidate_name = ""
        result = self._open_episode(name, evidence)
        result.closed_episode = closed
        return result

    def _force_close(self, reason: str = "") -> Episode:
        ep = self.active
        # A differing observation awaiting confirmation still happened during
        # this episode's window — attach it before closing.
        if self._pending_observation is not None:
            ep.add_structured_observation(self._pending_observation)
            self._pending_observation = None
        ep.close()
        self.active = None
        self._state = "idle"
        self._consecutive_new_episode = 0
        self._candidate_name = ""
        log.info(
            "engine.episode_finalized",
            episode=ep.case_name,
            duration_min=round(ep.duration_minutes),
            evidence_count=len(ep._evidence),
            reason=reason or "",
        )
        return ep
