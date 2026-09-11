import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { getAdminClient } from '@/lib/supabase-admin'

function confirmUrl(request: NextRequest, token_hash: string, type: string) {
  const url = new URL('/auth/confirm', request.url)
  url.searchParams.set('token_hash', token_hash)
  url.searchParams.set('type', type)
  return url
}

function errorRedirect(request: NextRequest, reason: string) {
  return NextResponse.redirect(new URL(`/auth/callback/error?reason=${reason}`, request.url))
}

async function verifyAndRedirect(request: NextRequest, token_hash: string, type: string) {
  const t0 = Date.now()
  console.log('[verify] OTP attempt', { type, has_token_hash: !!token_hash, t: t0 })

  // Only email-confirm styles are accepted from the mailer.
  if (type !== 'email' && type !== 'signup') {
    return errorRedirect(request, 'invalid')
  }

  const response = NextResponse.redirect(new URL('/', request.url))

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
    token_hash,
    type: type === 'signup' ? 'signup' : 'email',
  })

  if (error || !data.user) {
    console.error('[verify] OTP failed', { elapsed: Date.now() - t0, message: error?.message })
    const msg = (error?.message ?? '').toLowerCase()
    const reason = msg.includes('expired') || msg.includes('otp') ? 'expired' : 'invalid'
    return errorRedirect(request, reason)
  }

  console.log('[verify] OTP success', { elapsed: Date.now() - t0, user_id: data.user.id })

  const admin = getAdminClient()
  await admin.from('profiles').upsert({
    id: data.user.id,
    email: data.user.email!,
  })

  return response
}

/**
 * GET must NOT consume the OTP. Email scanners (Gmail Safe Links, etc.) prefetch
 * the URL and would burn a one-time token before the human clicks. Bounce them
 * to an interstitial that only verifies on an explicit POST.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type')

  console.log('[verify] callback GET (no consume)', { type, has_token_hash: !!token_hash })

  if (!token_hash || !type) {
    return errorRedirect(request, 'invalid')
  }

  return NextResponse.redirect(confirmUrl(request, token_hash, type))
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get('content-type') ?? ''
  let token_hash: string | null = null
  let type: string | null = null

  if (contentType.includes('application/json')) {
    try {
      const body = await request.json()
      token_hash = typeof body.token_hash === 'string' ? body.token_hash : null
      type = typeof body.type === 'string' ? body.type : null
    } catch {
      return errorRedirect(request, 'invalid')
    }
  } else {
    const form = await request.formData()
    const th = form.get('token_hash')
    const ty = form.get('type')
    token_hash = typeof th === 'string' ? th : null
    type = typeof ty === 'string' ? ty : null
  }

  if (!token_hash || !type) {
    return errorRedirect(request, 'invalid')
  }

  return verifyAndRedirect(request, token_hash, type)
}
