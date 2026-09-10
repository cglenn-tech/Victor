import { redirect } from 'next/navigation'
import { getServerClient } from '@/lib/supabase-server'
import type { Observation } from '@/lib/types'
import ObservationsClient from '@/components/ObservationsClient'
import AuthForm from '@/components/AuthForm'
import AppNav from '@/components/AppNav'

export const dynamic = 'force-dynamic'

export default async function ObservationsPage() {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return <AuthForm />
  }

  if (!user.email_confirmed_at) {
    redirect(`/verify?email=${encodeURIComponent(user.email ?? '')}`)
  }

  const { data } = await supabase
    .from('observations')
    .select('*')
    .eq('user_id', user.id)
    .order('observed_at', { ascending: false })

  const observations = (data as Observation[]) ?? []

  return (
    <>
      <AppNav />
      <main className="max-w-2xl mx-auto px-6 py-10">
        <p className="text-sm text-neutral-500 mb-8">
          Observations from your work sessions, newest first. Approve, edit, or delete —
          approved observations feed your weekly report.
        </p>
        <ObservationsClient observations={observations} />
      </main>
    </>
  )
}
