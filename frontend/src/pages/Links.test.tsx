import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminGroup, Me } from '../api'
import { destinationPath, memberLinks } from '../links'
import { rememberGroup, savedGroups } from '../remember'
import { mockFetch, renderAt } from '../test/render'
import { CreateGroupPage } from './CreateGroup'
import { DashboardPage } from './Dashboard'
import { LostLinkPage, OpenLinkPage } from './Links'
import { WishListPage } from './WishList'

const me: Me = {
  id: 1,
  name: 'Sam',
  is_admin: true,
  secret_surprise: false,
  group: {
    id: 7,
    name: 'Family Secret Santa',
    gift_date: '2026-12-20',
    budget_min: 1500,
    budget_max: 2500,
    message: null,
    admin_name: 'Sam',
    draw_status: 'drawn',
    days_to_go: 49,
  },
  items: [],
}

describe('member links', () => {
  it('maps the organiser link and a participant link to their pages', () => {
    expect(memberLinks({ adminToken: 'A' })).toEqual({
      token: 'A',
      organiser: true,
      home: '/g/A',
      wishList: '/g/A/wishlist',
      giftee: '/g/A/giftee',
    })
    expect(memberLinks({ participantToken: 'P' })).toMatchObject({ organiser: false, home: '/p/P', wishList: '/p/P', giftee: '/p/P/giftee' })
  })

  it('sends opened email links to the right page', () => {
    expect(destinationPath('admin', 'https://x.test/g/A', 'group')).toBe('/g/A')
    expect(destinationPath('admin', 'https://x.test/g/A', 'giftee')).toBe('/g/A/giftee')
    expect(destinationPath('admin', 'https://x.test/g/A', 'wishlist')).toBe('/g/A/wishlist')
    expect(destinationPath('participant', 'https://x.test/p/P', 'giftee')).toBe('/p/P/giftee')
    expect(destinationPath('participant', 'https://x.test/p/P', null)).toBe('/p/P')
  })
})

describe('OpenLinkPage', () => {
  it('swaps the email link for a working one, once, and moves on', async () => {
    const fetch = mockFetch(() => ({ body: { kind: 'participant', link: 'http://localhost:5173/p/FRESH' } }))
    renderAt('/open/p1.123.abc?to=giftee', [
      { path: '/open/:token', element: <OpenLinkPage /> },
      { path: '/p/:participantToken/giftee', element: <p>Giftee page</p> },
    ])
    expect(await screen.findByText('Giftee page')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0][0])).toContain('/links/open/p1.123.abc')
  })

  it('shows the broken-link page for an expired link', async () => {
    mockFetch(() => ({ status: 404, body: { detail: 'Link not found' } }))
    renderAt('/open/old', [{ path: '/open/:token', element: <OpenLinkPage /> }])
    expect(await screen.findByRole('heading', { name: "This link doesn't work" })).toBeInTheDocument()
  })
})

describe('LostLinkPage', () => {
  it('asks for an email and confirms without saying whether it was found', async () => {
    const fetch = mockFetch(() => ({ status: 202, body: { status: 'sent' } }))
    renderAt('/lost', [{ path: '/lost', element: <LostLinkPage /> }])
    await userEvent.click(screen.getByRole('button', { name: 'Email my links' }))
    expect(screen.getByText('Enter a valid email')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText('Your email'), 'alex@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Email my links' }))
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ email: 'alex@example.com' })
  })
})

describe('remembered groups', () => {
  it('lists groups opened on this device and can forget one', async () => {
    rememberGroup({ kind: 'admin', token: 'A', groupId: 1, name: 'Work', giftDate: '2026-12-18' })
    rememberGroup({ kind: 'participant', token: 'P', groupId: 2, name: 'Family', giftDate: '2026-12-25' })
    renderAt('/', [{ path: '/', element: <CreateGroupPage /> }])

    const card = screen.getByRole('region', { name: 'Your groups' })
    expect(within(card).getByRole('link', { name: /Family/ })).toHaveAttribute('href', '/p/P')
    expect(within(card).getByRole('link', { name: /Work/ })).toHaveAttribute('href', '/g/A')
    expect(within(card).getByText('18 Dec 2026 · Organiser')).toBeInTheDocument()

    await userEvent.click(within(card).getByRole('button', { name: 'Forget Work on this device' }))
    expect(within(card).queryByRole('link', { name: /Work/ })).not.toBeInTheDocument()
    expect(savedGroups().map((g) => g.token)).toEqual(['P'])
  })

  it('keeps one entry per group and role, newest first', () => {
    rememberGroup({ kind: 'participant', token: 'OLD', groupId: 2, name: 'Family', giftDate: '2026-12-25' })
    rememberGroup({ kind: 'participant', token: 'NEW', groupId: 2, name: 'Family', giftDate: '2026-12-25' })
    expect(savedGroups().map((g) => g.token)).toEqual(['NEW'])
  })

  it('works when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => rememberGroup({ kind: 'admin', token: 'A', groupId: 1, name: 'W', giftDate: '2026-12-18' })).not.toThrow()
    expect(savedGroups()).toEqual([])
  })

  it('forgets a link the server no longer knows', async () => {
    rememberGroup({ kind: 'participant', token: 'GONE', groupId: 3, name: 'Old', giftDate: '2026-12-01' })
    mockFetch(() => ({ status: 404, body: { detail: 'Link not found' } }))
    renderAt('/p/GONE', [{ path: '/p/:participantToken', element: <WishListPage /> }])
    expect(await screen.findByRole('heading', { name: "This link doesn't work" })).toBeInTheDocument()
    expect(savedGroups()).toEqual([])
  })
})

describe("the organiser's wish list", () => {
  it('opens on the admin link, links back to the group and has no leave button', async () => {
    const fetch = mockFetch((url) => (url.endsWith('/me') ? { body: me } : { status: 500, body: {} }))
    renderAt('/g/ADMIN/wishlist', [{ path: '/g/:adminToken/wishlist', element: <WishListPage /> }])

    expect(await screen.findByRole('heading', { name: 'Your wish list' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to group' })).toHaveAttribute('href', '/g/ADMIN')
    expect(screen.getByRole('link', { name: "See who you're buying for" })).toHaveAttribute('href', '/g/ADMIN/giftee')
    expect(screen.queryByRole('button', { name: 'Leave this Secret Santa' })).not.toBeInTheDocument()
    const init = fetch.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ADMIN')
  })
})

describe("the organiser's dashboard", () => {
  const group: AdminGroup = {
    ...me.group,
    codeword: 'jingle bells',
    invite_link: 'http://localhost:5173/join/INV',
    drawn_at: '2026-11-03T10:00:00Z',
    show_exclusions: false,
    exclusion_pair_count: 0,
    participants: [
      { id: 1, name: 'Sam', status: 'joined', is_admin: true },
      { id: 2, name: 'Alex', status: 'wish_list_in', is_admin: false },
      { id: 3, name: 'Priya', status: 'joined', is_admin: false },
    ],
  }

  it('links to their own wish list and giftee when they take part', async () => {
    mockFetch(() => ({ body: group }))
    renderAt('/g/ADMIN', [{ path: '/g/:adminToken', element: <DashboardPage /> }])
    expect(await screen.findByRole('link', { name: 'Open your wish list' })).toHaveAttribute('href', '/g/ADMIN/wishlist')
    expect(screen.getByRole('link', { name: "See who you're buying for" })).toHaveAttribute('href', '/g/ADMIN/giftee')
    expect(screen.getByText('Nothing added yet')).toBeInTheDocument()
    expect(savedGroups()).toMatchObject([{ kind: 'admin', token: 'ADMIN', groupId: 7 }])
  })

  it('has no personal links when they are not taking part', async () => {
    mockFetch(() => ({ body: { ...group, participants: group.participants.map((p) => ({ ...p, is_admin: false })) } }))
    renderAt('/g/ADMIN', [{ path: '/g/:adminToken', element: <DashboardPage /> }])
    expect(await screen.findByRole('heading', { name: 'Family Secret Santa' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open your wish list' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: "See who you're buying for" })).not.toBeInTheDocument()
  })
})
