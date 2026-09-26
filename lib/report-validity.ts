import { getAdminClient } from '@/lib/supabase-admin'

export async function reportIsCurrent(userId: string, report: { source_episode_ids?: string[] | null; created_at: string }): Promise<boolean> {
  const ids = [...new Set(report.source_episode_ids ?? [])]
  if (!ids.length) return false
  const { data, error } = await getAdminClient().from('episodes')
    .select('id, is_reportable, deleted_at, edited_at').eq('user_id', userId).in('id', ids)
  if (error || data?.length !== ids.length) return false
  return data.every(ep => !ep.deleted_at && ep.is_reportable !== false &&
    (!ep.edited_at || Date.parse(ep.edited_at) <= Date.parse(report.created_at)))
}
