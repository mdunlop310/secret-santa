import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EnteredGroup } from '../api'
import { mockFetch, renderAt } from '../test/render'
import { EnterPage } from './Enter'

const group: EnteredGroup = {
  group_name: 'Family Secret Santa',
  admin_name: 'Harry',
  gift_date: '2026-12-20',
  budget_min: 1500,
  budget_max: 2500,
  message: null,
  draw_status: 'not_drawn',
  people: [
    { id: 1, name: 'Harry' },
    { id: 2, name: 'Emma' },
  ],
}

const routes = [
  { path: '/', element: <EnterPage /> },
  { path: '/p/:participantToken', element: <p>Wish list page</p> },
]

async function enterCodeword(word = 'dunlop xmas') {
  await userEvent.type(screen.getByLabelText('Group codeword'), word)
  await userEvent.click(screen.getByRole('button', { name: 'Find my group' }))
}

describe('EnterPage', () => {
  it('finds the group by codeword and lets you tap your name', async () => {
    const fetch = mockFetch((url) =>
      url.endsWith('/enter/pick') ? { body: { link: 'http://localhost:5173/p/EMMA' } } : { body: group },
    )
    renderAt('/', routes)
    await enterCodeword()
    expect(await screen.findByRole('heading', { name: 'Family Secret Santa' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Emma' }))
    expect(await screen.findByText('Wish list page')).toBeInTheDocument()
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ codeword: 'dunlop xmas', participant_id: 2 })
  })

  it('joins without an email', async () => {
    const fetch = mockFetch((url) =>
      url.endsWith('/enter/join') ? { status: 201, body: { link: 'http://localhost:5173/p/NEW' } } : { body: group },
    )
    renderAt('/', routes)
    await enterCodeword()
    await userEvent.type(await screen.findByLabelText('Your name'), 'Alex')
    await userEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(await screen.findByText('Wish list page')).toBeInTheDocument()
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ codeword: 'dunlop xmas', name: 'Alex', email: null })
  })

  it('says when the codeword is wrong', async () => {
    mockFetch(() => ({ status: 404, body: { detail: 'No group has that codeword' } }))
    renderAt('/', routes)
    await enterCodeword('nope')
    expect(await screen.findByText('No group has that codeword')).toBeInTheDocument()
  })

  it('hides joining once names are drawn', async () => {
    mockFetch(() => ({ body: { ...group, draw_status: 'drawn' } }))
    renderAt('/', routes)
    await enterCodeword()
    expect(await screen.findByRole('button', { name: 'Harry' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument()
  })
})
