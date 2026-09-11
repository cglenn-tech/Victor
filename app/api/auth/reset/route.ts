import type { NextRequest } from 'next/server'
import { getServerClient } from '@/lib/supabase-server'
import { rateLimit } from '@/lib/rate-limit'

// POST /api/auth/reset — request a password reset email.
// Mirrors /api/auth/resend: rate-limited per email, generic response so the
// caller cannot learn whether an account exists (Supabase's own response
// stays server-side; only rate-limit signals are surfaced to the client).

export async function POST(request: NextRequest) {
  let body: { email?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { email } = body
  if (!email) {
    return Response.json({ error: 'Missing email' }, { status: 400 })
  }

  const t0 = Date.now()
  console.log('[reset] requested', { email, t: t0 })

  const blocked = await rateLimit(`reset:${email.toLowerCase()}`, 3, 3600)
  if (blocked) {
    console.log('[reset] rate limited', { email })
    return Response.json(
      { error: 'Too many password resets requested. Please wait before trying again.' },
      { status: 429 },
    )
  }

  // Derive the redirect server-side from the request origin — never trust a
  // client-supplied redirect target. Supabase validates it against its own
  // Redirect URLs allow-list.
  const redirectTo = new URL('/auth/reset', request.url).toString()

  const supabase = await getServerClient()
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  const elapsed = Date.now() - t0

  if (error) {
    console.error('[reset] supabase error', { elapsed, message: error.message, status: error.status })

    // Rate-limit errors are safe to surface (they don't reveal account
    // existence). Everything else returns a generic success so we never
    // leak whether the email has an account.
    if (error.status === 429 || error.message.toLowerCase().includes('rate')) {
      return Response.json(
        { error: 'Too many password resets requested. Please wait before trying again.' },
        { status: 429 },
      )
    }
    return Response.json({ ok: true })
  }

  console.log('[reset] succeeded', { elapsed })
  return Response.json({ ok: true })
}
