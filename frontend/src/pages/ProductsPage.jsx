// src/pages/ProductsPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api, formatMoney, getCachedProducts, setCachedProducts } from '../utils/api'
import Modal from '../components/Modal'

const UNITS = ['Piece','Liter','Meter','Kg','Box','Set','Pair']

const EMPTY_PRODUCT = {
  name:'', sku:'', category_id:'', buying_price:'', selling_price:'',
  min_stock:'0', unit_type:'Piece', allow_decimal:false,
  shelf_location:'', moto_compat:'', notes:'', is_active:true
}

export default function ProductsPage() {
  const { auth, currency, toast, onSSE, settings } = useApp()
  const T = useT()
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [editModal, setEditModal] = useState(null)
  const [receiveModal, setReceiveModal] = useState(null)
  const [adjustModal, setAdjustModal] = useState(null)
  const [movementsModal, setMovementsModal] = useState(null)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [saving, setSaving] = useState(false)
  const isOwner = auth?.role === 'owner'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [prods, cats] = await Promise.all([api.getProducts(!showInactive), api.getCategories()])
      setProducts(prods)
      setCategories(cats)
    } catch { toast(T('products_load_failed'), 'error') }
    finally { setLoading(false) }
  }, [showInactive])

  useEffect(() => { load() }, [load])
  useEffect(() => onSSE(evt => {
    if (['product_created','product_updated','product_deleted','stock_updated'].includes(evt.type)) load()
  }), [load, onSSE])

  const filtered = products.filter(p => {
    if (catFilter && p.category_id !== Number(catFilter)) return false
    if (!search) return true
    const s = search.toLowerCase()
    return p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s)
  })

  async function saveProduct(form) {
    setSaving(true)
    try {
      const result = form.id ? await api.updateProduct(form.id, form) : await api.createProduct(form)
      if (result?.offline) {
        // FIX (offline support): load() would just re-serve the last
        // cached (pre-change) list offline and make it look like nothing
        // happened. Patch the visible list and the shared products cache
        // (so POS/Stock pages see it too) directly instead.
        toast('Imehifadhiwa nje ya mtandao — itasawazishwa ukirudi mtandaoni', 'warning')
        const patch = (list) => form.id
          ? list.map(p => p.id === form.id ? { ...p, ...form, _pendingSync: true } : p)
          : [{ ...form, id: result.local_ref, current_stock: 0, _pendingSync: true }, ...list]
        setProducts(patch)
        setCachedProducts(patch(getCachedProducts()))
        setEditModal(null)
      } else {
        toast(T('products_save_ok'), 'success')
        setEditModal(null)
        load()
      }
    } catch(err) { toast(err.message || T('products_save_failed'), 'error') }
    finally { setSaving(false) }
  }

  async function deleteProduct(id) {
    try {
      await api.deleteProduct(id)
      toast(T('products_delete_ok'), 'success')
      setDeleteConfirm(null)
      load()
    } catch(err) {
      // FIX (offline support): deletion needs a live server check (sales
      // history), so it can't be queued — make that clear rather than
      // showing a generic failure.
      toast(err.message || (!navigator.onLine ? 'Kufuta kunahitaji mtandao' : 'Cannot delete'), 'error')
    }
  }

  async function receiveStock(pid, form) {
    setSaving(true)
    try {
      const result = await api.receiveStock(pid, form)
      const qty = parseFloat(form.qty) || 0
      if (result?.offline) {
        toast('Akiba imehifadhiwa nje ya mtandao — itasawazishwa ukirudi mtandaoni', 'warning')
        const patch = (list) => list.map(p => p.id === pid ? { ...p, current_stock: (p.current_stock || 0) + qty, _pendingSync: true } : p)
        setProducts(patch)
        setCachedProducts(patch(getCachedProducts()))
        setReceiveModal(null)
      } else {
        toast(T('products_receive_ok'), 'success')
        setReceiveModal(null)
        load()
      }
    } catch(err) { toast(err.message || T('save') + ' failed', 'error') }
    finally { setSaving(false) }
  }

  async function adjustStock(pid, form) {
    setSaving(true)
    try {
      const result = await api.adjustStock(pid, form)
      const delta = parseFloat(form.qty_change) || 0
      if (result?.offline) {
        toast('Marekebisho yamehifadhiwa nje ya mtandao — yatasawazishwa ukirudi mtandaoni', 'warning')
        const patch = (list) => list.map(p => p.id === pid ? { ...p, current_stock: Math.max(0, (p.current_stock || 0) + delta), _pendingSync: true } : p)
        setProducts(patch)
        setCachedProducts(patch(getCachedProducts()))
        setAdjustModal(null)
      } else {
        toast(T('products_adjust_ok'), 'success')
        setAdjustModal(null)
        load()
      }
    } catch(err) { toast(err.message || T('save') + ' failed', 'error') }
    finally { setSaving(false) }
  }

  // FIX 8: Use the configured multiplier from settings, not a hardcoded 1.5.
  // The backend already sets p.low_stock using the same multiplier, so lowCount
  // stays consistent with the per-row badge.
  const multiplier = parseFloat(settings.low_stock_multiplier) || 1.5
  const totalCostValue = products.reduce((s,p) => s + p.current_stock * (p.buying_price || 0), 0)
  const lowCount = products.filter(p => p.low_stock).length

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{T('products_title')}</div>
          <div className="page-sub">{filtered.length} {T('nav_products')}{isOwner && <> · {T('stock_value')}: {formatMoney(totalCostValue, currency)}</>} · {lowCount > 0 ? <span style={{color:'var(--red)'}}>⚠️ {lowCount} {T('products_low_stock')}</span> : `✅ ${T('products_ok')}`}</div>
        </div>
        {isOwner && <button className="btn btn-primary" onClick={() => setEditModal({...EMPTY_PRODUCT})}>{T('products_add')}</button>}
      </div>

      {/* Filters */}
      <div className="filters-row card" style={{padding:'12px 16px',marginBottom:16}}>
        <div className="input-group" style={{flex:2,minWidth:180}}>
          <label className="input-label">{T('search')}</label>
          <input className="input input-sm" placeholder={T("products_search")} value={search} onChange={e=>setSearch(e.target.value)} />
        </div>
        <div className="input-group">
          <label className="input-label">{T('category')}</label>
          <select className="input input-sm" value={catFilter} onChange={e=>setCatFilter(e.target.value)}>
            <option value="">{T('products_all_cats')}</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {isOwner && (
          <div style={{display:'flex',alignItems:'flex-end'}}>
            <button className={`btn btn-sm ${showInactive ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowInactive(v=>!v)}>
              {showInactive ? 'Showing All' : T('products_show_inactive')}
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="card" style={{padding:0,overflow:'hidden'}}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{T('products_col_name')}</th>
                <th>{T('products_col_sku')}</th>
                <th>{T('products_col_cat')}</th>
                {isOwner && <th className="right">{T('products_col_buy')}</th>}
                <th className="right">{T('products_col_sell')}</th>
                <th className="right">{T('products_col_stock')}</th>
                <th className="center">{T('products_col_status')}</th>
                {isOwner && <th className="center">{T('products_col_actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(10)].map((_,i) => (
                  <tr key={i}>{[...Array(isOwner?8:6)].map((_,j) => <td key={j}><div className="skeleton" style={{height:14,width:'75%',borderRadius:4}} /></td>)}</tr>
                ))
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} style={{textAlign:'center',padding:48,color:'var(--text3)'}}>{T('products_empty')}</td></tr>
              ) : filtered.map(p => (
                <tr key={p.id}>
                  <td>
                    <div style={{fontWeight:600}}>{p.name}</div>
                    {p.moto_compat && <div style={{fontSize:11,color:'var(--text3)'}}>{p.moto_compat}</div>}
                  </td>
                  <td style={{fontFamily:'monospace',fontSize:12,color:'var(--teal)'}}>{p.sku}</td>
                  <td style={{fontSize:13,color:'var(--text2)'}}>{p.category_name || '—'}</td>
                  {isOwner && <td className="right" style={{color:'var(--text2)'}}>{formatMoney(p.buying_price, currency)}</td>}
                  <td className="right font-bold" style={{color:'var(--amber)'}}>{formatMoney(p.selling_price, currency)}</td>
                  <td className="right">
                    <span style={{color: p.low_stock ? 'var(--red)' : p.current_stock <= 0 ? 'var(--red)' : 'var(--green)', fontWeight:700}}>
                      {p.low_stock && '⚠️ '}{p.current_stock} {p.unit_type}
                    </span>
                  </td>
                  <td className="center">
                    <span className={`badge ${p.is_active ? 'badge-green' : 'badge-gray'}`}>{p.is_active ? T('products_active') : T('products_inactive')}</span>
                  </td>
                  {isOwner && (
                    <td className="center">
                      <div className="flex gap-2 items-center" style={{justifyContent:'center'}}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setReceiveModal(p)}>{T('products_receive')}</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditModal({...p})}>Edit</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setMovementsModal(p)}>{T('products_movements')}</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit/Create Modal */}
      {editModal && (
        <ProductForm
          initial={editModal}
          categories={categories}
          currency={currency}
          saving={saving}
          onSave={saveProduct}
          onDelete={editModal.id ? () => setDeleteConfirm(editModal.id) : null}
          onAdjust={editModal.id ? (snapshot => () => { setEditModal(null); setAdjustModal(snapshot) })(editModal) : null}
          onClose={() => setEditModal(null)}
        />
      )}

      {/* Receive stock */}
      {receiveModal && (
        <ReceiveStockModal
          product={receiveModal}
          currency={currency}
          saving={saving}
          onSave={(form) => receiveStock(receiveModal.id, form)}
          onClose={() => setReceiveModal(null)}
        />
      )}

      {/* Adjust stock */}
      {adjustModal && (
        <AdjustModal
          product={adjustModal}
          saving={saving}
          onSave={(form) => adjustStock(adjustModal.id, form)}
          onClose={() => setAdjustModal(null)}
        />
      )}

      {/* Movements */}
      {movementsModal && (
        <MovementsModal
          product={movementsModal}
          currency={currency}
          onClose={() => setMovementsModal(null)}
        />
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <Modal title="Delete Product?" onClose={() => setDeleteConfirm(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>{T('cancel')}</button>
              <button className="btn btn-danger" onClick={() => deleteProduct(deleteConfirm)}>{T('delete')}</button>
            </>
          }
        >
          <p style={{color:'var(--text2)'}}>{T('products_delete_failed')}</p>
        </Modal>
      )}
    </div>
  )
}

function ProductForm({
  initial, categories, currency, saving, onSave, onDelete, onAdjust, onClose }) {
  const T = useT()
  const [form, setForm] = useState(initial)
  const set = k => e => setForm(f => ({...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value}))

  return (
    <Modal
      title={form.id ? `Edit — ${form.name}` : 'Add New Product'}
      onClose={onClose}
      size="lg"
      footer={
        <div className="flex justify-between w-full">
          <div className="flex gap-2">
            {onDelete && <button className="btn btn-danger btn-sm" onClick={onDelete}>{T('delete')}</button>}
            {onAdjust && <button className="btn btn-secondary btn-sm" onClick={onAdjust}>Adjust Stock</button>}
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={onClose}>{T('cancel')}</button>
            <button className="btn btn-primary" onClick={() => onSave(form)} disabled={saving}>
              {saving ? <span className="spinner" /> : 'Save Product'}
            </button>
          </div>
        </div>
      }
    >
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
        <div className="input-group" style={{gridColumn:'1/-1'}}>
          <label className="input-label">Product Name *</label>
          <input className="input" value={form.name} onChange={set('name')} required />
        </div>
        <div className="input-group">
          <label className="input-label">SKU</label>
          <input className="input" value={form.sku||''} onChange={set('sku')} placeholder={T('products_form_sku')} />
        </div>
        <div className="input-group">
          <label className="input-label">{T('category')}</label>
          <select className="input" value={form.category_id||''} onChange={set('category_id')}>
            <option value="">— None —</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="input-group">
          <label className="input-label">Buying Price (Cost)</label>
          <input className="input" type="number" min="0" value={form.buying_price} onChange={set('buying_price')} />
        </div>
        <div className="input-group">
          <label className="input-label">Selling Price *</label>
          <input className="input" type="number" min="0" value={form.selling_price} onChange={set('selling_price')} required />
        </div>
        <div className="input-group">
          <label className="input-label">Min Stock Level</label>
          <input className="input" type="number" min="0" value={form.min_stock} onChange={set('min_stock')} />
        </div>
        <div className="input-group">
          <label className="input-label">Unit Type</label>
          <select className="input" value={form.unit_type} onChange={set('unit_type')}>
            {UNITS.map(u => <option key={u}>{u}</option>)}
          </select>
        </div>
        <div className="input-group">
          <label className="input-label">Shelf Location</label>
          <input className="input" placeholder="e.g. A-03" value={form.shelf_location||''} onChange={set('shelf_location')} />
        </div>
        <div className="input-group">
          <label className="input-label">Moto Compatibility</label>
          <input className="input" placeholder="e.g. Yamaha FZ, Bajaj" value={form.moto_compat||''} onChange={set('moto_compat')} />
        </div>
        <div className="input-group" style={{gridColumn:'1/-1'}}>
          <label className="input-label">Notes</label>
          <textarea className="input" rows={2} value={form.notes||''} onChange={set('notes')} />
        </div>
        <div className="flex gap-3 items-center" style={{gridColumn:'1/-1'}}>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!!form.allow_decimal} onChange={set('allow_decimal')} />
            <span style={{fontSize:13}}>Allow decimal quantities (e.g. 0.5L)</span>
          </label>
          {form.id && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!form.is_active} onChange={set('is_active')} />
              <span style={{fontSize:13}}>Active (visible in POS)</span>
            </label>
          )}
        </div>
      </div>
    </Modal>
  )
}

function ReceiveStockModal({
  product, currency, saving, onSave, onClose }) {
  const T = useT()
  const [form, setForm] = useState({ qty:'', cost_per_unit: product.buying_price || '', note:'' })
  const set = k => e => setForm(f => ({...f, [k]: e.target.value}))
  return (
    <Modal title={`Receive Stock — ${product.name}`} onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>{T('cancel')}</button>
          <button className="btn btn-success" onClick={() => onSave(form)} disabled={saving || !form.qty}>
            {saving ? <span className="spinner" /> : '+ Add Stock'}
          </button>
        </>
      }
    >
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        <div style={{background:'var(--bg3)',borderRadius:'var(--radius-sm)',padding:'10px 14px',fontSize:13}}>
          Current stock: <strong style={{color:'var(--amber)'}}>{product.current_stock} {product.unit_type}</strong>
        </div>
        <div className="input-group">
          <label className="input-label">Quantity Received *</label>
          <input className="input" type="number" min="0.001" step="0.001" value={form.qty} onChange={set('qty')} autoFocus />
        </div>
        <div className="input-group">
          <label className="input-label">Cost Per Unit (what you paid)</label>
          <input className="input" type="number" min="0" value={form.cost_per_unit} onChange={set('cost_per_unit')} />
        </div>
        <div className="input-group">
          <label className="input-label">Note (optional)</label>
          <input className="input" placeholder="e.g. Bought from Kariakoo" value={form.note} onChange={set('note')} />
        </div>
        {form.qty && form.cost_per_unit && (
          <div style={{background:'rgba(34,197,94,.08)',border:'1px solid rgba(34,197,94,.2)',borderRadius:'var(--radius-sm)',padding:'8px 14px',fontSize:13,color:'var(--green)'}}>
            Total cost: {formatMoney(form.qty * form.cost_per_unit, currency)}
          </div>
        )}
      </div>
    </Modal>
  )
}

function AdjustModal({ product, saving, onSave, onClose }) {
  const T = useT()
  const [form, setForm] = useState({ qty_change:'', reason:'Correction' })
  const REASONS = ['Damaged','Found','Correction','Other']
  return (
    <Modal title={`Adjust Stock — ${product.name}`} onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>{T('cancel')}</button>
          <button className="btn btn-primary" onClick={() => onSave(form)} disabled={saving || !form.qty_change}>
            {saving ? <span className="spinner" /> : 'Apply Adjustment'}
          </button>
        </>
      }
    >
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        <div style={{background:'var(--bg3)',borderRadius:'var(--radius-sm)',padding:'10px 14px',fontSize:13}}>
          Current stock: <strong style={{color:'var(--amber)'}}>{product.current_stock} {product.unit_type}</strong>
        </div>
        <div className="input-group">
          <label className="input-label">Quantity Change (use − for decrease)</label>
          <input className="input" type="number" placeholder="e.g. −3 or +5" value={form.qty_change}
            onChange={e => setForm(f=>({...f,qty_change:e.target.value}))} autoFocus />
        </div>
        <div className="input-group">
          <label className="input-label">Reason *</label>
          <select className="input" value={form.reason} onChange={e => setForm(f=>({...f,reason:e.target.value}))}>
            {REASONS.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>
        {form.qty_change && (
          <div style={{background:'var(--bg3)',borderRadius:'var(--radius-sm)',padding:'8px 14px',fontSize:13}}>
            New stock will be: <strong style={{color: (product.current_stock + Number(form.qty_change)) < 0 ? 'var(--red)' : 'var(--green)'}}>
              {product.current_stock + Number(form.qty_change)} {product.unit_type}
            </strong>
          </div>
        )}
      </div>
    </Modal>
  )
}

function MovementsModal({
  product, currency, onClose }) {
  const T = useT()
  const [movements, setMovements] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api.getMovements(product.id).then(d => { setMovements(d); setLoading(false) }).catch(() => setLoading(false))
  }, [product.id])
  const TYPE_COLOR = { receive:'var(--green)', sale:'var(--red)', adjustment:'var(--amber)', cancellation:'var(--teal)' }
  return (
    <Modal title={`{T('products_movements_title')} — ${product.name}`} onClose={onClose} size="lg">
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>{T('products_mov_date')}</th><th>{T('products_mov_type')}</th><th className="right">{T('products_mov_qty')}</th><th>{T('products_mov_note')}</th><th>{T('products_mov_by')}</th></tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={5} style={{textAlign:'center',padding:32}}><div className="spinner" style={{margin:'0 auto'}} /></td></tr>
            : movements.length === 0 ? <tr><td colSpan={5} style={{textAlign:'center',padding:32,color:'var(--text3)'}}>No movements</td></tr>
            : movements.map((m,i) => (
              <tr key={i}>
                <td style={{fontSize:12,color:'var(--text2)'}}>{new Date(m.created_at).toLocaleString('en-TZ',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
                <td><span className="badge" style={{background:TYPE_COLOR[m.type]+'22',color:TYPE_COLOR[m.type],border:`1px solid ${TYPE_COLOR[m.type]}44`}}>{m.type}</span></td>
                <td className="right font-bold" style={{color: m.qty_change > 0 ? 'var(--green)' : 'var(--red)'}}>
                  {m.qty_change > 0 ? '+' : ''}{m.qty_change}
                </td>
                <td style={{fontSize:12,color:'var(--text2)'}}>{m.reason || m.reference || '—'}</td>
                <td style={{fontSize:12,color:'var(--text3)'}}>{m.username || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
