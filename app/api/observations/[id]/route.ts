import { getServerClient } from '@/lib/supabase-server'
import { getAdminClient } from '@/lib/supabase-admin'
import type { Observation } from '@/lib/types'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // RLS ensures user can only delete their own observations
  const { error } = await supabase.from('observations').update({ deleted_at: new Date().toISOString(), is_approved: false }).eq('id', id).eq('user_id', user.id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return new Response(null, { status: 204 })
}

const PATCHABLE = ['title', 'summary', 'is_approved'] as const

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = getAdminClient()

  // Verify ownership
  const { data: existing, error: lookupErr } = await admin
    .from('observations')
    .select('id, user_id')
    .is('deleted_at', null)
    .eq('id', id)
    .single()

  if (lookupErr || !existing) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  if (existing.user_id !== user.id) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!body || typeof body !== 'object' ||
      ('title' in body && (typeof body.title !== 'string' || body.title.length > 500)) ||
      ('summary' in body && (typeof body.summary !== 'string' || !body.summary.trim() || body.summary.length > 10000)) ||
      ('is_approved' in body && typeof body.is_approved !== 'boolean')) {
    return Response.json({ error: 'Invalid edit' }, { status: 400 })
  }
  const patch: Record<string, unknown> = {}
  let textEdited = false
  for (const key of PATCHABLE) {
    if (key in body) {
      patch[key] = body[key]
      if (key === 'title' || key === 'summary') textEdited = true
    }
  }
  if (textEdited) {
    patch.edited_at = new Date().toISOString()
    patch.is_approved = body.is_approved === true
  }

  const { data, error } = await admin
    .from('observations')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .select('*')
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ observation: data as Observation })
}
