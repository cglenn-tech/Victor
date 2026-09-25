'use client'

import { useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { getBrowserClient } from '@/lib/supabase-browser'
import DownloadButton from './DownloadButton'
import { hasRecentHeartbeat, isAgentState, needsAgentUpdate, type DeviceStatus } from '@/lib/agent-status'

type CardState =
  | 'connecting'      // subscribed to channel, waiting for agent presence (≤5 s)
  | 'offline'         // no agent in channel after 5 s, or channel error
  | 'connection_error'
  | 'unknown_version'
  | 'idle'            // agent present, not recording
  | 'recording'       // agent present, recording active
  | 'stopping'        // stop sent, waiting for agent confirmation
  | 'finalizing'      // agent finalizing episode
  | 'sync_pending'    // agent finished recording, syncing episode
  | 'update_required' // agent version below minimum required
  | 'error'           // unexpected failure

const STATE_LABELS: Record<CardState, string> = {
  connecting:      'Connecting to desktop app…',
  offline:         'Desktop app not connected',
  connection_error: 'Live connection unavailable',
  unknown_version: 'Waiting for the desktop app to identify itself',
  idle:            'Ready to start',
  recording:       'Recording',
  stopping:        'Stopping',
  finalizing:      'Finalizing',
  sync_pending:    'Sync pending',
  update_required: 'Update required',
  error:           'The desktop app reported a capture or analysis error',
}

const DOT_COLORS: Record<CardState, string> = {
  connecting:      'bg-neutral-300',
  offline:         'bg-neutral-300',
  connection_error: 'bg-yellow-400',
  unknown_version: 'bg-yellow-400',
  idle:            'bg-green-400',
  recording:       'bg-red-500 animate-pulse',
  stopping:        'bg-yellow-400',
  finalizing:      'bg-yellow-400',
  sync_pending:    'bg-yellow-400',
  update_required: 'bg-yellow-400',
  error:           'bg-red-400',
}

type BuildHarveyPresence = {
  type?: 'agent' | 'browser'
  version?: string
  state?: unknown
}

function isAgentPresence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return (value as BuildHarveyPresence).type === 'agent'
}

function getAgentPresence(presenceState: Record<string, unknown[]>): BuildHarveyPresence | undefined {
  for (const presences of Object.values(presenceState)) {
    for (const p of presences) {
      if (isAgentPresence(p)) {
        return p as BuildHarveyPresence
      }
    }
  }
  return undefined
}

type Props = { device: DeviceStatus; onDailyReview?: () => void }

export default function AgentStatusCard({ device, onDailyReview }: Props) {
  const deviceId = device.id
  const [error, setError] = useState<string | null>(null)
  const reviewRef = useRef(onDailyReview)
  useEffect(() => { reviewRef.current = onDailyReview }, [onDailyReview])
  const [state, setState] = useState<CardState>('connecting')
  const versionAllowed = useRef(false)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    versionAllowed.current = false
    setState('connecting')
    const supabase = getBrowserClient()
    const topic = `buildharvey:device:${deviceId}`

    const channel = supabase.channel(topic, {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: 'browser' },
        private: true,
      },
    })
    channelRef.current = channel

    // ── 5-second timeout: if no agent appears, show unavailable ──────────────
    timeoutRef.current = setTimeout(() => {
      setState((prev) => (prev === 'connecting' ? 'offline' : prev))
    }, 5000)

    function clearConnectingTimeout() {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }

    function handleAgentConnected(presenceState: Record<string, unknown[]>) {
      clearConnectingTimeout()
      const agent = getAgentPresence(presenceState)
      const version = agent?.version
      if (needsAgentUpdate(version)) {
        versionAllowed.current = false
        setState('update_required')
      } else if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
        versionAllowed.current = false
        setState('unknown_version')
      } else {
        versionAllowed.current = true
        // Presence already contains a status. Do not depend on a second message
        // arriving after subscription to recognize an already running desktop.
        const presenceStatus = agent?.state
        if (isAgentState(presenceStatus)) setState((previous) =>
          ['connecting', 'offline', 'connection_error', 'unknown_version', 'update_required'].includes(previous) ? presenceStatus : previous)
        // Ask agent for its current state
        channel.send({ type: 'broadcast', event: 'status_request', payload: {} })
      }
    }

    // ── Status broadcast from agent ───────────────────────────────────────────
    channel.on('broadcast', { event: 'status' }, ({ payload }) => {
      if (cancelled || !versionAllowed.current) return
      const agentState: string = payload?.state ?? ''
      if (agentState === 'connecting') {
        setState('connecting')
      } else if (agentState === 'recording') {
        clearConnectingTimeout()
        setState('recording')
      } else if (agentState === 'idle') {
        clearConnectingTimeout()
        setState('idle')
      } else if (agentState === 'stopping') {
        setState('stopping')
      } else if (agentState === 'finalizing') {
        setState('finalizing')
      } else if (agentState === 'error') {
        setState('error')
      } else if (agentState === 'sync_pending') {
        setState('sync_pending')
      }
    })

    channel.on('broadcast', { event: 'daily_review' }, () => reviewRef.current?.())

    // ── Presence: detect agent ────────────────────────────────────────────────
    channel.on('presence', { event: 'sync' }, () => {
      if (cancelled) return
      const presenceState = channel.presenceState()
      const agentPresent = Object.values(presenceState)
        .flat()
        .some(isAgentPresence)

      if (agentPresent) {
        handleAgentConnected(presenceState)
      } else {
        // Agent left or not yet joined
        versionAllowed.current = false
        setState((prev) => {
          if (prev === 'connecting') return prev  // still waiting
          return 'offline'
        })
      }
    })

    channel.on('presence', { event: 'join' }, ({ newPresences }) => {
      if (cancelled) return
      const agentJoined = newPresences.some(isAgentPresence)
      if (agentJoined) {
        handleAgentConnected(channel.presenceState())
      }
    })

    channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
      if (cancelled) return
      const agentLeft = leftPresences.some(isAgentPresence)
      if (agentLeft) {
        const presenceState = channel.presenceState()
        const agentStillPresent = Object.values(presenceState)
          .flat()
          .some(isAgentPresence)
        if (!agentStillPresent) {
          versionAllowed.current = false
          setState('offline')
        }
      }
    })

    // ── Subscribe ─────────────────────────────────────────────────────────────
    channel.subscribe(async (status) => {
      if (cancelled) return
      if (status === 'SUBSCRIBED') {
        await channel.track({ type: 'browser' })
        if (cancelled) return
        // Check if agent is already in the channel
        const presenceState = channel.presenceState()
        const agentPresent = Object.values(presenceState)
          .flat()
          .some(isAgentPresence)
        if (agentPresent) {
          handleAgentConnected(presenceState)
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearConnectingTimeout()
        versionAllowed.current = false
        setState('connection_error')
      }
    })

    return () => {
      cancelled = true
      clearConnectingTimeout()
      supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [deviceId, retry])

  async function command(action: 'start' | 'stop') {
    setError(null)
    try {
      const res = await fetch('/api/device/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, deviceId }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Unable to update session')
      setState(versionAllowed.current ? (action === 'start' ? 'connecting' : 'stopping') : 'connection_error')
      // HTTP has already saved the command. A failed optional broadcast must
      // not tell the user that their Start/Stop command failed.
      void channelRef.current?.send({ type: 'broadcast', event: action, payload: {} }).catch(() => {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update session')
    }
  }
  const sendStart = () => command('start')
  const sendStop = () => command('stop')

  const label = error ?? STATE_LABELS[state]
  const dotColor = DOT_COLORS[state]

  const connectionMissing = ['connecting', 'offline', 'connection_error', 'unknown_version'].includes(state)
  const heartbeatRecent = hasRecentHeartbeat(device)
  const updateRequired = state === 'update_required' || (connectionMissing && heartbeatRecent && needsAgentUpdate(device.app_version))

  if (!updateRequired && connectionMissing && heartbeatRecent && device.app_version && /^\d+\.\d+\.\d+$/.test(device.app_version)) {
    return <div className="border border-neutral-200 rounded-xl p-5 mb-6">
      <p className="text-sm font-medium text-neutral-700">Desktop app connected</p>
      <p className="text-sm text-neutral-600 mt-2 mb-3">{device.recording_requested ? 'Start requested. Waiting for live recording status from the app.' : 'The app has reached the server. Live recording status is currently unavailable.'}</p>
      {error && <p role="alert" className="text-sm text-red-600 mb-3">{error}</p>}
      {!device.recording_requested && <button onClick={sendStart} className="text-sm bg-neutral-900 text-white rounded px-4 py-2 mr-2">Start Work Session</button>}
      <button onClick={sendStop} className="text-sm border rounded px-4 py-2">Stop Work Session</button>
      <p className="text-xs text-neutral-400 mt-3">{device.name} · Victor {device.app_version}</p>
    </div>
  }

  if (!updateRequired && (state === 'offline' || state === 'connection_error' || state === 'unknown_version')) {
    return (
      <div className="border border-neutral-200 rounded-xl p-5 mb-6">
        <p className="text-sm font-medium text-neutral-700">{heartbeatRecent ? 'Desktop app reached the server; live status is unavailable.' : STATE_LABELS[state]}</p>
        <p className="text-sm text-neutral-600 mt-2">Open the installed VICTOR app in Applications. If it is already running, reconnect it to this account.</p>
        <p className="text-xs text-neutral-400 mt-2">{device.name}{device.last_seen_at ? ` · Last contact: ${new Date(device.last_seen_at).toLocaleString()}` : ' · No desktop heartbeat received yet'}</p>
        {error && <p role="alert" className="text-sm text-red-600 mt-2">{error}</p>}
        <div className="flex flex-col gap-2 mt-3">
          <button
            onClick={() => { window.location.href = 'victor://open' }}
            className="text-sm font-medium bg-neutral-900 text-white px-4 py-2 rounded
                       hover:bg-neutral-700 transition-colors"
          >
            Open VICTOR
          </button>
          <button onClick={() => { window.location.href = 'victor://reconnect' }} className="text-sm border rounded px-4 py-2">Reconnect account</button>
          <button onClick={() => setRetry((value) => value + 1)} className="text-sm underline">Check connection again</button>
          <button onClick={sendStop} className="text-sm underline">Stop Work Session</button>
        </div>
      </div>
    )
  }

  if (updateRequired) {
    return (
      <div className="border border-neutral-200 rounded-xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full inline-block ${dotColor}`} />
          <p className="text-sm font-medium text-neutral-700">Update required</p>
        </div>
        <p className="text-sm text-neutral-600 mb-3">
          This app version needs the desktop connection fix. Quit VICTOR before replacing it in Applications.
        </p>
        <DownloadButton label="Download Update" />
      </div>
    )
  }

  if (state === 'idle') {
    return (
      <div className="border border-neutral-200 rounded-xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full inline-block ${dotColor}`} />
          <p className="text-sm font-medium text-neutral-700">{label}</p>
        </div>
        {error && <p role="alert" className="text-sm text-red-600 mb-3">{error}</p>}
        <button
          onClick={sendStart}
          className="text-sm font-medium bg-neutral-900 text-white px-4 py-1.5 rounded
                     hover:bg-neutral-700 transition-colors"
        >
          Start Work Session
        </button>
      </div>
    )
  }

  if (state === 'recording') {
    return (
      <div className="border border-neutral-200 rounded-xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full inline-block ${dotColor}`} />
          <p className="text-sm font-medium text-neutral-700">{label}</p>
        </div>
        <button
          onClick={sendStop}
          className="text-sm text-neutral-600 border border-neutral-200 px-4 py-1.5 rounded
                     hover:bg-neutral-50 transition-colors"
        >
          Stop Work Session
        </button>
      </div>
    )
  }

  // Keep Stop available while analysis or syncing is failing.
  return (
    <div className="border border-neutral-200 rounded-xl p-5 mb-6">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full inline-block ${dotColor}`} />
        <p className="text-sm text-neutral-500">{label}</p>
      </div>
      {state !== 'connecting' && <button onClick={sendStop} className="text-sm border rounded px-3 py-1 mt-3">Stop Work Session</button>}
    </div>
  )
}
