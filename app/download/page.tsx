import { redirect } from 'next/navigation'
import { getServerClient } from '@/lib/supabase-server'
import DownloadButton from '@/components/DownloadButton'
import DownloadFocusRecheck from '@/components/DownloadFocusRecheck'

export const dynamic = 'force-dynamic'

export default async function DownloadPage() {
  const supabase = await getServerClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    redirect('/')
  }

  if (!user.email_confirmed_at) {
    redirect(`/verify?email=${encodeURIComponent(user.email ?? '')}`)
  }

  // If this account already has a linked desktop device, leave the download
  // loop and go to the dashboard. DownloadFocusRecheck relies on this.
  const { data: devices } = await supabase
    .from('devices')
    .select('id')
    .is('revoked_at', null)
    .limit(1)

  if (devices && devices.length > 0) {
    redirect('/')
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">Download VICTOR</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Install the desktop agent to start capturing your work automatically.
          </p>
        </div>
        <DownloadButton />
        <DownloadFocusRecheck />
      </div>
    </main>
  )
}
