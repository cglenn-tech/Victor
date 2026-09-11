import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

// POST /api/auth/reset/confirm — explicit-click exchange for token_hash links.
// Recovery tokens ONLY: any other type (email|invite|email_change|magiclink)
// is rejected without touching Supabase, so this endpoint can never mint a
// session from a non-recovery link. GET is intentionally absent — the token
// is only consumed when the user clicks Continue on the interstitial.

const ALLOWED_TYPE = 'recovery'

export async function POST(request: NextRequest) {
  let body: { token_hash?: string; type?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { token_hash: tokenHash, type } = body

  if (!tokenHash || type !== ALLOWED_TYPE) {
    return Response.json(
      { error: 'This link is not a valid password reset link.' },
      { status: 400 },
    )
  }

  const t0 = Date.now()
  console.log('[reset-confirm] attempting recovery exchange', { t: t0 })

  const response = NextResponse.json({ ok: true })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: ALLOWED_TYPE,
  })

  if (error || !data.user) {
    console.error('[reset-confirm] exchange failed', {
      elapsed: Date.now() - t0,
      message: error?.message,
      status: error?.status,
    })
    // Clear, non-committal message; the client routes back to the forgot flow.
    return Response.json(
      { error: 'This password reset link is invalid or has expired.' },
      { status: 400 },
    )
  }

  console.log('[reset-confirm] recovery exchange succeeded', {
    elapsed: Date.now() - t0,
    user_id: data.user.id,
  })

  return response
}
