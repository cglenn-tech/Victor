'use client'

import { useState } from 'react'
import type { Observation } from '@/lib/types'

type DayGroup = {
  label: string
  date: string
  observations: Observation[]
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function dayLabel(dateKey: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (dateKey === today) return 'Today'
  if (dateKey === yesterday) return 'Yesterday'
  return new Date(dateKey + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function fmtTime(iso?: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function groupByDay(observations: Observation[]): DayGroup[] {
  const byDay = new Map<string, Observation[]>()
  for (const o of observations) {
    const key = dayKey(o.observed_at)
    const list = byDay.get(key) ?? []
    list.push(o)
    byDay.set(key, list)
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, obs]) => ({ label: dayLabel(date), date, observations: obs }))
}

function ObservationRow({
  observation,
  onUpdate,
  onDelete,
}: {
  observation: Observation
  onUpdate: (id: string, patch: Partial<Observation>) => void
  onDelete: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState(observation.title ?? '')
  const [summary, setSummary] = useState(observation.summary)

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/observations/${observation.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, summary }),
      })
      if (res.ok) {
        onUpdate(observation.id, { title, summary })
        setEditing(false)
      }
    } finally {
      setSaving(false)
    }
  }

  async function toggleApprove() {
    const next = !observation.is_approved
    onUpdate(observation.id, { is_approved: next })
    const res = await fetch(`/api/observations/${observation.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_approved: next }),
    })
    if (!res.ok) onUpdate(observation.id, { is_approved: !next })
  }

  async function remove() {
    if (!deleting) {
      setDeleting(true)
      return
    }
    setDeleting(true)
    const res = await fetch(`/api/observations/${observation.id}`, { method: 'DELETE' })
    if (res.ok) onDelete(observation.id)
  }

  return (
    <div className="border border-neutral-100 rounded-lg p-4 flex gap-4">
      <div className="w-40 shrink-0">
        {observation.screenshot_path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={observation.screenshot_path}
            alt="Observation screenshot"
            className={`w-40 rounded border border-neutral-200 cursor-pointer ${
              expanded ? '' : 'h-24 object-cover'
            }`}
            onClick={() => setExpanded(!expanded)}
          />
        ) : (
          <div className="w-40 h-24 rounded border border-neutral-200 bg-neutral-50 flex items-center justify-center text-xs text-neutral-400">
            No screenshot
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {editing ? (
              <input
                className="w-full text-sm font-medium border border-neutral-200 rounded px-2 py-1 mb-2"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
              />
            ) : (
              <p className="text-sm font-medium text-neutral-900 truncate">
                {observation.title || <span className="text-neutral-400">Untitled</span>}
              </p>
            )}
            <p className="text-xs text-neutral-400 mt-0.5">
              {fmtTime(observation.start_time ?? observation.observed_at)}
              {observation.end_time ? `–${fmtTime(observation.end_time)}` : ''}
              {observation.activity_type ? ` · ${observation.activity_type}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {observation.is_approved && (
              <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">
                Approved
              </span>
            )}
            {observation.edited_at && (
              <span className="text-xs text-neutral-400">edited</span>
            )}
            <button
              onClick={toggleApprove}
              className={`text-xs border rounded px-2 py-1 transition-colors ${
                observation.is_approved
                  ? 'text-neutral-500 border-neutral-200 hover:text-neutral-900'
                  : 'text-green-700 border-green-200 hover:bg-green-50'
              }`}
            >
              {observation.is_approved ? 'Unapprove' : 'Approve'}
            </button>
            {!editing && (
              <button
                onClick={() => {
                  setTitle(observation.title ?? '')
                  setSummary(observation.summary)
                  setEditing(true)
                }}
                className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors"
              >
                Edit
              </button>
            )}
            <button
              onClick={remove}
              className={`text-xs transition-colors ${
                deleting ? 'text-red-600' : 'text-neutral-500 hover:text-neutral-900'
              }`}
            >
              {deleting ? 'Confirm?' : 'Delete'}
            </button>
          </div>
        </div>

        {editing ? (
          <div className="mt-2">
            <textarea
              className="w-full text-sm border border-neutral-200 rounded px-2 py-1.5"
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
            <div className="flex gap-3 mt-2">
              <button
                onClick={save}
                disabled={saving}
                className="text-xs bg-neutral-900 text-white rounded px-3 py-1.5 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="text-xs text-neutral-500 hover:text-neutral-900"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-neutral-600 mt-2 whitespace-pre-wrap">{summary}</p>
        )}

        {expanded && (
          <div className="mt-3 text-xs text-neutral-500 flex flex-wrap gap-x-4 gap-y-1">
            {observation.applications?.length ? (
              <span>Apps: {observation.applications.join(', ')}</span>
            ) : null}
            {observation.entities?.length ? (
              <span>Entities: {observation.entities.join(', ')}</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

export default function ObservationsClient({ observations }: { observations: Observation[] }) {
  const [items, setItems] = useState(observations)
  const [seeding, setSeeding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const groups = groupByDay(items)

  async function seed() {
    setSeeding(true)
    setError(null)
    try {
      const res = await fetch('/api/observations/seed', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Seed failed')
      if (body.seeded > 0) {
        const list = await fetch('/api/observations')
        setItems(await list.json())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Seed failed')
    } finally {
      setSeeding(false)
    }
  }

  function update(id: string, patch: Partial<Observation>) {
    setItems((prev) =>
      prev.map((o) => (o.id === id ? { ...o, ...patch, edited_at: new Date().toISOString() } : o)),
    )
  }

  function remove(id: string) {
    setItems((prev) => prev.filter((o) => o.id !== id))
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-sm text-neutral-500 mb-4">No observations yet.</p>
        <button
          onClick={seed}
          disabled={seeding}
          className="text-sm bg-neutral-900 text-white rounded px-4 py-2 disabled:opacity-50"
        >
          {seeding ? 'Adding…' : 'Add demo data'}
        </button>
        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      </div>
    )
  }

  return (
    <div>
      {groups.map((g) => (
        <div key={g.date} className="mb-8">
          <p className="text-xs font-medium text-neutral-400 uppercase tracking-wide mb-3">
            {g.label}
          </p>
          <div className="flex flex-col gap-3">
            {g.observations.map((o) => (
              <ObservationRow key={o.id} observation={o} onUpdate={update} onDelete={remove} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
