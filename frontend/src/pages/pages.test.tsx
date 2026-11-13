import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminGroup } from '../api'
import { mockFetch, renderAt } from '../test/render'
import { CreateGroupPage } from './CreateGroup'
import { DashboardPage } from './Dashboard'
import { savedGroups } from '../remember'
import { CheckEmailPage, JoinPage } from './Join'

const future = '2099-12-20'

describe('CreateGroupPage', () => {
  it('shows field errors and does not submit an invalid form', async () => {
    const fetch = mockFetch(() => ({}))
    renderAt('/new', [{ path: '/new', element: <CreateGroupPage /> }])
    await userEvent.type(screen.getByLabelText('Min budget (£)'), '30')
    await userEvent.type(screen.getByLabelText('Max budget (£)'), '20')
    await userEvent.click(screen.getByRole('button', { name: 'Create group' }))

    expect(screen.getByText('Enter a group name')).toBeInTheDocument()
    expect(screen.getByText('Must be at least the min')).toBeInTheDocument()
    expect(screen.getByLabelText('Group name')).toHaveAttribute('aria-invalid', 'true')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('submits pence and shows the one link', async () => {
    const fetch = mockFetch(() => ({
      status: 201,
      body: {
        group_id: 1,
        admin_link: 'http://localhost:5173/g/ADMIN',
        invite_link: 'http://localhost:5173/join/INV',
      },
    }))
    renderAt('/new', [{ path: '/new', element: <CreateGroupPage /> }])
    await userEvent.type(screen.getByLabelText('Group name'), 'Family')
    await userEvent.type(screen.getByLabelText('Gift exchange date'), future)
    await userEvent.type(screen.getByLabelText('Min budget (£)'), '15')
    await userEvent.type(screen.getByLabelText('Max budget (£)'), '25.50')
    await userEvent.type(screen.getByLabelText('Codeword for friends'), 'Dunlop Xmas')
    await userEvent.type(screen.getByLabelText('Your name'), 'Sam')
    await userEvent.type(screen.getByLabelText('Your email'), 'sam@example.com')
    expect(screen.getByLabelText("I'm taking part too")).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Create group' }))

    expect(await screen.findByText('Your group is ready')).toBeInTheDocument()
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string)
    expect(body).toMatchObject({ budget_min: 1500, budget_max: 2550, admin_participates: true, message: null, codeword: 'Dunlop Xmas' })
    expect(screen.getByText('Dunlop Xmas')).toBeInTheDocument()
    expect(screen.getByText('localhost:5173/g/ADMIN')).toBeInTheDocument()
    expect(screen.queryByText(/\/p\//)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to your group' })).toHaveAttribute('href', '/g/ADMIN')
    expect(savedGroups()).toMatchObject([{ kind: 'admin', token: 'ADMIN', groupId: 1, name: 'Family' }])
  })
})

const adminGroup: AdminGroup = {
  id: 1,
  name: 'Family Secret Santa',
  gift_date: '2026-12-20',
  budget_min: 1500,
  budget_max: 2500,
  message: null,
  admin_name: 'Sam',
  draw_status: 'not_drawn',
  days_to_go: 49,
  codeword: 'jingle bells',
  invite_link: 'https://secretsanta.dunlopdev.com/join/k3x9',
  drawn_at: null,
  show_exclusions: false,
  exclusion_pair_count: 2,
  participants: [
    { id: 1, name: 'Sam', status: 'wish_list_in', is_admin: true },
    { id: 2, name: 'Alex', status: 'joined', is_admin: false },
    { id: 3, name: 'Jo', status: 'invited', is_admin: false },
  ],
}

describe('DashboardPage', () => {
  it('renders the group, codeword and statuses', async () => {
    const fetch = mockFetch(() => ({ body: adminGroup }))
    renderAt('/g/TOKEN', [{ path: '/g/:adminToken', element: <DashboardPage /> }])

    expect(await screen.findByRole('heading', { name: 'Family Secret Santa' })).toBeInTheDocument()
    expect(screen.getByText('Gift swap 20 Dec 2026 · Budget £15 to £25')).toBeInTheDocument()
    expect(screen.getByText('49 days to go')).toBeInTheDocument()
    expect(screen.getByText('jingle bells')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument()
    expect(screen.getByText('3 people')).toBeInTheDocument()
    expect(screen.getByText("2 pairs can't be matched")).toBeInTheDocument()

    const rows = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual(['SSam (you)Wish list in', 'AAlexJoined', 'JJoInvited'])

    const [url, init] = fetch.mock.calls[0]
    expect(url).toMatch(/\/admin\/group$/)
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN')
  })

  it('shows the invalid link page for an unknown token', async () => {
    mockFetch(() => ({ status: 404, body: { detail: 'Link not found' } }))
    renderAt('/g/BAD', [{ path: '/g/:adminToken', element: <DashboardPage /> }])
    expect(await screen.findByRole('heading', { name: "This link doesn't work" })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Get a new link' })).toHaveAttribute('href', '/lost')
  })
})

describe('JoinPage', () => {
  const routes = [
    { path: '/join/:inviteToken', element: <JoinPage /> },
    { path: '/join/:inviteToken/check-email', element: <CheckEmailPage /> },
    { path: '/p/:participantToken', element: <p>Wish list page</p> },
  ]

  it('goes straight to the new wish list after joining', async () => {
    mockFetch((_url, init) =>
      init.method === 'POST'
        ? { status: 201, body: { status: 'joined', participant_link: 'http://localhost:5173/p/NEW' } }
        : { body: { group_name: 'G', admin_name: 'Sam', gift_date: '2026-12-20', budget_min: 0, budget_max: 1000, message: null } },
    )
    renderAt('/join/INV', routes)
    await userEvent.type(await screen.findByLabelText('Your name'), 'Alex')
    await userEvent.type(screen.getByLabelText('Email (optional)'), 'alex@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Join this Secret Santa' }))
    expect(await screen.findByText('Wish list page')).toBeInTheDocument()
  })

  it('emails the link when the address is already in, and offers to re-send it', async () => {
    const fetch = mockFetch((_url, init) =>
      init.method === 'POST'
        ? { status: 202, body: { status: 'sent' } }
        : {
            body: {
              group_name: 'Family Secret Santa',
              admin_name: 'Sam',
              gift_date: '2026-12-20',
              budget_min: 1500,
              budget_max: 2500,
              message: 'One gift each.',
            },
          },
    )
    renderAt('/join/INV', routes)

    expect(await screen.findByText('Hosted by Sam')).toBeInTheDocument()
    expect(screen.getByText('20 Dec 2026')).toBeInTheDocument()
    expect(screen.getByText('£15 to £25')).toBeInTheDocument()
    expect(screen.getByText('One gift each.')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Your name'), 'Alex')
    await userEvent.type(screen.getByLabelText('Email (optional)'), 'alex@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Join this Secret Santa' }))

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(screen.getByText('alex@example.com')).toBeInTheDocument()
    expect(screen.getByText(/is already in this group/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Re-send link' }))
    expect(await screen.findByRole('button', { name: 'Sent again' })).toBeInTheDocument()
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(JSON.parse(posts[1][1]!.body as string)).toEqual({ name: 'Alex', email: 'alex@example.com' })
  })

  it('shows server errors such as a full group', async () => {
    mockFetch((_url, init) =>
      init.method === 'POST'
        ? { status: 409, body: { detail: 'This group is full' } }
        : { body: { group_name: 'G', admin_name: 'Sam', gift_date: '2026-12-20', budget_min: 0, budget_max: 1000, message: null } },
    )
    renderAt('/join/INV', routes)
    await userEvent.type(await screen.findByLabelText('Your name'), 'Alex')
    await userEvent.type(screen.getByLabelText('Email (optional)'), 'alex@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Join this Secret Santa' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This group is full')
  })
})
