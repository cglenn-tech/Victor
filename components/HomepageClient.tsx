'use client'

import { useState, useEffect, useCallback } from 'react'
import DesktopAgentCard from './DesktopAgentCard'
import ReportGenerator from './ReportGenerator'
import EpisodeList from './EpisodeList'
import ThisWeekSummary from './ThisWeekSummary'
import ManualEntryForm from './ManualEntryForm'
import DailyReviewModal from './DailyReviewModal'
import { getBrowserClient } from '@/lib/supabase-browser'
import type { Episode } from '@/lib/types'

type Props = { episodes: Episode[] }

export default function HomepageClient({ episodes: init }: Props) {
  const [episodes, setEpisodes] = useState<Episode[]>(init)
  const [showDailyReview, setShowDailyReview] = useState(false)

  // Single Supabase browser client instance shared across child components
  const [supabase] = useState(() => getBrowserClient())

  // Polling recovers from missed Realtime events and runs on every fresh account mount.
  useEffect(() => {
    let cancelled = false
    let running = false
    async function refresh() {
      if (running) return
      running = true
      try {
        const response = await fetch('/api/episodes', { cache: 'no-store' })
        if (response.ok && !cancelled) setEpisodes(await response.json())
      } finally { running = false }
    }
    const timer = setInterval(() => { void refresh().catch(() => {}) }, 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  function handleEpisodeSaved(ep: Episode) {
    if (ep.deleted_at) { setEpisodes(prev => prev.filter(e => e.id !== ep.id)); return }
    setEpisodes((prev) => {
      const exists = prev.some((e) => e.id === ep.id)
      return exists
        ? prev.map((e) => (e.id === ep.id ? ep : e))
        : [ep, ...prev]
    })
  }

  function handleDelete(id: string) {
    setEpisodes((prev) => prev.filter((e) => e.id !== id))
  }

  function handleUpdate(ep: Episode) {
    setEpisodes((prev) => prev.map((e) => (e.id === ep.id ? ep : e)))
  }

  function handleMerge(keepId: string, dropId: string, merged: Episode) {
    setEpisodes((prev) =>
      prev
        .filter((e) => e.id !== dropId)
        .map((e) => (e.id === keepId ? merged : e)),
    )
  }

  // Callback for ThisWeekSummary's Realtime subscription to bubble up new episodes
  const handleEpisodeUpdate = useCallback((ep: Episode) => {
    if (ep.deleted_at) { setEpisodes(prev => prev.filter(e => e.id !== ep.id)); return }
    setEpisodes((prev) => {
      const exists = prev.some((e) => e.id === ep.id)
      return exists
        ? prev.map((e) => (e.id === ep.id ? ep : e))
        : [ep, ...prev]
    })
  }, [])

  return (
    <>
      <DesktopAgentCard onDailyReview={() => setShowDailyReview(true)} />
      <ThisWeekSummary
        episodes={episodes}
        supabase={supabase}
        onEpisodeUpdate={handleEpisodeUpdate}
      />
      <div className="mb-10">
        <ReportGenerator />
      </div>
      <ManualEntryForm onEpisodeSaved={handleEpisodeSaved} />
      <EpisodeList
        episodes={episodes}
        onDelete={handleDelete}
        onUpdate={handleUpdate}
        onMerge={handleMerge}
      />
      {showDailyReview && (
        <DailyReviewModal
          episodes={episodes}
          onDismiss={() => setShowDailyReview(false)}
        />
      )}
    </>
  )
}
