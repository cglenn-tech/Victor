"""Consent lasts only for the work session explicitly started on Victor's site.

macOS Screen Recording permission remains mandatory. Capture remains scoped to
the foreground window; Start authorizes that scope for this session. No leases
survive Stop, a failed server lease check, lock, sign-out, or a process restart.
"""
class SessionConsentManager:
    def __init__(self, _conn=None):
        self.session_epoch = 0
        self.active = False

    def begin_session(self):
        self.session_epoch += 1
        self.active = True

    def end_session(self):
        self.active = False
        self.session_epoch += 1

    def is_authorized(self, identity):
        return bool(self.active and identity and identity.window_id and identity.owner_pid and
                    identity.session_epoch == self.session_epoch)
