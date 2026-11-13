import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, type AdminGroup, type Bottleneck, type ParticipantSummary } from '../api'
import { describeCheck } from '../bottleneck'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Confetti } from '../components/Confetti'
import { CodewordCard } from '../components/Codeword'
import { Field } from '../components/Field'
import { HeaderBand } from '../components/HeaderBand'
import { PeopleCard } from '../components/People'
import { ErrorState, LoadingPage } from '../components/States'
import { daysToGo, formatBudget, formatDate, formatDateTime } from '../format'
import { forgetGroup, useRememberGroup } from '../remember'

const MIN_PEOPLE = 3
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REDRAW_BODY = 'Everyone gets a new giftee and an email.'

function GiftIcon() {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M5 12v8h14v-8M12 8v12M12 8c-2-4-6-3-5 0 .6 1.6 3 1.4 5 0zM12 8c2-4 6-3 5 0-.6 1.6-3 1.4-5 0z" />
    </svg>
  )
}

type Pending =
  | { kind: 'redraw' }
  | { kind: 'delete' }
  | { kind: 'remove'; person: ParticipantSummary }
  | { kind: 'add'; name: string; email: string }

/** Turns a draw error into words, naming the stuck people when there are some. */
function drawErrorMessage(error: Error, people: ParticipantSummary[]): string {
  if (error instanceof ApiError && error.code === 'no_valid_draw') {
    const bottleneck = error.detail?.bottleneck as Bottleneck
    return describeCheck({ possible: false, reason: 'stuck', bottleneck }, people)
  }
  return error.message
}

export function DashboardPage() {
  const { adminToken: token = '' } = useParams()
  const queryClient = useQueryClient()
  const key = ['admin-group', token]
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<AdminGroup>('/admin/group', { token }),
    // The admin watches people join from other devices; refresh when they come back.
    refetchOnWindowFocus: true,
  })
  const [editing, setEditing] = useState(false)
  const [celebrate, setCelebrate] = useState(false)
  const navigate = useNavigate()
  const [pending, setPending] = useState<Pending | null>(null)
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [addErrors, setAddErrors] = useState<{ name?: string; email?: string }>({})

  useRememberGroup('admin', token, query.data, query.error)
  const refresh = () => queryClient.invalidateQueries({ queryKey: key })
  const groupId = query.data?.id

  const draw = useMutation({
    mutationFn: (confirm_redraw: boolean) =>
      api(`/groups/${groupId}/draw`, { method: 'POST', token, body: { confirm_redraw } }),
    onSuccess: async () => {
      setPending(null)
      await refresh()
      setCelebrate(true)
    },
  })
  const deleteGroup = useMutation({
    mutationFn: () => api('/admin/group', { method: 'DELETE', token }),
    onSuccess: () => {
      forgetGroup(token)
      queryClient.removeQueries({ queryKey: key })
      navigate('/deleted', { replace: true })
    },
  })
  const remove = useMutation({
    mutationFn: ({ person, confirm }: { person: ParticipantSummary; confirm: boolean }) =>
      api(`/groups/${groupId}/participants/${person.id}?confirm_redraw=${confirm}`, { method: 'DELETE', token }),
    onSuccess: async () => {
      setPending(null)
      await refresh()
    },
  })
  const add = useMutation({
    mutationFn: ({ name, email, confirm }: { name: string; email: string; confirm: boolean }) =>
      api(`/groups/${groupId}/participants`, { method: 'POST', token, body: { name, email: email || null, confirm_redraw: confirm } }),
    onSuccess: async () => {
      setPending(null)
      setNewName('')
      setNewEmail('')
      await refresh()
    },
  })

  if (query.isPending) return <LoadingPage />
  if (query.isError) return <ErrorState error={query.error} />
  const group = query.data
  const pairs = group.exclusion_pair_count
  const drawn = group.draw_status === 'drawn'
  const people = group.participants
  const me = people.find((p) => p.is_admin)

  function submitAdd(e: FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    const email = newEmail.trim()
    const errors = {
      name: name ? undefined : 'Enter a name',
      email: !email || EMAIL_RE.test(email) ? undefined : 'Enter a valid email',
    }
    setAddErrors(errors)
    if (errors.name || errors.email) return
    if (drawn) setPending({ kind: 'add', name, email })
    else add.mutate({ name, email, confirm: false })
  }

  function confirmPending() {
    if (!pending) return
    if (pending.kind === 'redraw') draw.mutate(true)
    if (pending.kind === 'delete') deleteGroup.mutate()
    if (pending.kind === 'remove') remove.mutate({ person: pending.person, confirm: drawn })
    if (pending.kind === 'add') add.mutate({ name: pending.name, email: pending.email, confirm: true })
  }

  function closeDialog() {
    setPending(null)
    draw.reset()
    remove.reset()
    add.reset()
    deleteGroup.reset()
  }

  const dialog =
    pending?.kind === 'redraw'
      ? { title: 'Redraw names?', body: REDRAW_BODY, label: 'Redraw', busy: draw.isPending, error: draw.error }
      : pending?.kind === 'remove'
        ? {
            title: `Remove ${pending.person.name}?`,
            body: drawn
              ? `Their wish list is deleted and names are drawn again. ${REDRAW_BODY}`
              : 'Their wish list is deleted.',
            label: drawn ? 'Remove and redraw' : 'Remove',
            busy: remove.isPending,
            error: remove.error,
          }
        : pending?.kind === 'delete'
          ? {
              title: `Delete ${group.name}?`,
              body: "Everyone's details, wish lists and the draw are deleted. This can't be undone.",
              label: 'Delete group',
              busy: deleteGroup.isPending,
              error: deleteGroup.error,
            }
        : pending?.kind === 'add'
          ? { title: `Add ${pending.name} and redraw?`, body: REDRAW_BODY, label: 'Add and redraw', busy: add.isPending, error: add.error }
          : null

  return (
    <main className="page">
      <HeaderBand roomy>
        <div className="band__stack">
          <h1 className="band__title">{group.name}</h1>
          <p className="band__facts">
            Gift swap {formatDate(group.gift_date)} · Budget {formatBudget(group.budget_min, group.budget_max)}
          </p>
        </div>
        <span className="pill">{daysToGo(group.days_to_go)}</span>
      </HeaderBand>
      <div className="content">
        <div className="layout layout--interleave">
          <div className="layout__main">
            <PeopleCard
              people={people}
              editing={editing}
              onToggleEdit={() => setEditing((e) => !e)}
              onRemove={(person) => setPending({ kind: 'remove', person })}
            >
              <form className="add-person" onSubmit={submitAdd} noValidate aria-label="Add someone">
                <div className="grid-2">
                  <Field label="Name" value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} error={addErrors.name} />
                  <Field label="Email (optional)" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} error={addErrors.email} />
                </div>
                {add.error && !pending && (
                  <p className="alert" role="alert" style={{ margin: 0 }}>
                    {add.error.message}
                  </p>
                )}
                <button type="submit" className="btn btn--primary" disabled={add.isPending}>
                  Add
                </button>
              </form>
            </PeopleCard>
          </div>
          <div className="layout__side">
            <div className="m-first">
              <CodewordCard
                codeword={group.codeword}
                onChange={async (codeword) => {
                  await api(`/groups/${group.id}`, { method: 'PATCH', token, body: { codeword } })
                  await refresh()
                }}
              />
            </div>
            {me && drawn && (
              <Link className="btn btn--main btn--block m-first" to={`/g/${token}/giftee`}>
                See who you're buying for
              </Link>
            )}
            {me && (
              <div className="card row-card m-first">
                <div className="row-card__text">
                  <span style={{ fontWeight: 700 }}>Your wish list</span>
                  <span className="row-card__sub">{me.status === 'wish_list_in' ? 'Added' : 'Nothing added yet'}</span>
                </div>
                <Link className="btn btn--secondary" to={`/g/${token}/wishlist`} aria-label="Open your wish list">
                  Open
                </Link>
              </div>
            )}
            <div className="card row-card">
              <div className="row-card__text">
                <span style={{ fontWeight: 700 }}>Exclusions</span>
                <span className="row-card__sub">
                  {pairs === 0 ? 'No exclusions yet' : pairs === 1 ? "1 pair can't be matched" : `${pairs} pairs can't be matched`}
                </span>
              </div>
              <Link className="btn btn--secondary" to={`/g/${token}/exclusions`} aria-label="Edit exclusions">
                Edit
              </Link>
            </div>

            {draw.error && !pending && (
              <p className="alert" role="alert" style={{ margin: 0 }}>
                {drawErrorMessage(draw.error, people)}
              </p>
            )}

            {drawn ? (
              <div className="card row-card drawn-card">
                <div className="row-card__text">
                  <strong>Names drawn</strong>
                  {group.drawn_at && <span className="row-card__sub">{formatDateTime(group.drawn_at)}</span>}
                </div>
                <button type="button" className="btn btn--secondary" onClick={() => setPending({ kind: 'redraw' })}>
                  Redraw
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--main btn--block"
                disabled={people.length < MIN_PEOPLE || draw.isPending}
                onClick={() => draw.mutate(false)}
              >
                <GiftIcon />
                {draw.isPending ? 'Drawing...' : 'Run the draw'}
              </button>
            )}
            <button type="button" className="link-btn link-btn--danger" style={{ alignSelf: 'center' }} onClick={() => setPending({ kind: 'delete' })}>
              Delete this group
            </button>
          </div>
        </div>
      </div>

      {celebrate && <Confetti onDone={() => setCelebrate(false)} />}
      {dialog && (
        <ConfirmDialog
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.label}
          busy={dialog.busy}
          error={dialog.error ? drawErrorMessage(dialog.error, people) : undefined}
          onConfirm={confirmPending}
          onCancel={closeDialog}
        />
      )}
    </main>
  )
}
