import { getServerClient } from '@/lib/supabase-server'

// Demo seed: inserts a few mock observations so the console can be
// tested without the desktop agent. Only seeds when empty.

const MOCK_OBSERVATIONS = [
  {
    title: 'Drafting motion to compel — Peterson v. Ortega',
    summary:
      'Drafted the motion to compel further discovery responses, revised the argument section addressing the defendant\u2019s objections, and cited two supporting cases from last month\u2019s research.',
    activity_type: 'drafting',
    applications: ['Microsoft Word', 'Westlaw'],
    entities: ['Peterson v. Ortega'],
    minutes_ago: 20,
    screenshot_path: '/mock/obs-1.png',
  },
  {
    title: 'Reviewing discovery responses — Franklin audit',
    summary:
      'Reviewed the produced document batch (items 300\u2013420), flagged three emails with privilege concerns, and updated the review log with the flagged items.',
    activity_type: 'document_review',
    applications: ['Adobe Acrobat', 'Excel'],
    entities: ['Franklin Audit'],
    minutes_ago: 65,
    screenshot_path: '/mock/obs-2.png',
  },
  {
    title: 'Client call preparation — status update',
    summary:
      'Prepared the agenda and talking points for the client status call, summarized the current matter timeline, and queued three questions about settlement posture.',
    activity_type: 'client_communication',
    applications: ['Notes', 'Outlook'],
    entities: ['Peterson v. Ortega'],
    minutes_ago: 130,
    screenshot_path: '/mock/obs-3.png',
  },
]

export async function POST() {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { count } = await supabase
    .from('observations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)

  if ((count ?? 0) > 0) {
    return Response.json({ seeded: 0 })
  }

  const now = Date.now()
  const rows = MOCK_OBSERVATIONS.map((m) => {
    const observed = new Date(now - m.minutes_ago * 60_000).toISOString()
    return {
      user_id: user.id,
      observed_at: observed,
      start_time: observed,
      end_time: new Date(now - (m.minutes_ago - 5) * 60_000).toISOString(),
      screenshot_path: m.screenshot_path,
      title: m.title,
      summary: m.summary,
      activity_type: m.activity_type,
      applications: m.applications,
      entities: m.entities,
    }
  })

  const { error } = await supabase.from('observations').insert(rows)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ seeded: rows.length })
}
