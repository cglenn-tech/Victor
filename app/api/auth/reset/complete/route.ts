import { getServerClient } from '@/lib/supabase-server'

// POST /api/auth/reset/complete — set the new password.
// Runs server-side against the recovery session's cookies:
//   - a session must exist (401 otherwise — this endpoint never
//     authenticates a bare visitor)
//   - password rules enforced here (empty / short / mismatched never
//     reach Supabase, never reach a success response)
//   - Supabase's real error is surfaced verbatim (weak password, HIBP
//     breach rejection) instead of being swallowed
//   - on success every OTHER session is revoked so a stolen refresh
//     token dies with the old password; the current browser stays signed in.
const MIN_PASSWORD_LENGTH = 6

export async function POST(request: Request) {
  let body: { password?: string; confirmPassword?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { password, confirmPassword } = body

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json(
      { error: 'Your reset session expired. Please request a new reset link.' },
      { status: 401 },
    )
  }

  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return Response.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
      { status: 400 },
    )
  }
  if (password !== confirmPassword) {
    return Response.json({ error: 'Passwords do not match.' }, { status: 400 })
  }

  const t0 = Date.now()
  const { error: updateError } = await supabase.auth.updateUser({ password })

  if (updateError) {
    console.error('[reset-complete] updateUser failed', {
      elapsed: Date.now() - t0,
      message: updateError.message,
      status: updateError.status,
    })
    // Surface the real reason (weak password, breached password, etc.)
    return Response.json(
      { error: updateError.message },
      { status: updateError.status === 422 ? 422 : 400 },
    )
  }

  console.log('[reset-complete] password updated', {
    elapsed: Date.now() - t0,
    user_id: user.id,
  })

  // Revoke every session except this browser's.
  const { error: signOutError } = await supabase.auth.signOut({ scope: 'others' })
  if (signOutError) {
    // Password change succeeded — the old password is dead everywhere. Log
    // loudly so ops sees the revocation didn't complete.
    console.error('[reset-complete] signOut(others) failed', {
      message: signOutError.message,
      user_id: user.id,
    })
  } else {
    console.log('[reset-complete] other sessions revoked', { user_id: user.id })
  }

  return Response.json({ ok: true, sessionsRevoked: !signOutError })
}
