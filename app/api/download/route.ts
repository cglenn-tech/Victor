import { getServerClient } from '@/lib/supabase-server'
import { rateLimit } from '@/lib/rate-limit'

const MAC_DOWNLOAD_URL =
  process.env.MACOS_INSTALLER_URL ??
  'https://github.com/cglenn-tech/Victor/releases/latest/download/Victor-mac.dmg'

export async function POST() {
  const supabase = await getServerClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'authentication_required' }, { status: 401 })
  }

  if (!user.email_confirmed_at) {
    return Response.json({ error: 'email_verification_required' }, { status: 403 })
  }

  const limited = await rateLimit(`download:${user.id}`, 10, 3600)
  if (limited) {
    return Response.json({ error: 'too_many_requests' }, { status: 429 })
  }

  // The macOS beta is distributed directly from the latest GitHub release.
  // The workflow always uploads an unversioned Victor-mac.dmg asset so this
  // URL keeps working as new beta versions are published.
  return Response.json({
    url: MAC_DOWNLOAD_URL,
    version: process.env.MACOS_INSTALLER_VERSION ?? 'latest',
  })
}
