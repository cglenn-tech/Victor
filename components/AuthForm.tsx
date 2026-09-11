'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getBrowserClient } from '@/lib/supabase-browser'

type Mode = 'signup' | 'signin' | 'forgot'
type Stage = 'idle' | 'creating' | 'sending' | 'sent'

export default function AuthForm() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('signup')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [showSlowCreating, setShowSlowCreating] = useState(false)
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showPassword = mode !== 'forgot' && email.includes('@') && email.includes('.')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (stage !== 'idle') return
    setError('')

    if (mode === 'forgot') {
      setStage('sending')
      try {
        const res = await fetch('/api/auth/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })
        const body = await res.json().catch(() => ({}))
        if (res.status === 429) {
          setStage('idle')
          setError(body.error ?? 'Too many attempts. Please wait a moment and try again.')
          return
        }
        if (!res.ok) {
          setStage('idle')
          setError("We couldn't send the reset email. Please try again shortly.")
          return
        }
        setStage('sent')
      } catch {
        setStage('idle')
        setError("We couldn't send the reset email. Please try again shortly.")
      }
      return
    }

    const supabase = getBrowserClient()

    try {
      if (mode === 'signup') {
        setStage('creating')
        setShowSlowCreating(false)
        slowTimerRef.current = setTimeout(() => setShowSlowCreating(true), 8000)

        const t0 = Date.now()
        console.log('[signup] started', { email, t: t0 })

        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        })

        console.log('[signup] supabase responded', { elapsed: Date.now() - t0, error: signUpError?.message })

        if (slowTimerRef.current) {
          clearTimeout(slowTimerRef.current)
          slowTimerRef.current = null
        }

        if (signUpError) {
          console.error('[signup] error', {
            message: signUpError.message,
            name:    signUpError.name,
            status:  signUpError.status,
            code:    signUpError.code,
          })

          const msg = signUpError.message ?? ''

          if (msg.toLowerCase().includes('already registered') ||
              msg.toLowerCase().includes('user already registered')) {
            console.log('[signup] duplicate detected, attempting sign in to check verification status', { email })
            // Try signing in with the password they just entered.
            // If it succeeds the email is already verified — session just wasn't
            // set (common when the verification link was clicked on a different
            // device and the response cookies were lost).
            const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
            if (!signInError) {
              console.log('[signup] auto sign-in succeeded, already verified')
              router.refresh()
              return
            }
            if (signInError.message.toLowerCase().includes('email not confirmed')) {
              // Account exists but genuinely unverified — resend and go to verify
              console.log('[signup] account unverified, auto-resending', { email })
              fetch('/api/auth/resend', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
              }).catch(() => {})
              router.push(`/verify?email=${encodeURIComponent(email)}`)
              return
            }
            // Wrong password or other sign-in error — account exists, can't auto-recover
            setError('An account with this email already exists. Use "Sign in" to access it.')
            return
          } else if (signUpError.status === 429 || msg.toLowerCase().includes('rate')) {
            setError('Too many attempts. Please wait a moment and try again.')
          } else if (
            signUpError.status === 500 ||
            msg === '{}' ||
            msg === '' ||
            !msg
          ) {
            setError("We couldn't send the verification email. Please try again shortly.")
          } else {
            setError(msg)
          }
          return
        }

        if (data.user) {
          console.log('[signup] navigating to verify', { email })
          router.push(`/verify?email=${encodeURIComponent(email)}`)
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })

        if (signInError) {
          if (signInError.message.toLowerCase().includes('email not confirmed')) {
            router.push(`/verify?email=${encodeURIComponent(email)}`)
            return
          }
          setError('Invalid login credentials')
          return
        }

        router.refresh()
      }
    } finally {
      setStage('idle')
      setShowSlowCreating(false)
    }
  }

  const buttonText =
    stage === 'creating' ? 'Creating account…'
    : stage === 'sending' ? 'Sending…'
    : mode === 'forgot' ? 'Send reset link'
    : mode === 'signup' ? 'Continue'
    : 'Sign in'

  if (stage === 'sent') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="w-full max-w-sm px-6">
          <h1 className="text-lg font-semibold text-neutral-900 mb-6">VICTOR</h1>
          <p className="text-sm text-neutral-900 mb-2">
            If an account exists for {email}, a password reset link is on its way.
          </p>
          <p className="text-sm text-neutral-500 mb-6">
            The link expires shortly. Check your spam folder if you don’t see it.
          </p>
          <button
            onClick={() => { setMode('signin'); setStage('idle'); setError('') }}
            className="text-sm text-neutral-900 underline"
          >
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="w-full max-w-sm px-6">
        <h1 className="text-lg font-semibold text-neutral-900 mb-6">VICTOR</h1>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError('') }}
            required
            className="w-full border border-neutral-200 rounded px-3 py-2 text-sm outline-none focus:border-neutral-400"
          />

          {showPassword && (
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError('') }}
              required
              minLength={6}
              className="w-full border border-neutral-200 rounded px-3 py-2 text-sm outline-none focus:border-neutral-400"
            />
          )}

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <button
            type="submit"
            disabled={stage !== 'idle' || (mode === 'forgot' ? !email.includes('@') : !showPassword)}
            className="w-full bg-neutral-900 text-white rounded px-3 py-2 text-sm font-medium disabled:opacity-40"
          >
            {buttonText}
          </button>

          {mode === 'signin' && (
            <p className="text-sm">
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError('') }}
                className="text-neutral-500 underline hover:text-neutral-900"
              >
                Forgot password?
              </button>
            </p>
          )}

          {showSlowCreating && (
            <p className="text-sm text-neutral-500 mt-2">
              Still creating… this is taking a moment.
            </p>
          )}
        </form>

        <p className="mt-4 text-sm text-neutral-500">
          {mode === 'signup' ? (
            <>
              Already have an account?{' '}
              <button
                onClick={() => { setMode('signin'); setError('') }}
                className="text-neutral-900 underline"
              >
                Sign in
              </button>
            </>
          ) : mode === 'forgot' ? (
            <>
              Remembered it?{' '}
              <button
                onClick={() => { setMode('signin'); setError('') }}
                className="text-neutral-900 underline"
              >
                Back to sign in
              </button>
            </>
          ) : (
            <>
              New to VICTOR?{' '}
              <button
                onClick={() => { setMode('signup'); setError('') }}
                className="text-neutral-900 underline"
              >
                Sign up
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
