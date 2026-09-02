// src/pages/TrashPage.jsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api, formatMoney } from '../utils/api'
import { parseServerDate, formatDateTime } from '../utils/datetime'
import Modal from '../components/Modal'
import Pagination from '../components/Pagination'
import { usePagination } from '../hooks/usePagination'

const TYPE_ICON = { product: '📦', category: '🏷️', expense: '💸' }
const SSE_TYPES = new Set([
  'product_deleted', 'category_deleted', 'expense_deleted',
  'product_restored', 'category_restored', 'expense_restored',
  'product_purged', 'category_purged', 'expense_purged',
])

function timeAgo(value, T) {
  const d = parseServerDate(value)
  if (!d || isNaN(d.getTime())) return '—'
  const secs = Math.max(0, (Date.now() - d.getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return formatDateTime(value)
}

function fill(str, vars) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), str)
}

export default function TrashPage() {
  const { currency, toast, onSSE } = useApp()
  const T = useT()

  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [sortBy, setSortBy] = useState('recent')
  const [busyKeys, setBusyKeys] = useState(() => new Set())
  const [outKeys, setOutKeys] = useState(() => new Set())
  const [confirmDelete, setConfirmDelete] = useState(null) // item
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [emptying, setEmptying] = useState(false)
  const removeTimers = useRef({})

  const key = (it) => `${it.entity_type}:${it.id}`

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getTrash()
      setItems(data)
    } catch { toast(T('trash_load_failed'), 'error') }
    finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => onSSE(evt => { if (SSE_TYPES.has(evt.type)) load() }), [load, onSSE])
  useEffect(() => () => { Object.values(removeTimers.current).forEach(clearTimeout) }, [])

  function setBusy(k, on) {
    setBusyKeys(s => { const n = new Set(s); on ? n.add(k) : n.delete(k); return n })
  }

  // Play the exit animation, then actually drop the row from state — so
  // Restore/Delete Forever feel instant instead of waiting on the next
  // full reload to visually confirm anything happened.
  function animateOutThenRemove(k) {
    setOutKeys(s => new Set(s).add(k))
    removeTimers.current[k] = setTimeout(() => {
      setItems(list => list.filter(it => key(it) !== k))
      setOutKeys(s => { const n = new Set(s); n.delete(k); return n })
    }, 260)
  }

  async function doRestore(it) {
    const k = key(it)
    setBusy(k, true)
    try {
      await api.restoreTrashItem(it.entity_type, it.id)
      toast(T('trash_restore_ok'), 'success')
      animateOutThenRemove(k)
    } catch (err) {
      toast(err.message || T('trash_restore_failed'), 'error')
    } finally { setBusy(k, false) }
  }

  async function doHardDelete(it) {
    const k = key(it)
    setBusy(k, true)
    try {
      await api.hardDeleteTrashItem(it.entity_type, it.id)
      toast(T('trash_hard_delete_ok'), 'success')
      setConfirmDelete(null)
      animateOutThenRemove(k)
    } catch (err) {
      toast(err.message || T('trash_hard_delete_failed'), 'error')
      setConfirmDelete(null)
    } finally { setBusy(k, false) }
  }

  async function doEmptyTrash() {
    setEmptying(true)
    try {
      const res = await api.emptyTrash()
      toast(fill(T('trash_empty_trash_result'), { purged: res.purged, skipped: res.skipped }), 'success')
      setConfirmEmpty(false)
      load()
    } catch (err) {
      toast(err.message || T('trash_hard_delete_failed'), 'error')
    } finally { setEmptying(false) }
  }

  const counts = useMemo(() => {
    const c = { product: 0, category: 0, expense: 0 }
    items.forEach(it => { c[it.entity_type] = (c[it.entity_type] || 0) + 1 })
    return c
  }, [items])

  const filtered = useMemo(() => {
    let list = items
    if (typeFilter !== 'all') list = list.filter(it => it.entity_type === typeFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(it =>
        it.title?.toLowerCase().includes(q) || it.subtitle?.toLowerCase().includes(q)
      )
    }
    const sorted = [...list]
    if (sortBy === 'recent') sorted.sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''))
    else if (sortBy === 'oldest') sorted.sort((a, b) => (a.deleted_at || '').localeCompare(b.deleted_at || ''))
    else if (sortBy === 'name') sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
    return sorted
  }, [items, typeFilter, search, sortBy])

  const pag = usePagination(filtered, { pageSize: 12, resetKey: typeFilter + search + sortBy })

  function metaPills(it) {
    if (it.entity_type === 'product') {
      return [
        it.meta.sku,
        formatMoney(it.meta.selling_price, currency),
        `${it.meta.current_stock} ${it.meta.unit_type || ''}`.trim(),
      ]
    }
    if (it.entity_type === 'category') {
      return [it.meta.products_using > 0 ? `${it.meta.products_using} product(s) linked` : 'Unused']
    }
    if (it.entity_type === 'expense') {
      return [formatMoney(it.meta.amount, currency), it.meta.expense_date, it.meta.payment_method].filter(Boolean)
    }
    return []
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">🗑️ {T('trash_title')}</div>
          <div className="page-sub">{T('trash_subtitle')}</div>
        </div>
        <button
          className="btn btn-danger"
          disabled={items.length === 0}
          onClick={() => setConfirmEmpty(true)}
        >
          🔥 {T('trash_empty_trash')}
        </button>
      </div>

      {/* Type summary chips — also act as quick filters */}
      {!loading && items.length > 0 && (
        <div className="trash-stats">
          {['product', 'category', 'expense'].map(t => (
            <div
              key={t}
              className="trash-stat-chip"
              style={{ cursor: 'pointer', borderColor: typeFilter === t ? 'var(--accent)' : undefined, opacity: counts[t] ? 1 : .5 }}
              onClick={() => setTypeFilter(f => f === t ? 'all' : t)}
            >
              <span className="chip-icon">{TYPE_ICON[t]}</span>
              <span className="chip-count">{counts[t] || 0}</span>
              <span className="chip-label">{T(`trash_type_${t}`)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="filters-row card" style={{ padding: '12px 16px', marginBottom: 16 }}>
        <div className="input-group" style={{ flex: 1, minWidth: 200 }}>
          <label className="input-label">{T('trash_search')}</label>
          <input className="input input-sm" placeholder={T('trash_search')} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="input-group">
          <label className="input-label">{T('trash_filter_all')}</label>
          <select className="input input-sm" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="all">{T('trash_filter_all')}</option>
            <option value="product">{T('trash_type_product')}</option>
            <option value="category">{T('trash_type_category')}</option>
            <option value="expense">{T('trash_type_expense')}</option>
          </select>
        </div>
        <div className="input-group">
          <label className="input-label">Sort</label>
          <select className="input input-sm" value={sortBy} onChange={e => setSortBy(e.target.value)}>
            <option value="recent">{T('trash_sort_recent')}</option>
            <option value="oldest">{T('trash_sort_oldest')}</option>
            <option value="name">{T('trash_sort_name')}</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="trash-grid">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="trash-card" style={{ animationDelay: `${i * 0.05}s` }}>
              <div className="trash-card-top">
                <div className="skeleton" style={{ width: 38, height: 38, borderRadius: 10 }} />
                <div style={{ flex: 1 }}>
                  <div className="skeleton" style={{ height: 14, width: '70%', marginBottom: 6 }} />
                  <div className="skeleton" style={{ height: 11, width: '40%' }} />
                </div>
              </div>
              <div className="skeleton" style={{ height: 32, width: '100%' }} />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state card">
          <div style={{ fontSize: 40 }}>🗑️</div>
          <div style={{ fontWeight: 700, color: 'var(--text)' }}>
            {items.length === 0 ? T('trash_empty_state') : T('trash_empty_state')}
          </div>
          <div>{items.length === 0 ? T('trash_empty_state_sub') : 'No items match your search/filter.'}</div>
        </div>
      ) : (
        <div className="trash-grid pagination-page-in" key={pag.page}>
          {pag.paged.map((it, i) => {
            const k = key(it)
            const busy = busyKeys.has(k)
            const out = outKeys.has(k)
            return (
              <div
                key={k}
                className={`trash-card type-${it.entity_type} ${out ? 'card-out' : ''} ${busy ? 'card-busy' : ''}`}
                style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
              >
                <div className="trash-card-top">
                  <div className="trash-card-icon">{TYPE_ICON[it.entity_type]}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="trash-card-title">{it.title}</div>
                    {it.subtitle && <div className="trash-card-subtitle">{it.subtitle}</div>}
                  </div>
                  <span className={`badge badge-${it.entity_type === 'product' ? 'teal' : it.entity_type === 'category' ? 'blue' : 'amber'}`}>
                    {T(`trash_type_${it.entity_type}`)}
                  </span>
                </div>

                <div className="trash-card-meta">
                  {metaPills(it).map((m, idx) => <span key={idx} className="trash-card-meta-item">{m}</span>)}
                </div>

                <div className="trash-card-footer">
                  <div className="trash-card-deleted-info">
                    {T('trash_deleted_at')} <b>{timeAgo(it.deleted_at, T)}</b><br />
                    {T('trash_deleted_by')}: <b>{it.deleted_by_name || T('trash_unknown_user')}</b>
                  </div>
                  <div className="trash-card-actions">
                    <button
                      className="btn btn-success btn-icon"
                      title={T('trash_restore')}
                      disabled={busy}
                      onClick={() => doRestore(it)}
                    >
                      {busy ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : '↩️'}
                    </button>
                    <button
                      className="btn btn-danger btn-icon"
                      title={T('trash_hard_delete')}
                      disabled={busy}
                      onClick={() => setConfirmDelete(it)}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <Pagination page={pag.page} totalPages={pag.totalPages} total={pag.total} pageSize={pag.pageSize} onChange={pag.setPage} />
      )}

      {confirmDelete && (
        <Modal title={`⚠️ ${T('trash_hard_delete_confirm_title')}`} onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setConfirmDelete(null)}>{T('trash_cancel')}</button>
              <button className="btn btn-danger" disabled={busyKeys.has(key(confirmDelete))} onClick={() => doHardDelete(confirmDelete)}>
                {busyKeys.has(key(confirmDelete)) ? <span className="spinner" /> : T('trash_confirm_delete_forever')}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div className="trash-card-icon" style={{ background: 'rgba(239,68,68,.15)' }}>{TYPE_ICON[confirmDelete.entity_type]}</div>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{confirmDelete.title}</div>
              <p style={{ color: 'var(--text2)', margin: 0 }}>{T('trash_hard_delete_confirm_body')}</p>
            </div>
          </div>
        </Modal>
      )}

      {confirmEmpty && (
        <Modal title={`🔥 ${T('trash_empty_trash_confirm_title')}`} onClose={() => setConfirmEmpty(false)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setConfirmEmpty(false)}>{T('trash_cancel')}</button>
              <button className="btn btn-danger" disabled={emptying} onClick={doEmptyTrash}>
                {emptying ? <span className="spinner" /> : T('trash_confirm_delete_forever')}
              </button>
            </>
          }
        >
          <p style={{ color: 'var(--text2)' }}>{T('trash_empty_trash_confirm_body')}</p>
        </Modal>
      )}
    </div>
  )
}
