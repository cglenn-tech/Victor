'use client'

import { useEffect, useState } from 'react'

export default function LocalWorkTime({ start, end }: { start: string; end: string }) {
  const [label, setLabel] = useState(`${start} – ${end}`)
  useEffect(() => {
    const from = new Date(start), to = new Date(end)
    const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
    const date: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
    setLabel(`${from.toLocaleDateString('en-US', date)} · ${from.toLocaleTimeString('en-US', time)} – ${to.toLocaleTimeString('en-US', time)}`)
  }, [start, end])
  return <time dateTime={start}>{label}</time>
}
