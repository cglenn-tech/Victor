'use client'

import { useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { getBrowserClient } from '@/lib/supabase-browser'
import DownloadButton from './DownloadButton'

type CardState =
  | 'connecting'      // subscribed to channel, waiting for agent presence (≤5 s)
  | 'offline'         // no agent in channel after 5 s, or channel error
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
  idle:            'Ready to start',
  recording:       'Recording',
  stopping:        'Stopping',
  finalizing:      'Finalizing',
  sync_pending:    'Sync pending',
  update_required: 'Update required',
  error:           'Analysis unavailable — check the vision service',
}

const DOT_COLORS: Record<CardState, string> = {
  connecting:      'bg-neutral-300',
  offline:         'bg-neutral-300',
  idle:            'bg-green-400',
  recording:       'bg-red-500 animate-pulse',
  stopping:        'bg-yellow-400',
  finalizing:      'bg-yellow-400',
  sync_pending:    'bg-yellow-400',
  update_required: 'bg-yellow-400',
  error:           'bg-red-400',
}

const MIN_VERSION = process.env.NEXT_PUBLIC_MIN_AGENT_VERSION ?? '1.1.0'

function semverLessThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false
  }
  return false
}

type BuildHarveyPresence = {
  type?: 'agent' | 'browser'
  version?: string
}

function isAgentPresence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return (value as BuildHarveyPresence).type === 'agent'
}

function getAgentVersion(presenceState: Record<string, unknown[]>): string | undefined {
  for (const presences of Object.values(presenceState)) {
    for (const p of presences) {
      if (isAgentPresence(p)) {
        return (p as BuildHarveyPresence).version
      }
    }
  }
  return undefined
}

type Props = { deviceId: string; onDailyReview?: () => void }

export default function AgentStatusCard({ deviceId, onDailyReview }: Props) {
  const [error, setError] = useState<string | null>(null)
  const reviewRef = useRef(onDailyReview)
  useEffect(() => { reviewRef.current = onDailyReview }, [onDailyReview])
  const [state, setState] = useState<CardState>('connecting')
  const versionAllowed = useRef(false)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
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
      const version = getAgentVersion(presenceState)
      if (!version || !/^\d+\.\d+\.\d+$/.test(version) || semverLessThan(version, MIN_VERSION)) {
        versionAllowed.current = false
        setState('update_required')
      } else {
        versionAllowed.current = true
        // Ask agent for its current state
        channel.send({ type: 'broadcast', event: 'status_request', payload: {} })
      }
    }

    // ── Status broadcast from agent ───────────────────────────────────────────
    channel.on('broadcast', { event: 'status' }, ({ payload }) => {
      if (!versionAllowed.current) return
      const agentState: string = payload?.state ?? ''
      if (agentState === 'recording') {
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
      const presenceState = channel.presenceState()
      const agentPresent = Object.values(presenceState)
        .flat()
        .some(isAgentPresence)

      if (agentPresent) {
        handleAgentConnected(presenceState)
      } else {
        // Agent left or not yet joined
        setState((prev) => {
          if (prev === 'connecting') return prev  // still waiting
          return 'offline'
        })
      }
    })

    channel.on('presence', { event: 'join' }, ({ newPresences }) => {
      const agentJoined = newPresences.some(isAgentPresence)
      if (agentJoined) {
        handleAgentConnected(channel.presenceState())
      }
    })

    channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
      const agentLeft = leftPresences.some(isAgentPresence)
      if (agentLeft) {
        const presenceState = channel.presenceState()
        const agentStillPresent = Object.values(presenceState)
          .flat()
          .some(isAgentPresence)
        if (!agentStillPresent) {
          setState('offline')
        }
      }
    })

    // ── Subscribe ─────────────────────────────────────────────────────────────
    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ type: 'browser' })
        // Check if agent is already in the channel
        const presenceState = channel.presenceState()
        const agentPresent = Object.values(presenceState)
          .flat()
          .some(isAgentPresence)
        if (agentPresent) {
          handleAgentConnected(presenceState)
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearConnectingTimeout()
        setState('error')
      }
    })

    return () => {
      clearConnectingTimeout()
      supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [deviceId])

  async function command(action: 'start' | 'stop') {
    setError(null)
    try {
      const res = await fetch('/api/device/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, deviceId }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Unable to update session')
      setState(action === 'start' ? 'connecting' : 'stopping')
      await channelRef.current?.send({ type: 'broadcast', event: action, payload: {} })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update session')
    }
  }
  const sendStart = () => command('start')
  const sendStop = () => command('stop')

  const label = error ?? STATE_LABELS[state]
  const dotColor = DOT_COLORS[state]

  if (state === 'offline') {
    return (
      <div className="border border-neutral-200 rounded-xl p-5 mb-6">
        <p className="text-sm font-medium text-neutral-500">Previously connected, but currently offline.</p>
        <div className="flex flex-col gap-2 mt-3">
          <button
            onClick={() => { window.location.href = 'victor://open' }}
            className="text-sm font-medium bg-neutral-900 text-white px-4 py-2 rounded
                       hover:bg-neutral-700 transition-colors"
          >
            Open VICTOR
          </button>
          <DownloadButton label="Download Latest" />
        </div>
      </div>
    )
  }

  if (state === 'update_required') {
    return (
      <div className="border border-neutral-200 rounded-xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full inline-block ${dotColor}`} />
          <p className="text-sm font-medium text-neutral-700">{label}</p>
        </div>
        <p className="text-sm text-neutral-600 mb-3">
          A newer version of VICTOR is required.
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
