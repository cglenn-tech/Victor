import { getServerClient } from '@/lib/supabase-server'
import { getAdminClient } from '@/lib/supabase-admin'

export async function POST(request: Request) {
  const client = await getServerClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!body || typeof body.keep_id !== 'string' || typeof body.drop_id !== 'string' || body.keep_id === body.drop_id) return Response.json({ error: 'Choose two different entries' }, { status: 400 })
  const { data, error } = await getAdminClient().rpc('merge_work_episodes', { p_user_id: user.id, p_keep: body.keep_id, p_drop: body.drop_id })
  if (error) return Response.json({ error: error.code === '22023' ? 'Resolve overlapping time before merging' : 'Unable to merge entries' }, { status: error.code === '42501' ? 403 : error.code === '22023' ? 400 : 500 })
  return Response.json({ ok: true, episode: data })
}
