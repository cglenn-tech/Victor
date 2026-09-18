import { redirect } from 'next/navigation'
import { getServerClient } from '@/lib/supabase-server'
import Link from 'next/link'

export default async function CallbackErrorPage() {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (user?.email) {
    redirect(`/verify?email=${encodeURIComponent(user.email)}&expired=true`)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="max-w-sm px-6 text-center">
        <p className="text-sm text-neutral-900 mb-2">
          This verification link has expired or was already used.
        </p>
        <p className="text-sm text-neutral-600 mb-4">
          If you already clicked it (or an email scanner did), your account may be verified — try signing in.
        </p>
        <Link href="/" className="text-sm text-neutral-900 underline">
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
