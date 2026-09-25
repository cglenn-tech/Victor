import type { NextRequest } from 'next/server'
import { getAdminClient } from '@/lib/supabase-admin'
import { getServerClient } from '@/lib/supabase-server'
import type { Episode, Observation } from '@/lib/types'
import { buildReport, reviewedEpisodes } from '@/lib/report'
import { periodBounds } from '@/lib/work-time'

export async function GET(request: NextRequest) {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  const periodStart = params.get("periodStart");
  const periodEnd = params.get("periodEnd");

  if (!id && (!periodStart || !periodEnd)) {
    return Response.json({ content: null });
  }

  const base = supabase
    .from("weekly_reports")
    .select("id, content, period_label, summary_json, created_at")
    .eq("user_id", user.id);

  const { data } = id
    ? await base.eq("id", id).limit(1).single()
    : await base
        .eq("period_start", periodStart!)
        .eq("period_end", periodEnd!)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

  return Response.json(data ?? { content: null });
}

export async function POST(request: Request) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  let periodStart: string, periodEnd: string, timeZone: string, roundTo15: boolean, bounds
  try {
    const body = await request.json()
    periodStart = body.periodStart ?? body.weekStart
    periodEnd = body.periodEnd ?? body.weekEnd
    timeZone = body.timeZone ?? 'UTC'
    roundTo15 = body.roundTo15 === true
    bounds = periodBounds(periodStart, periodEnd, timeZone)
  } catch {
    return Response.json({ error: 'Choose valid dates and a valid time zone' }, { status: 400 })
  }
  const episodes: Episode[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('episodes').select('*')
      .eq('user_id', user.id).is('deleted_at', null)
      .lt('started_at', bounds.end).gt('ended_at', bounds.start)
      .order('started_at', { ascending: true }).order('id').range(offset, offset + 999)
    if (error) return Response.json({ error: 'Unable to load work records' }, { status: 500 })
    episodes.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  if (!episodes.length) return Response.json({ error: 'no_episodes' }, { status: 422 })
  const observations: Observation[] = []
  // Owner-scoped admin query includes tombstones, so deleted text never falls back
  // to the old episode summary and deletions can be distinguished from pending sync.
  for (let offset = 0; offset < episodes.length; offset += 100) {
    for (let page = 0; ; page += 1000) {
      const { data: rows, error: obsError } = await getAdminClient().from('observations').select('*')
        .eq('user_id', user.id).in('episode_id', episodes.slice(offset, offset + 100).map(e => e.id))
        .order('observed_at', { ascending: true }).order('id').range(page, page + 999)
      if (obsError) return Response.json({ error: 'Unable to load reviewed observations' }, { status: 500 })
      observations.push(...(rows ?? []))
      if (!rows || rows.length < 1000) break
    }
  }
  const { ready, needsReview } = reviewedEpisodes(episodes, observations)
  // A report must never silently omit unreviewed work and appear complete.
  if (needsReview) return Response.json({ error: 'Review and approve the observations for this period before generating a report. Exclude unwanted work on the dashboard.', needsReview }, { status: 422 })
  if (!ready.length) return Response.json({ error: 'no_episodes' }, { status: 422 })
  const periodLabel = `${periodStart} – ${periodEnd}`
  const { report, summary } = buildReport(ready, periodLabel, timeZone, roundTo15, bounds)
  const { data: saved, error: saveError } = await supabase.from('weekly_reports').insert({
    user_id: user.id, week_start: periodStart, week_end: periodEnd,
    period_start: periodStart, period_end: periodEnd, period_label: periodLabel,
    source_episode_ids: ready.map(e => e.id), summary_json: summary,
    content: report, version: 1,
  }).select('id').single()
  if (saveError || !saved) return Response.json({ error: 'Your report could not be saved. Please try again.' }, { status: 500 })
  return Response.json({ report, id: saved.id })
}
