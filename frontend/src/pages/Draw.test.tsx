import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminGroup, GifteeResponse, Me } from '../api'
import { timeAgo } from '../format'
import { mockFetch, renderAt } from '../test/render'
import { DashboardPage } from './Dashboard'
import { GifteePage } from './Giftee'

type Call = { url: string; method: string; body: unknown }

const baseGroup: AdminGroup = {
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
    { id: 3, name: 'Priya', status: 'wish_list_in', is_admin: false },
  ],
}

function dashboard(groups: AdminGroup[], respond: (call: Call) => { status?: number; body?: unknown } | undefined = () => undefined) {
  const calls: Call[] = []
  let current = 0
  mockFetch((url, init) => {
    const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined }
    calls.push(call)
    if (url.endsWith('/admin/group')) return { body: groups[Math.min(current, groups.length - 1)] }
    const custom = respond(call)
    if (custom) {
      if ((custom.status ?? 200) < 300) current += 1
      return custom
    }
    return { status: 500, body: { detail: 'unexpected' } }
  })
  renderAt('/g/ADMIN', [{ path: '/g/:adminToken', element: <DashboardPage /> }])
  return calls
}

const drawnGroup: AdminGroup = { ...baseGroup, draw_status: 'drawn', drawn_at: '2026-11-02T10:00:00Z' }

describe('Dashboard draw', () => {
  it('runs the draw and shows the drawn state without any pairs', async () => {
    const calls = dashboard([baseGroup, drawnGroup], (c) =>
      c.url.endsWith('/draw') ? { body: { draw_status: 'drawn', drawn_at: '2026-11-02T10:00:00Z', participant_count: 3 } } : undefined,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Run the draw' }))
    expect(await screen.findByText('Names drawn')).toBeInTheDocument()
    expect(screen.getByText('2 Nov 2026')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run the draw' })).not.toBeInTheDocument()
    expect(calls.find((c) => c.url.endsWith('/draw'))!.body).toEqual({ confirm_redraw: false })
  })

  it('needs three people', async () => {
    dashboard([{ ...baseGroup, participants: baseGroup.participants.slice(0, 2) }])
    expect(await screen.findByRole('button', { name: 'Run the draw' })).toBeDisabled()
  })

  it('names the bottleneck when no draw is possible', async () => {
    dashboard([baseGroup], (c) =>
      c.url.endsWith('/draw')
        ? {
            status: 409,
            body: { detail: { code: 'no_valid_draw', message: 'No valid draw', bottleneck: { side: 'give', people: [1, 2], options: [3] } } },
          }
        : undefined,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Run the draw' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No valid draw: Sam and Alex can only give to Priya')
  })

  it('asks before a redraw', async () => {
    const calls = dashboard([drawnGroup, drawnGroup], (c) =>
      c.url.endsWith('/draw') ? { body: { draw_status: 'drawn', drawn_at: null, participant_count: 3 } } : undefined,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Redraw' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Redraw names?' })
    expect(dialog).toHaveAccessibleDescription('Everyone gets a new giftee and an email.')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(calls.some((c) => c.url.endsWith('/draw'))).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: 'Redraw' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Redraw' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(calls.find((c) => c.url.endsWith('/draw'))!.body).toEqual({ confirm_redraw: true })
  })

  it('removes someone after the draw only with a confirmed redraw', async () => {
    const calls = dashboard([drawnGroup, drawnGroup], (c) => (c.method === 'DELETE' ? { status: 204 } : undefined))
    await userEvent.click(await screen.findByRole('button', { name: 'Edit people' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove Alex' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Alex?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove and redraw' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(calls.find((c) => c.method === 'DELETE')!.url).toMatch(/\/groups\/1\/participants\/2\?confirm_redraw=true$/)
  })

  it('adds someone before the draw without a dialog', async () => {
    const calls = dashboard([baseGroup, baseGroup], (c) =>
      c.url.endsWith('/participants') ? { status: 201, body: { id: 4, name: 'Jo', status: 'invited', is_admin: false } } : undefined,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Edit people' }))
    const form = screen.getByRole('form', { name: 'Add someone' })
    await userEvent.type(within(form).getByLabelText('Name'), 'Jo')
    await userEvent.type(within(form).getByLabelText('Email (optional)'), 'jo@example.com')
    await userEvent.click(within(form).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/participants'))).toBe(true))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(calls.find((c) => c.url.endsWith('/participants'))!.body).toEqual({ name: 'Jo', email: 'jo@example.com', confirm_redraw: false })
  })
})

const me: Me = {
  id: 2,
  name: 'Alex',
  is_admin: false,
  secret_surprise: false,
  group: { id: 1, name: 'Family Secret Santa', gift_date: '2026-12-20', budget_min: 1500, budget_max: 2500, message: null, admin_name: 'Sam', draw_status: 'drawn', days_to_go: 48 },
  items: [],
}

function giftee(response: GifteeResponse) {
  mockFetch((url) => (url.endsWith('/me/giftee') ? { body: response } : { body: me }))
  renderAt('/p/TOKEN/giftee', [
    { path: '/p/:participantToken/giftee', element: <GifteePage /> },
    { path: '/p/:participantToken', element: <h1>Wish list</h1> },
  ])
}

describe('GifteePage', () => {
  it('reveals the giftee and flags items over budget', async () => {
    giftee({
      drawn: true,
      giftee: {
        name: 'Priya',
        secret_surprise: false,
        updated_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        updated_since_draw: true,
        items: [
          { id: 1, title: 'Linen apron', url: 'https://shop.example/apron', price: 2200, image_url: null },
          { id: 2, title: 'Noise-cancelling headphones', url: 'https://shop.example/hp', price: 7900, image_url: null },
          { id: 3, title: 'A surprise book', url: null, price: null, image_url: null },
        ],
      },
    })
    expect(await screen.findByRole('heading', { level: 1, name: 'Priya' })).toBeInTheDocument()
    expect(screen.getByText("You're Secret Santa for")).toBeInTheDocument()
    expect(screen.getByText('Priya updated this list 2 hours ago')).toBeInTheDocument()
    expect(screen.getByText('New')).toBeInTheDocument()

    const apron = screen.getByRole('article', { name: 'Linen apron' })
    expect(within(apron).getByText('£22 · within budget')).toBeInTheDocument()
    expect(within(apron).getByRole('link', { name: 'View link for Linen apron' })).toHaveAttribute('rel', 'noopener noreferrer nofollow')
    const headphones = screen.getByRole('article', { name: 'Noise-cancelling headphones' })
    expect(within(headphones).getByText('£79 · over budget')).toHaveClass('chip--warn')
    const book = screen.getByRole('article', { name: 'A surprise book' })
    expect(within(book).queryByRole('link')).not.toBeInTheDocument()
  })

  it('shows the secret surprise variant', async () => {
    giftee({ drawn: true, giftee: { name: 'Priya', secret_surprise: true, items: [], updated_at: null, updated_since_draw: false } })
    expect(await screen.findByText('Priya wants to be surprised')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: "Priya's wish list" })).not.toBeInTheDocument()
  })

  it('shows an empty list', async () => {
    giftee({ drawn: true, giftee: { name: 'Priya', secret_surprise: false, items: [], updated_at: null, updated_since_draw: false } })
    expect(await screen.findByText("Priya hasn't added anything yet")).toBeInTheDocument()
    expect(screen.queryByText('New')).not.toBeInTheDocument()
  })

  it('before the draw', async () => {
    giftee({ drawn: false, giftee: null })
    expect(await screen.findByRole('heading', { name: 'Names not drawn yet' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Your wish list' })).toHaveAttribute('href', '/p/TOKEN')
  })
})

describe('timeAgo', () => {
  const now = new Date('2026-11-02T12:00:00Z')
  it.each([
    ['2026-11-02T11:59:40Z', 'just now'],
    ['2026-11-02T11:59:00Z', '1 minute ago'],
    ['2026-11-02T11:15:00Z', '45 minutes ago'],
    ['2026-11-02T10:00:00Z', '2 hours ago'],
    ['2026-10-31T12:00:00Z', '2 days ago'],
  ])('%s -> %s', (iso, text) => {
    expect(timeAgo(iso, now)).toBe(text)
  })
})
