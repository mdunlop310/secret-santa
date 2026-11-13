import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type EnteredGroup, type EnteredLink } from '../api'
import { Field } from '../components/Field'
import { HeaderBand } from '../components/HeaderBand'
import { SavedGroupsCard, useSavedGroups } from '../components/SavedGroups'
import { formatBudget, formatDate } from '../format'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The home page: type the group's codeword, then tap your name or join. */
export function EnterPage() {
  const [codeword, setCodeword] = useState('')
  const [error, setError] = useState<string>()
  const saved = useSavedGroups()
  const enter = useMutation({
    mutationFn: (word: string) => api<EnteredGroup>('/enter', { method: 'POST', body: { codeword: word } }),
  })

  if (enter.data && enter.variables) {
    return <PickName group={enter.data} codeword={enter.variables} onBack={() => enter.reset()} />
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const word = codeword.trim()
    setError(word ? undefined : 'Enter the codeword')
    if (word) enter.mutate(word)
  }

  const hasSaved = saved.groups.length > 0
  return (
    <main className={hasSaved ? 'page page--medium' : 'page page--narrow'}>
      <HeaderBand>
        <h1 className="band__title">Secret Santa</h1>
      </HeaderBand>
      <div className="content content--form">
        <div className="layout layout--form">
          <div className="layout__main stack">
            <form className="stack" onSubmit={submit} noValidate>
              <Field
                label="Group codeword"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={40}
                value={codeword}
                onChange={(e) => setCodeword(e.target.value)}
                error={error ?? (enter.error ? enter.error.message : undefined)}
              />
              <button type="submit" className="btn btn--main btn--block" disabled={enter.isPending}>
                {enter.isPending ? 'Finding...' : 'Find my group'}
              </button>
            </form>
            <Link className="btn btn--secondary btn--block" to="/new">
              Start a new Secret Santa
            </Link>
          </div>
          {hasSaved && (
            <aside className="layout__side">
              <SavedGroupsCard groups={saved.groups} onForget={saved.forget} />
            </aside>
          )}
        </div>
      </div>
    </main>
  )
}

function PickName({ group, codeword, onBack }: { group: EnteredGroup; codeword: string; onBack: () => void }) {
  const navigate = useNavigate()
  const go = (result: EnteredLink) => navigate(new URL(result.link).pathname, { replace: true })
  const pick = useMutation({
    mutationFn: (participant_id: number) =>
      api<EnteredLink>('/enter/pick', { method: 'POST', body: { codeword, participant_id } }),
    onSuccess: go,
  })
  const join = useMutation({
    mutationFn: (body: { name: string; email: string | null }) =>
      api<EnteredLink>('/enter/join', { method: 'POST', body: { codeword, ...body } }),
    onSuccess: go,
  })
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({})
  const open = group.draw_status !== 'drawn'

  function submitJoin(e: FormEvent) {
    e.preventDefault()
    const trimmedEmail = email.trim()
    const next = {
      name: name.trim() ? undefined : 'Enter your name',
      email: !trimmedEmail || EMAIL_RE.test(trimmedEmail) ? undefined : 'Enter a valid email',
    }
    setErrors(next)
    if (next.name || next.email) return
    join.mutate({ name: name.trim(), email: trimmedEmail || null })
  }

  return (
    <main className="page page--narrow">
      <HeaderBand tall>
        <div className="band__stack band__stack--tight">
          <h1 className="band__title">{group.group_name}</h1>
          <p className="band__facts">Hosted by {group.admin_name}</p>
        </div>
        <div className="band__pills">
          <span className="pill">{formatDate(group.gift_date)}</span>
          <span className="pill">{formatBudget(group.budget_min, group.budget_max)}</span>
        </div>
      </HeaderBand>
      <div className="content content--form">
        {group.message && (
          <p className="card card--note" style={{ margin: 0 }}>
            <strong>From {group.admin_name}:</strong> {group.message}
          </p>
        )}
        {group.people.length > 0 && (
          <section className="stack" aria-labelledby="who-heading">
            <h2 id="who-heading" className="divider-heading" style={{ margin: 0 }}>
              Who are you?
            </h2>
            <ul className="names">
              {group.people.map((person) => (
                <li key={person.id}>
                  <button type="button" className="btn btn--secondary" disabled={pick.isPending} onClick={() => pick.mutate(person.id)}>
                    {person.name}
                  </button>
                </li>
              ))}
            </ul>
            {pick.error && (
              <p className="alert" role="alert" style={{ margin: 0 }}>
                {pick.error.message}
              </p>
            )}
          </section>
        )}
        {open && (
          <form className="stack" onSubmit={submitJoin} noValidate aria-labelledby="join-heading">
            <h2 id="join-heading" className="divider-heading" style={{ margin: '6px 0 0' }}>
              {group.people.length > 0 ? 'Not on the list?' : 'Join this Secret Santa'}
            </h2>
            <Field label="Your name" placeholder="How the group knows you" autoComplete="name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
            <Field label="Email (optional)" type="email" placeholder="For reminders" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
            {join.error && (
              <p className="alert" role="alert" style={{ margin: 0 }}>
                {join.error.message}
              </p>
            )}
            <button type="submit" className="btn btn--main btn--block" disabled={join.isPending}>
              {join.isPending ? 'Joining...' : 'Join'}
            </button>
          </form>
        )}
        <button type="button" className="link-btn" style={{ alignSelf: 'center' }} onClick={onBack}>
          Wrong group?
        </button>
      </div>
    </main>
  )
}
