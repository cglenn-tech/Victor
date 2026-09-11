'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getBrowserClient } from '@/lib/supabase-browser'

type Stage = 'confirm' | 'form' | 'invalid' | 'done'

// Recovery links arrive as either ?code=... (PKCE, the default flow) or
// ?token_hash=...&type=recovery. The link is only consumed when the user
// clicks "Continue" — email scanners that prefetch the GET render can
// therefore never burn the one-time token.
export default function ResetPasswordClient() {
  const router = useRouter()
  const params = useSearchParams()
  const code = params.get('code')
  const tokenHash = params.get('token_hash')
  const tokenType = params.get('type')

  const [stage, setStage] = useState<Stage>(
    code || (tokenHash && tokenType === 'recovery') ? 'confirm' : 'invalid'
  )
  const [exchanging, setExchanging] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleContinue() {
    if (exchanging) return
    setExchanging(true)
    setError('')
    const supabase = getBrowserClient()
    try {
      const { error } = code
        ? await supabase.auth.exchangeCodeForSession(code)
        : await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: 'recovery' })
      if (error) {
        console.error('[reset] exchange failed', { message: error.message })
        setStage('invalid')
        return
      }
      setStage('form')
    } finally {
      setExchanging(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    setError('')

    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSaving(true)
    const supabase = getBrowserClient()
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) {
        setError(updateError.message)
        return
      }
      setStage('done')
      // Session is established by the recovery exchange — go to the app.
      router.refresh()
      router.push('/')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="w-full max-w-sm px-6">
        <h1 className="text-lg font-semibold text-neutral-900 mb-6">VICTOR</h1>

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

        {stage === 'confirm' && (
          <div>
            <p className="text-sm font-medium text-neutral-900 mb-2">
              Reset your password
            </p>
            <p className="text-sm text-neutral-600 mb-6">
              Click below to continue. This step stops automatic email scanners
              from using your link.
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
              Your password has been updated. You&apos;re signed in.
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
