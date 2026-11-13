import { useState, type FormEvent } from 'react'
import { Field } from './Field'

export const CODEWORD_MIN = 4

export function codewordError(value: string): string | undefined {
  const letters = value.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!value.trim()) return 'Choose a codeword'
  if (letters.length < CODEWORD_MIN) return `Use at least ${CODEWORD_MIN} letters or numbers`
  return undefined
}

/** The message friends need: where to go and what to type. */
export function shareMessage(codeword: string): string {
  return `Join our Secret Santa: go to ${window.location.origin} and enter the codeword ${codeword}`
}

type Props = {
  codeword: string
  /** When given, the organiser can change the codeword. */
  onChange?: (codeword: string) => Promise<unknown>
}

export function CodewordCard({ codeword, onChange }: Props) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(codeword)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)

  async function copy() {
    const text = shareMessage(codeword)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Codeword', text)
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const problem = codewordError(draft)
    setError(problem)
    if (problem || !onChange) return
    setSaving(true)
    try {
      await onChange(draft.trim())
      setEditing(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <form className="card stack" onSubmit={save} noValidate aria-label="Change codeword">
        <Field label="New codeword" value={draft} maxLength={40} autoComplete="off" onChange={(e) => setDraft(e.target.value)} error={error} />
        <div className="codeword__actions">
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="card">
      <div className="codeword__head">
        <span className="card__label">Codeword</span>
        {onChange && (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setDraft(codeword)
              setError(undefined)
              setEditing(true)
            }}
          >
            Change
          </button>
        )}
      </div>
      <div className="linkbox">
        <div className="linkbox__value codeword__value">
          <span>{codeword}</span>
        </div>
        <button type="button" className="btn btn--primary" onClick={copy} aria-label="Copy invite message">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <span className="visually-hidden" role="status">
        {copied ? 'Copied' : ''}
      </span>
    </div>
  )
}
