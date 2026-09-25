'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getBrowserClient } from '@/lib/supabase-browser'

export default function AppNav() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const heartbeat = () => { void fetch('/api/device/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'heartbeat' }) }).catch(() => {}) }
    heartbeat()
    const timer = setInterval(heartbeat, 60_000)
    return () => clearInterval(timer)
  }, [])

  async function signOut() {
    const supabase = getBrowserClient()
    setError(null)
    try {
      const stopped = await fetch('/api/device/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) })
      if (!stopped.ok) throw new Error('Could not stop the desktop session. Please retry sign out.')
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign out')
      return
    }
    router.push('/')
  }

  return (
    <nav className="border-b border-neutral-100 mb-8">
      <div className="max-w-2xl mx-auto px-6 py-4 flex items-center justify-between">
        <Link href="/" className="text-sm font-semibold text-neutral-900">
          VICTOR
        </Link>
        <div className="flex items-center gap-6">
          <Link
            href="/observations"
            className="text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
          >
            Observations
          </Link>
          <Link
            href="/files"
            className="text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
          >
            My Files
          </Link>
          <button
            onClick={signOut}
            className="text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-red-600 px-6 pb-3">{error}</p>}
    </nav>
  )
}
