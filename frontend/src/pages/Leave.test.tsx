import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import type { AdminGroup, Me } from '../api'
import { Confetti } from '../components/Confetti'
import { mockFetch, renderAt } from '../test/render'
import { DashboardPage } from './Dashboard'
import { GroupDeletedPage, LeftPage, UnsubscribePage } from './Unsubscribe'
import { WishListPage } from './WishList'

type Call = { url: string; method: string }

function record(respond: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = []
  mockFetch((url, init) => {
    const call = { url, method: init.method ?? 'GET' }
    calls.push(call)
    return respond(call)
  })
  return calls
}

const me: Me = {
  id: 2,
  name: 'Alex',
  is_admin: false,
  secret_surprise: false,
  group: { id: 1, name: 'Family Secret Santa', gift_date: '2026-12-20', budget_min: 1500, budget_max: 2500, message: null, admin_name: 'Sam', draw_status: 'drawn', days_to_go: 48 },
  items: [],
}

describe('Unsubscribe page', () => {
  const routes = [{ path: '/unsubscribe/:token', element: <UnsubscribePage /> }]

  it('waits for a tap, then confirms', async () => {
    const calls = record(() => ({ body: { status: 'unsubscribed' } }))
    renderAt('/unsubscribe/p2.abc', routes)
    expect(screen.getByRole('heading', { name: 'Stop reminder emails?' })).toBeInTheDocument()
    expect(calls).toHaveLength(0) // opening the link alone does nothing
    await userEvent.click(screen.getByRole('button', { name: 'Stop reminders' }))
    expect(await screen.findByRole('heading', { name: 'Reminders stopped' })).toBeInTheDocument()
    expect(calls).toEqual([{ url: expect.stringMatching(/\/unsubscribe\/p2\.abc$/), method: 'POST' }])
  })

  it('treats a bad link as not found', async () => {
    record(() => ({ status: 404, body: { detail: 'Link not found' } }))
    renderAt('/unsubscribe/bad', routes)
    await userEvent.click(screen.getByRole('button', { name: 'Stop reminders' }))
    expect(await screen.findByRole('heading', { name: "This link doesn't work" })).toBeInTheDocument()
  })
})

describe('Leaving', () => {
  it('confirms, deletes and lands on the left page', async () => {
    const calls = record((c) => (c.method === 'DELETE' ? { status: 204 } : { body: me }))
    renderAt('/p/TOKEN', [
      { path: '/p/:participantToken', element: <WishListPage /> },
      { path: '/left', element: <LeftPage /> },
    ])
    await userEvent.click(await screen.findByRole('button', { name: 'Leave this Secret Santa' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Leave Family Secret Santa?' })
    expect(dialog).toHaveTextContent('names are drawn again for everyone else')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Leave' }))
    expect(await screen.findByRole('heading', { name: "You've left" })).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'DELETE')!.url).toMatch(/\/me$/)
  })
})

const group: AdminGroup = {
  id: 1,
  name: 'Family Secret Santa',
  gift_date: '2026-12-20',
  budget_min: 1500,
  budget_max: 2500,
  message: null,
  admin_name: 'Sam',
  draw_status: 'not_drawn',
  days_to_go: 48,
  codeword: 'jingle bells',
  invite_link: 'http://localhost:5173/join/INV',
  drawn_at: null,
  show_exclusions: false,
  exclusion_pair_count: 0,
  participants: [
    { id: 1, name: 'Sam', status: 'joined', is_admin: true },
    { id: 2, name: 'Alex', status: 'joined', is_admin: false },
    { id: 3, name: 'Priya', status: 'joined', is_admin: false },
  ],
}

describe('Deleting the group', () => {
  it('confirms, deletes and lands on the deleted page', async () => {
    const calls = record((c) => (c.method === 'DELETE' ? { status: 204 } : { body: group }))
    renderAt('/g/ADMIN', [
      { path: '/g/:adminToken', element: <DashboardPage /> },
      { path: '/deleted', element: <GroupDeletedPage /> },
    ])
    await userEvent.click(await screen.findByRole('button', { name: 'Delete this group' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete Family Secret Santa?' })
    expect(dialog).toHaveTextContent("This can't be undone.")
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete group' }))
    expect(await screen.findByRole('heading', { name: 'Group deleted' })).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'DELETE')!.url).toMatch(/\/admin\/group$/)
  })
})

describe('Confetti', () => {
  function mockMotion(reduce: boolean) {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) => ({ matches: reduce && query.includes('reduce'), media: query }) as MediaQueryList,
    )
  }

  it('is skipped entirely under reduced motion', async () => {
    window.matchMedia ??= (() => ({ matches: false })) as unknown as typeof window.matchMedia
    mockMotion(true)
    const done = vi.fn()
    const { container } = render(<Confetti onDone={done} />)
    expect(container).toBeEmptyDOMElement()
    await waitFor(() => expect(done).toHaveBeenCalled())
  })

  it('renders decorative pieces otherwise', () => {
    window.matchMedia ??= (() => ({ matches: false })) as unknown as typeof window.matchMedia
    mockMotion(false)
    const { container } = render(<Confetti onDone={() => {}} />)
    const burst = container.querySelector('.confetti')!
    expect(burst).toHaveAttribute('aria-hidden', 'true')
    expect(burst.children).toHaveLength(28)
  })
})
