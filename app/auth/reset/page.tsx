import { Suspense } from 'react'
import ResetPasswordClient from '@/components/ResetPasswordClient'

export const dynamic = 'force-dynamic'

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
