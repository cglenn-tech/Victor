'use client'

import { useEffect, useState } from 'react'
import { getBrowserClient } from '@/lib/supabase-browser'
import AgentStatusCard from './AgentStatusCard'
import DownloadButton from './DownloadButton'
import type { DeviceStatus } from '@/lib/agent-status'

type FetchState =
  | { status: 'loading' }
  | { status: 'no_device' }
  | { status: 'ready'; device: DeviceStatus }
  | { status: 'error' }

export default function DesktopAgentCard({ onDailyReview }: { onDailyReview?: () => void }) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'loading' })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const supabase = getBrowserClient()
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const { data, error } = await supabase.from('devices')
          .select('id, name, last_seen_at, app_version, recording_requested')
          .is('revoked_at', null)
          .order('last_seen_at', { ascending: false, nullsFirst: false })
          .order('activated_at', { ascending: false })
          .limit(1)
        if (cancelled) return
        if (error) setFetchState({ status: 'error' })
        else if (!data?.length) setFetchState({ status: 'no_device' })
        else setFetchState({ status: 'ready', device: data[0] as DeviceStatus })
      } catch {
        if (!cancelled) setFetchState({ status: 'error' })
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 5000)
      }
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [retry])

  if (fetchState.status === 'loading') {
    return (
      <div className="border border-neutral-200 rounded-xl p-5 mb-6">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full inline-block bg-neutral-200" />
          <span className="text-sm text-neutral-400">Connecting…</span>
        </div>
      </div>
    )
  }

  if (fetchState.status === 'error') {
    return <div className="border border-neutral-200 rounded-xl p-5 mb-6">
      <p role="alert" className="text-sm text-neutral-600 mb-3">Could not check your desktop connection. Your installation has not been checked yet.</p>
      <button onClick={() => setRetry((value) => value + 1)} className="text-sm border rounded px-3 py-1">Check again</button>
    </div>
  }

  if (fetchState.status === 'no_device') {
    return (
      <div className="border border-neutral-200 rounded-xl p-5 mb-6">
        <p className="text-sm text-neutral-600 mb-3">
          Install the VICTOR desktop app to start capturing your work.
          Start and stop work from your signed-in dashboard.
        </p>
        <button onClick={() => { window.location.href = 'victor://reconnect' }} className="text-sm border rounded px-3 py-2 mb-3">Already installed? Connect VICTOR</button>
        <DownloadButton />
      </div>
    )
  }

  return (
    <div>
      <AgentStatusCard key={fetchState.device.id} device={fetchState.device} onDailyReview={onDailyReview} />
      <p className="text-xs text-neutral-400 -mt-4 mb-6 px-1">
        Recording stops when you sign out, or after 10 minutes with no Victor page open.
      </p>
    </div>
  )
}
