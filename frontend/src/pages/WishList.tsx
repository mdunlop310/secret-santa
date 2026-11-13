import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type Me, type WishlistItem } from '../api'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { GiftTag } from '../components/GiftTag'
import { HeaderBand } from '../components/HeaderBand'
import { ItemForm, type ItemInput } from '../components/ItemForm'
import { ErrorState, LoadingPage } from '../components/States'
import { formatBudget } from '../format'
import { useMemberLinks } from '../links'
import { forgetGroup, useRememberGroup } from '../remember'

function Arrow({ up }: { up?: boolean }) {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={up ? 'M12 19V5M5 12l7-7 7 7' : 'M12 5v14M5 12l7 7 7-7'} />
    </svg>
  )
}

export function WishListPage() {
  const links = useMemberLinks()
  const { token, organiser } = links
  const queryClient = useQueryClient()
  const key = ['me', token]
  const query = useQuery({ queryKey: key, queryFn: () => api<Me>('/me', { token }) })
  useRememberGroup(organiser ? 'admin' : 'participant', token, query.data?.group, query.error)
  const [editing, setEditing] = useState<number | null>(null)
  const [leaving, setLeaving] = useState(false)
  // Local state so the checkbox changes in the same render as the tap (no flicker).
  const [surpriseShown, setSurpriseShown] = useState<boolean | null>(null)
  const navigate = useNavigate()

  const setMe = (update: (me: Me) => Me) => queryClient.setQueryData<Me>(key, (me) => (me ? update(me) : me))
  const refresh = () => queryClient.invalidateQueries({ queryKey: key })

  const surprise = useMutation({
    mutationFn: (secret_surprise: boolean) => api<Me>('/me', { method: 'PUT', token, body: { secret_surprise } }),
    onSuccess: (me) => queryClient.setQueryData(key, me),
    // Until saved, the box shows what was tapped; on failure it falls back to the server.
    onSettled: () => setSurpriseShown(null),
  })
  const addItem = useMutation({
    mutationFn: (item: ItemInput) => api<WishlistItem>('/me/items', { method: 'POST', token, body: item }),
    onSuccess: (item) => setMe((me) => ({ ...me, items: [...me.items, item] })),
  })
  const editItem = useMutation({
    mutationFn: ({ id, item }: { id: number; item: ItemInput }) =>
      api<WishlistItem>(`/me/items/${id}`, { method: 'PATCH', token, body: item }),
    onSuccess: (item) => {
      setMe((me) => ({ ...me, items: me.items.map((i) => (i.id === item.id ? item : i)) }))
      setEditing(null)
    },
  })
  const removeItem = useMutation({
    mutationFn: (id: number) => api(`/me/items/${id}`, { method: 'DELETE', token }),
    onSuccess: (_data, id) => setMe((me) => ({ ...me, items: me.items.filter((i) => i.id !== id) })),
  })
  const leave = useMutation({
    mutationFn: () => api('/me', { method: 'DELETE', token }),
    onSuccess: () => {
      forgetGroup(token)
      queryClient.removeQueries({ queryKey: key })
      navigate('/left', { replace: true })
    },
  })
  const reorder = useMutation({
    mutationFn: (ids: number[]) => api<WishlistItem[]>('/me/items/order', { method: 'PUT', token, body: { ids } }),
    onMutate: (ids) => {
      setMe((me) => ({ ...me, items: ids.map((id) => me.items.find((i) => i.id === id)!) }))
    },
    onError: refresh,
  })

  if (query.isPending) return <LoadingPage />
  if (query.isError) return <ErrorState error={query.error} />
  const me = query.data
  const { group, items } = me
  const surpriseOn = surpriseShown ?? me.secret_surprise

  function move(index: number, by: -1 | 1) {
    const ids = items.map((i) => i.id)
    ;[ids[index], ids[index + by]] = [ids[index + by], ids[index]]
    reorder.mutate(ids)
  }

  const listError = removeItem.error ?? reorder.error ?? surprise.error

  const itemList =
    items.length > 0 ? (
      <ul className="items" aria-label="Your items">
        {items.map((item, index) =>
          editing === item.id ? (
            <li key={item.id}>
              <ItemForm
                token={token}
                heading="Edit item"
                initial={item}
                saving={editItem.isPending}
                error={editItem.error?.message}
                onSave={(input) => editItem.mutateAsync({ id: item.id, item: input })}
                onCancel={() => {
                  editItem.reset()
                  setEditing(null)
                }}
              />
            </li>
          ) : (
            <li key={item.id}>
              <GiftTag
                item={item}
                budgetMax={group.budget_max}
                actions={
                  <>
                    <button type="button" className="link-btn" onClick={() => setEditing(item.id)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="link-btn link-btn--danger"
                      disabled={removeItem.isPending}
                      onClick={() => removeItem.mutate(item.id)}
                    >
                      Remove
                    </button>
                    {items.length > 1 && (
                      <>
                        <span className="spacer" />
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Move ${item.title} up`}
                          disabled={index === 0 || reorder.isPending}
                          onClick={() => move(index, -1)}
                        >
                          <Arrow up />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Move ${item.title} down`}
                          disabled={index === items.length - 1 || reorder.isPending}
                          onClick={() => move(index, 1)}
                        >
                          <Arrow />
                        </button>
                      </>
                    )}
                  </>
                }
              />
            </li>
          ),
        )}
      </ul>
    ) : (
      <p className="note-card muted desk-only">No items yet</p>
    )

  return (
    <main className="page">
      <HeaderBand
        compact={organiser}
        top={
          organiser ? (
            <Link className="band__back" to={links.home}>
              Back to group
            </Link>
          ) : undefined
        }
        aside={me.name}
      >
        <h1 className="band__title band__title--sub">Your wish list</h1>
        <p className="band__facts">Budget {formatBudget(group.budget_min, group.budget_max)}</p>
      </HeaderBand>
      <div className="content content--tight">
        <div className="layout layout--interleave">
          <div className="layout__main">
            {listError && (
              <p className="alert" role="alert" style={{ margin: 0 }}>
                {listError.message}
              </p>
            )}
            {surpriseOn ? <p className="note-card desk-only">Secret surprise is on</p> : itemList}
          </div>
          <div className="layout__side">
            {group.draw_status === 'drawn' && (
              <Link className="btn btn--main btn--block m-first" to={links.giftee}>
                See who you're buying for
              </Link>
            )}
            <div className="surprise-card m-first">
              <input
                id="surprise"
                type="checkbox"
                checked={surpriseOn}
                onChange={(e) => {
                  setSurpriseShown(e.target.checked)
                  surprise.mutate(e.target.checked)
                }}
              />
              <label htmlFor="surprise">Secret surprise: skip my list</label>
            </div>
            {!surpriseOn && (
              <ItemForm
                token={token}
                heading="Add an item"
                saving={addItem.isPending}
                error={addItem.error?.message}
                onSave={(input) => addItem.mutateAsync(input)}
              />
            )}
            {!organiser && !me.is_admin && (
              <button type="button" className="link-btn link-btn--danger" style={{ alignSelf: 'center' }} onClick={() => setLeaving(true)}>
                Leave this Secret Santa
              </button>
            )}
          </div>
        </div>
      </div>
      {leaving && (
        <ConfirmDialog
          title={`Leave ${group.name}?`}
          body={
            group.draw_status === 'drawn'
              ? 'Your details and wish list are deleted, and names are drawn again for everyone else.'
              : 'Your details and wish list are deleted.'
          }
          confirmLabel="Leave"
          busy={leave.isPending}
          error={leave.error?.message}
          onConfirm={() => leave.mutate()}
          onCancel={() => {
            leave.reset()
            setLeaving(false)
          }}
        />
      )}
    </main>
  )
}
