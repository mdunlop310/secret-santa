const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export class ApiError extends Error {
  status: number
  /** Machine-readable reason for 409s, e.g. "confirm_redraw" or "no_valid_draw". */
  code?: string
  detail?: Record<string, unknown>
  constructor(status: number, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.detail = detail
    this.code = typeof detail?.code === 'string' ? detail.code : undefined
  }
}

type Options = { method?: string; token?: string; body?: unknown }

export async function api<T>(path: string, { method = 'GET', token, body }: Options = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      referrerPolicy: 'no-referrer',
    })
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.")
  }
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail
    const structured = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>) : undefined
    throw new ApiError(response.status, errorMessage(response.status, data), structured)
  }
  return data as T
}

function errorMessage(status: number, data: unknown): string {
  const detail = (data as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object' && 'message' in detail) return String((detail as { message: unknown }).message)
  if (Array.isArray(detail) && detail.length > 0) {
    const msg = String(detail[0]?.msg ?? '')
    return msg.replace(/^Value error, /, '') || 'Please check the form.'
  }
  if (status === 429) return 'Too many requests. Try again later.'
  return 'Something went wrong. Please try again.'
}

export type GroupPublic = {
  id: number
  name: string
  gift_date: string
  budget_min: number
  budget_max: number
  message: string | null
  admin_name: string
  draw_status: 'not_drawn' | 'drawn'
  days_to_go: number
}

export type ParticipantStatus = 'invited' | 'joined' | 'wish_list_in'

export type ParticipantSummary = {
  id: number
  name: string
  status: ParticipantStatus
  is_admin: boolean
}

export type AdminGroup = GroupPublic & {
  codeword: string
  invite_link: string
  drawn_at: string | null
  show_exclusions: boolean
  exclusion_pair_count: number
  participants: ParticipantSummary[]
}

export type GroupCreate = {
  name: string
  gift_date: string
  budget_min: number
  budget_max: number
  message: string | null
  codeword: string
  admin_name: string
  admin_email: string
  admin_participates: boolean
}

export type GroupCreated = {
  group_id: number
  /** The organiser's one link: it runs the group and holds their own wish list. */
  admin_link: string
  invite_link: string
}

export type JoinResult = { status: 'joined' | 'sent'; participant_link: string | null }

export type OpenedLink = { kind: 'admin' | 'participant'; link: string }

/** What the group's codeword opens: the group and everyone's names, nothing more. */
export type EnteredGroup = InvitePreview & {
  draw_status: 'not_drawn' | 'drawn'
  people: { id: number; name: string }[]
}

export type EnteredLink = { link: string }

export type InvitePreview = {
  group_name: string
  admin_name: string
  gift_date: string
  budget_min: number
  budget_max: number
  message: string | null
}

export type WishlistItem = {
  id: number
  title: string
  url: string | null
  price: number | null
  image_url: string | null
}

export type Me = {
  id: number
  name: string
  is_admin: boolean
  secret_surprise: boolean
  group: GroupPublic
  items: WishlistItem[]
}

export type Giftee = {
  name: string
  secret_surprise: boolean
  items: WishlistItem[]
  updated_at: string | null
  updated_since_draw: boolean
}

export type GifteeResponse = { drawn: boolean; giftee: Giftee | null }

export type Bottleneck = { side: 'give' | 'receive'; people: number[]; options: number[] }
