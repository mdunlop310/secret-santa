import { useMutation, useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, type InvitePreview, type JoinResult } from '../api'
import { Field } from '../components/Field'
import { HeaderBand } from '../components/HeaderBand'
import { ErrorState, LoadingPage, MessagePage } from '../components/States'
import { formatBudget, formatDate } from '../format'

type JoinBody = { name: string; email: string | null }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function useJoin(inviteToken: string) {
  return useMutation({
    mutationFn: (body: JoinBody) => api<JoinResult>(`/join/${inviteToken}`, { method: 'POST', body }),
  })
}

export function JoinPage() {
  const { inviteToken = '' } = useParams()
  const navigate = useNavigate()
  const preview = useQuery({
    queryKey: ['invite', inviteToken],
    queryFn: () => api<InvitePreview>(`/join/${inviteToken}`),
  })
  const join = useJoin(inviteToken)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({})

  if (preview.isPending) return <LoadingPage />
  if (preview.isError) return <ErrorState error={preview.error} />
  const group = preview.data

  function submit(e: FormEvent) {
    e.preventDefault()
    const next = {
      name: name.trim() ? undefined : 'Enter your name',
      email: !email.trim() || EMAIL_RE.test(email.trim()) ? undefined : 'Enter a valid email',
    }
    setErrors(next)
    if (next.name || next.email) return
    const body = { name: name.trim(), email: email.trim() || null }
    join.mutate(body, {
      onSuccess: (result) => {
        // New people go straight to their wish list. If the email is already in the
        // group, the link only goes to that inbox.
        if (result.status === 'joined' && result.participant_link) {
          navigate(new URL(result.participant_link).pathname, { replace: true })
        } else {
          navigate('check-email', { state: body })
        }
      },
    })
  }

  return (
    <main className="page page--narrow">
      <HeaderBand tall>
        <div className="band__stack band__stack--tight">
          <span className="band__eyebrow">You're invited</span>
          <h1 className="band__title">{group.group_name}</h1>
          <p className="band__facts">Hosted by {group.admin_name}</p>
        </div>
        <div className="band__pills">
          <span className="pill">{formatDate(group.gift_date)}</span>
          <span className="pill">{formatBudget(group.budget_min, group.budget_max)}</span>
        </div>
      </HeaderBand>
      <form className="content content--form" style={{ gap: 12 }} onSubmit={submit} noValidate>
        {group.message && (
          <p className="card card--note" style={{ margin: 0 }}>
            <strong>From {group.admin_name}:</strong> {group.message}
          </p>
        )}
        <Field label="Your name" placeholder="How the group knows you" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={60} />
        <Field label="Email (optional)" type="email" placeholder="For reminders" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        {join.error && (
          <p className="alert" role="alert" style={{ margin: 0 }}>
            {join.error.message}
          </p>
        )}
        <button type="submit" className="btn btn--main btn--block" disabled={join.isPending}>
          {join.isPending ? 'Joining...' : 'Join this Secret Santa'}
        </button>
      </form>
    </main>
  )
}

export function CheckEmailPage() {
  const { inviteToken = '' } = useParams()
  const body = useLocation().state as JoinBody | null
  const resend = useJoin(inviteToken)

  if (!body) {
    return (
      <MessagePage title="Check your email">
        <p style={{ margin: 0 }}>We've sent you your link.</p>
      </MessagePage>
    )
  }

  return (
    <MessagePage title="Check your email">
      <p style={{ margin: 0 }}>
        <strong>{body.email}</strong> is already in this group. We've sent its link there.
      </p>
      {resend.error && (
        <p className="alert" role="alert" style={{ margin: 0 }}>
          {resend.error.message}
        </p>
      )}
      <button
        type="button"
        className="btn btn--secondary"
        disabled={resend.isPending}
        onClick={() => resend.mutate(body)}
      >
        {resend.isSuccess ? 'Sent again' : 'Re-send link'}
      </button>
      <span className="visually-hidden" role="status">
        {resend.isSuccess ? 'Link sent again' : ''}
      </span>
    </MessagePage>
  )
}
