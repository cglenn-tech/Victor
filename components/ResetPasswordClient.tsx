'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getBrowserClient } from '@/lib/supabase-browser'

type Stage =
  | 'checking'   // deciding whether this visitor may reset
  | 'confirm'    // interstitial — token NOT consumed until Continue
  | 'form'       // recovery proven — may set a new password
  | 'pkce-error' // PKCE code failed — wrong browser, not a bad password
  | 'invalid'    // bad/expired/reused link
  | 'signed-in'  // already has a normal session, no recovery token
  | 'done'

// Recovery links arrive as ?token_hash=...&type=recovery (the template's
// preferred shape — works cross-device) or ?code=... (PKCE, same-browser
// only). The token is consumed ONLY when the user clicks Continue —
// GET renders, prefetches, and interstitial reloads never exchange it.
export default function ResetPasswordClient() {
  const router = useRouter()
  const params = useSearchParams()
  const code = params.get('code')
  const tokenHash = params.get('token_hash')
  const tokenType = params.get('type')

  const [stage, setStage] = useState<Stage>(() => {
    if (code) return 'confirm'
    if (tokenHash && tokenType === 'recovery') return 'confirm'
    if (tokenHash) return 'invalid'
    return 'checking'
  })
  const [exchanging, setExchanging] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // A visitor with a normal session and NO recovery token has nothing to do
  // here — never offer set-password on this page in that case.
  useEffect(() => {
    if (stage !== 'checking') return
    let active = true
    getBrowserClient()
      .auth.getSession()
      .then(({ data: { session } }) => {
        if (!active) return
        setStage(session ? 'signed-in' : 'invalid')
      })
      .catch(() => active && setStage('invalid'))
    return () => {
      active = false
    }
  }, [stage])

  function stripTokenFromUrl() {
    // The token must never appear in Referer, logs, or analytics.
    window.history.replaceState({}, '', '/auth/reset')
  }

  async function handleContinue() {
    if (exchanging) return
    setExchanging(true)
    setError('')
    try {
      if (code) {
        // PKCE exchange — only works in the browser that requested the reset.
        const supabase = getBrowserClient()
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        if (error) {
          console.error('[reset] PKCE exchange failed', { message: error.message })
          setStage('pkce-error')
          return
        }
      } else {
        // Recovery token — exchanged server-side; only type=recovery is
        // ever accepted by the endpoint.
        const res = await fetch('/api/auth/reset/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token_hash: tokenHash, type: 'recovery' }),
        })
        if (!res.ok) {
          setStage('invalid')
          return
        }
      }
      stripTokenFromUrl()
      setStage('form')
    } finally {
      setExchanging(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    setError('')

    // Fast client-side feedback; the server enforces the same rules again.
    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSaving(true)
    try {
      const res = await fetch('/api/auth/reset/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, confirmPassword }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Surface the real reason (weak/breached password etc.), never a
        // generic success-looking failure.
        setError(body.error ?? 'We couldn\u2019t update your password. Please try again.')
        return
      }
      setStage('done')
      router.refresh()
      router.push('/')
    } catch {
      setError('We couldn\u2019t update your password. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="w-full max-w-sm px-6">
        <h1 className="text-lg font-semibold text-neutral-900 mb-6">VICTOR</h1>

        {stage === 'checking' && (
          <p className="text-sm text-neutral-500">Checking your reset link…</p>
        )}

        {stage === 'signed-in' && (
          <div>
            <p className="text-sm text-neutral-900 mb-2">
              You&apos;re already signed in.
            </p>
            <p className="text-sm text-neutral-500 mb-6">
              Password resets happen from the sign-in page — use &quot;Forgot
              password?&quot; there after signing out, or continue to the app.
            </p>
            <Link href="/" className="text-sm text-neutral-900 underline">
              Go to VICTOR
            </Link>
          </div>
        )}

        {stage === 'invalid' && (
          <div>
            <p className="text-sm text-neutral-900 mb-2">
              This password reset link is invalid or has expired.
            </p>
            <p className="text-sm text-neutral-500 mb-6">
              Request a new one from the sign-in page.
            </p>
            <Link href="/" className="text-sm text-neutral-900 underline">
              Back to sign in
            </Link>
          </div>
        )}

        {stage === 'pkce-error' && (
          <div>
            <p className="text-sm text-neutral-900 mb-2">
              This reset link was opened in a different browser than the one
              that requested it.
            </p>
            <p className="text-sm text-neutral-500 mb-6">
              Secure reset links can only be finished in the browser they were
              requested from. Request a new link and open it in that browser.
            </p>
            <Link href="/" className="text-sm text-neutral-900 underline">
              Back to sign in
            </Link>
          </div>
        )}

        {stage === 'confirm' && (
          <div>
            <p className="text-sm font-medium text-neutral-900 mb-2">
              Reset your password
            </p>
            <p className="text-sm text-neutral-600 mb-6">
              Click below to continue. This step stops automatic email scanners
              from using your link. Reloading this page is safe — the link is
              only used when you click.
            </p>
            <button
              onClick={handleContinue}
              disabled={exchanging}
              className="w-full bg-neutral-900 text-white rounded px-3 py-2 text-sm font-medium disabled:opacity-40"
            >
              {exchanging ? 'Checking link…' : 'Continue'}
            </button>
          </div>
        )}

        {stage === 'form' && (
          <form onSubmit={handleSave} className="space-y-3">
            <p className="text-sm text-neutral-600 mb-2">Set a new password.</p>
            <input
              type="password"
              placeholder="New password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError('') }}
              required
              minLength={6}
              autoFocus
              className="w-full border border-neutral-200 rounded px-3 py-2 text-sm outline-none focus:border-neutral-400"
            />
            <input
              type="password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setError('') }}
              required
              minLength={6}
              className="w-full border border-neutral-200 rounded px-3 py-2 text-sm outline-none focus:border-neutral-400"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={saving}
              className="w-full bg-neutral-900 text-white rounded px-3 py-2 text-sm font-medium disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Update password'}
            </button>
          </form>
        )}

        {stage === 'done' && (
          <div>
            <p className="text-sm text-neutral-900 mb-2">
              Your password has been updated and other devices were signed out.
              You&apos;re signed in here.
            </p>
            <button
              onClick={() => { router.refresh(); router.push('/') }}
              className="text-sm text-neutral-900 underline"
            >
              Go to VICTOR
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
