// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentStatusCard from './AgentStatusCard'
import DesktopAgentCard from './DesktopAgentCard'
import { getBrowserClient } from '@/lib/supabase-browser'
import type { DeviceStatus } from '@/lib/agent-status'

vi.mock('@/lib/supabase-browser', () => ({ getBrowserClient: vi.fn() }))
vi.mock('./DownloadButton', () => ({ default: ({ label = 'Download VICTOR' }: { label?: string }) => <button>{label}</button> }))

let presences: Record<string, unknown[]>
let subscription: (status: string) => Promise<void>
let queryResult: { data: DeviceStatus[] | null; error: unknown }
let send: ReturnType<typeof vi.fn>
const device: DeviceStatus = { id: 'd1', name: 'My Mac', last_seen_at: null, app_version: null, recording_requested: false }

beforeEach(() => {
  vi.useFakeTimers()
  presences = {}
  queryResult = { data: [], error: null }
  send = vi.fn().mockResolvedValue('ok')
  const channel = {
    on: vi.fn().mockReturnThis(), send, track: vi.fn().mockResolvedValue('ok'),
    presenceState: () => presences,
    subscribe: (callback: typeof subscription) => { subscription = callback; void callback('SUBSCRIBED') },
  }
  const query = { select: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: async () => queryResult }
  vi.mocked(getBrowserClient).mockReturnValue({ channel: () => channel, removeChannel: vi.fn(), from: () => query } as unknown as ReturnType<typeof getBrowserClient>)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }))
})

afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('offers Open and Reconnect, without a download, when a linked app is offline', async () => {
  await act(async () => { render(<AgentStatusCard device={device} />) })
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(screen.getByRole('button', { name: 'Open VICTOR' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Reconnect account' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
})

it('recognizes an already-running app from its presence without waiting for another status message', async () => {
  presences = { agent: [{ type: 'agent', version: '1.1.1', state: 'idle' }] }
  await act(async () => { render(<AgentStatusCard device={device} />) })
  expect(screen.getByText('Ready to start')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start Work Session' })).toBeTruthy()
})

it('does not confuse a missing version with an outdated installation', async () => {
  presences = { agent: [{ type: 'agent' }] }
  await act(async () => { render(<AgentStatusCard device={device} />) })
  expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
})

it('offers an update when the connected agent reports a known older version', async () => {
  presences = { agent: [{ type: 'agent', version: '1.1.0', state: 'idle' }] }
  await act(async () => { render(<AgentStatusCard device={device} />) })
  expect(screen.getByRole('button', { name: 'Download Update' })).toBeTruthy()
})

it('keeps HTTP controls available when live status fails, without claiming recording started', async () => {
  const current = { ...device, app_version: '1.1.1', last_seen_at: new Date().toISOString() }
  await act(async () => { render(<AgentStatusCard device={current} />) })
  await act(async () => { await subscription('CHANNEL_ERROR') })
  expect(screen.getByText('Desktop app connected')).toBeTruthy()
  send.mockRejectedValue(new Error('socket unavailable'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start Work Session' })) })
  expect(fetch).toHaveBeenCalledWith('/api/device/session', expect.objectContaining({ body: JSON.stringify({ action: 'start', deviceId: 'd1' }) }))
  expect(screen.queryByText('Recording')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: 'Stop Work Session' })).toBeTruthy()
})

it('discovers a device linked after the dashboard was opened', async () => {
  await act(async () => { render(<DesktopAgentCard />) })
  expect(screen.getByRole('button', { name: 'Already installed? Connect VICTOR' })).toBeTruthy()
  queryResult = { data: [{ ...device, app_version: '1.1.1', last_seen_at: new Date().toISOString() }], error: null }
  presences = { agent: [{ type: 'agent', version: '1.1.1', state: 'idle' }] }
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.getByRole('button', { name: 'Start Work Session' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
})

it('shows a device lookup error instead of asking the user to install again', async () => {
  queryResult = { data: null, error: new Error('database unavailable') }
  await act(async () => { render(<DesktopAgentCard />) })
  expect(screen.getByRole('alert').textContent).toContain('Could not check')
  expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
})
