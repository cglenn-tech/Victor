"""
Victor macOS app entry point — headless tray daemon.

Runs as a menu-bar (tray) app with no Dock icon and no GUI window.
All user-facing UI lives on the Victor web app.

Startup flow:
  1. If no credential stored → call auth.activate() to register device and poll for approval.
  2. If screen recording permission not granted → show NSAlert + open System Settings.
  3. Launch the capture loop in a background thread.
  4. Register for macOS sleep/session-resign notifications → force-stop on sleep.

Menu bar icon:
  ⬛  idle
  🟢  recording
"""
import threading
from dotenv import load_dotenv
load_dotenv()

import config
from browser_open import open_url

import AppKit
import Foundation
import objc
import auth
import permissions
import realtime_client

# Apple Event constants for URL scheme handling
_kInternetEventClass = 0x4755524C  # 'GURL'
_kAEGetURL = 0x4755524C            # 'GURL'


class AppDelegate(AppKit.NSObject):

    _stop_event = objc.ivar()
    _agent_thread = objc.ivar()
    _status_item = objc.ivar()
    _label_item = objc.ivar()
    _connect_item = objc.ivar()
    _startup_lock = objc.ivar()
    _worker_lock = objc.ivar()
    _terminating = objc.ivar()
    _suspended = objc.ivar()

    def applicationDidFinishLaunching_(self, notification):
        # No Dock icon — pure menu-bar accessory
        AppKit.NSApp.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)

        # Register URL scheme handler for victor:// deep links (legacy buildharvey:// also supported)
        em = AppKit.NSAppleEventManager.sharedAppleEventManager()
        em.setEventHandler_andSelector_forEventClass_andEventID_(
            self,
            objc.selector(self.handleGetURL_withReplyEvent_, signature=b'v@:@@'),
            _kInternetEventClass,
            _kAEGetURL,
        )

        self._stop_event = threading.Event()
        self._agent_thread = None
        self._startup_lock = threading.Lock()
        self._worker_lock = threading.Lock()
        self._terminating = False
        self._suspended = False

        # ── Menu bar status item ───────────────────────────────────────────────
        status_bar = AppKit.NSStatusBar.systemStatusBar()
        self._status_item = status_bar.statusItemWithLength_(
            AppKit.NSVariableStatusItemLength
        )
        self._status_item.button().setTitle_("⬛")

        menu = AppKit.NSMenu.alloc().init()

        self._label_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "Victor: Idle", None, ""
        )
        menu.addItem_(self._label_item)
        menu.addItem_(AppKit.NSMenuItem.separatorItem())

        self._connect_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "Connect Account…", "connectAccount:", ""
        )
        self._connect_item.setTarget_(self)
        menu.addItem_(self._connect_item)

        disconnect_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "Disconnect Account", "disconnectAccount:", ""
        )
        disconnect_item.setTarget_(self)
        menu.addItem_(disconnect_item)
        menu.addItem_(AppKit.NSMenuItem.separatorItem())

        open_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "Open Dashboard", "openDashboard:", ""
        )
        open_item.setTarget_(self)
        menu.addItem_(open_item)
        menu.addItem_(AppKit.NSMenuItem.separatorItem())

        quit_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "Quit Victor", "terminate:", ""
        )
        menu.addItem_(quit_item)

        self._status_item.setMenu_(menu)

        # ── Sleep / session-resign / screen-lock notifications ────────────────
        nc = AppKit.NSWorkspace.sharedWorkspace().notificationCenter()
        nc.addObserver_selector_name_object_(
            self,
            objc.selector(self.workspaceSleep_, signature=b'v@:@'),
            AppKit.NSWorkspaceWillSleepNotification,
            None,
        )
        nc.addObserver_selector_name_object_(
            self,
            objc.selector(self.workspaceSessionResign_, signature=b'v@:@'),
            AppKit.NSWorkspaceSessionDidResignActiveNotification,
            None,
        )
        # Screen lock (separate from sleep): NSWorkspaceScreensDidSleepNotification
        nc.addObserver_selector_name_object_(
            self,
            objc.selector(self.workspaceScreenLocked_, signature=b'v@:@'),
            AppKit.NSWorkspaceScreensDidSleepNotification,
            None,
        )

        for name in (AppKit.NSWorkspaceDidWakeNotification,
                     AppKit.NSWorkspaceSessionDidBecomeActiveNotification,
                     AppKit.NSWorkspaceScreensDidWakeNotification):
            nc.addObserver_selector_name_object_(
                self, objc.selector(self.workspaceWake_, signature=b'v@:@'), name, None,
            )

        # ── Credential and permission check, then start ────────────────────────
        # Already signed in (device credential): open the web app/dashboard.
        # First-time install: auth.activate() opens the sign-in / activate URL.
        if auth.read_credential():
            open_url(config.BASE_URL)

        threading.Thread(target=self._startup, daemon=True).start()

    def openDashboard_(self, sender):
        open_url(config.BASE_URL)

    def workspaceSleep_(self, notification):
        self._on_security_boundary("device_locked")

    def workspaceSessionResign_(self, notification):
        self._on_security_boundary("user_logged_out")

    def workspaceScreenLocked_(self, notification):
        self._on_security_boundary("device_locked")

    def workspaceWake_(self, notification):
        self._suspended = False
        if auth.read_credential() and not self._terminating:
            threading.Thread(target=self._startup, daemon=True).start()

    def _on_security_boundary(self, reason: str) -> None:
        """
        Called at every security boundary crossing (sleep, lock, logout).
        Phase 1: invalidates all capture leases so re-consent is required on resume.
        Always stops the agent loop.
        """
        self._suspended = True
        self._emergency_stop()
        if config.ENABLE_CAPTURE_LEASES:
            # Notify the agent loop to invalidate leases via the shared event;
            # ConsentManager.invalidate_all() is called inside the agent loop
            # on next wake via the session epoch stored in SQLite.
            # We also set a flag so the next startup knows to show batch re-consent.
            conn = None
            try:
                import database
                conn = database.connect()
                conn.execute(
                    "INSERT INTO session_state (key, value) VALUES ('boundary_reason', ?)"
                    " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (reason,),
                )
                conn.commit()
            except Exception:
                pass
            finally:
                if conn is not None:
                    conn.close()

    def _emergency_stop(self):
        with self._worker_lock:
            realtime_client.force_stop()
            self._stop_event.set()

    def _get_display_name(self) -> str:
        try:
            import subprocess
            r = subprocess.run(
                ['scutil', '--get', 'ComputerName'],
                capture_output=True, text=True, timeout=3,
            )
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        except Exception:
            pass
        import platform
        return platform.node() or 'My Mac'

    def _startup(self):
        if not self._startup_lock.acquire(blocking=False):
            return
        try:
            if not self._terminating and not self._suspended:
                self._activate_and_start()
        finally:
            self._startup_lock.release()

    def _activate_and_start(self):
        """Run credential check, permission check, then start the agent."""
        # 1. Ensure credential
        if not auth.read_credential():
            device_name = self._get_display_name()
            AppKit.NSOperationQueue.mainQueue().addOperationWithBlock_(
                lambda: self._label_item.setTitle_("Victor: Connecting…")
            )
            print(f"[app] No credential — activating device '{device_name}'")
            token = auth.activate(device_name=device_name)
            if not token:
                print("[app] Activation failed or timed out")
                AppKit.NSOperationQueue.mainQueue().addOperationWithBlock_(
                    lambda: self._label_item.setTitle_("Victor: Not connected")
                )
                return
            auth.store_credential(token)

        # 2. Check screen recording permission (prompt if needed), but still
        # start the agent so the website can detect presence and leave the
        # download loop. Capture stays blocked until permission is granted.
        status = permissions.check()
        if status != 'GRANTED':
            AppKit.NSOperationQueue.mainQueue().addOperationWithBlock_(
                self._prompt_permissions
            )

        self.startAgent()

    def connectAccount_(self, sender):
        """Open dashboard if already signed in; otherwise start activation/sign-in."""
        if auth.read_credential():
            open_url(config.BASE_URL)
        threading.Thread(target=self._startup, daemon=True).start()

    def disconnectAccount_(self, sender):
        self._emergency_stop()
        threading.Thread(target=self._disconnect, daemon=True).start()

    def _disconnect(self):
        with self._startup_lock:
            auth.disconnect()
        self._on_agent_state('disconnected')

    def _reconnect(self):
        self._disconnect()
        self._startup()

    def handleGetURL_withReplyEvent_(self, event, replyEvent):
        """Handle buildharvey:// URL scheme events sent by macOS."""
        url_desc = event.paramDescriptorForKeyword_(0x2d2d2d2d)  # keyDirectObject
        if url_desc is None:
            return
        url_str = url_desc.stringValue()
        if not url_str:
            return
        normalized = url_str.replace('buildharvey://', 'victor://', 1)
        if normalized.startswith('victor://disconnect'):
            self.disconnectAccount_(None)
        elif normalized.startswith('victor://reconnect'):
            self._emergency_stop()
            threading.Thread(target=self._reconnect, daemon=True).start()
        elif normalized.startswith('victor://open'):
            threading.Thread(target=self._startup, daemon=True).start()

    def _prompt_permissions(self):
        alert = AppKit.NSAlert.alloc().init()
        alert.setMessageText_("Screen Recording Required")
        alert.setInformativeText_(
            "Victor needs Screen Recording permission to capture your work. "
            "Click OK to open System Settings."
        )
        alert.addButtonWithTitle_("OK")
        alert.addButtonWithTitle_("Quit")
        response = alert.runModal()
        if response == AppKit.NSAlertFirstButtonReturn:
            permissions.open_system_prefs()
            # After the user grants permission the app must be restarted
        else:
            AppKit.NSApp.terminate_(None)

    def startAgent(self):
        # This method runs on the startup thread, never on the UI thread.
        previous = self._agent_thread
        if previous and previous.is_alive():
            if not self._stop_event.is_set():
                return
            previous.join()  # finish saving the old account before a new worker
        with self._worker_lock:
            if self._terminating or self._suspended:
                return
            self._stop_event = threading.Event()
            self._agent_thread = threading.Thread(
                target=self._run_agent, args=(self._stop_event,), daemon=True,
            )
            self._agent_thread.start()

    def _run_agent(self, stop_event):
        import main as agent_main
        try:
            agent_main.main(state_callback=self._on_agent_state, stop_event=stop_event)
        except Exception:
            import traceback
            traceback.print_exc()
            self._on_agent_state('error')

    def applicationShouldTerminate_(self, app):
        self._terminating = True
        self._emergency_stop()
        worker = self._agent_thread
        if not worker or not worker.is_alive():
            return AppKit.NSTerminateNow

        def finish():
            worker.join()
            AppKit.NSOperationQueue.mainQueue().addOperationWithBlock_(
                lambda: app.replyToApplicationShouldTerminate_(True)
            )
        threading.Thread(target=finish, daemon=True).start()
        return AppKit.NSTerminateLater

    def _on_agent_state(self, state: str) -> None:
        """Called from main.py state_callback on the agent thread. Dispatches to main queue."""
        def update():
            if state == 'recording':
                self._status_item.button().setTitle_("🟢")
                self._label_item.setTitle_("Victor: Recording")
            else:
                self._status_item.button().setTitle_("⬛")
                labels = {
                    'connecting': 'Connecting…', 'error': 'Connection or analysis error',
                    'reconnect_required': 'Reconnect account', 'disconnected': 'Disconnected',
                }
                self._label_item.setTitle_("Victor: " + labels.get(state, 'Idle'))

        AppKit.NSOperationQueue.mainQueue().addOperationWithBlock_(update)

    def applicationShouldTerminateAfterLastWindowClosed_(self, app):
        return False


def main():
    app = AppKit.NSApplication.sharedApplication()
    delegate = AppDelegate.new()
    app.setDelegate_(delegate)
    app.run()


if __name__ == '__main__':
    import sys
    if '--self-test' in sys.argv:
        from self_test import run_self_test
        sys.exit(run_self_test())
    main()
