import { Suspense } from 'react'
import ResetPasswordClient from '@/components/ResetPasswordClient'

export const dynamic = 'force-dynamic'

// The recovery token lives in this page's query string — never leak it via
// Referer to anything this page links out to.
export const metadata = { referrer: 'no-referrer' }

// Server shell — the client component reads searchParams inside Suspense.
// GET never consumes the recovery token; consumption happens only on the
// user's explicit click inside ResetPasswordClient.
export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordClient />
    </Suspense>
  )
}
