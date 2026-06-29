// src/pages/ExpensesPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api, formatMoney, today, monthStart } from '../utils/api'
import Modal from '../components/Modal'

const CATEGORIES = ['Rent','Electricity','Salaries','Transport','Fuel','Maintenance','Cleaning','Security','Internet','Stationery','Other']

export default function ExpensesPage() {
  const { currency, toast, onSSE } = useApp()
  const T = useT()
  const [expenses, setExpenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ from: monthStart(), to: today(), category: '' })
  const [modal, setModal] = useState(null)
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getExpenses({ from: filters.from, to: filters.to, category: filters.category })
      setExpenses(data)
    } catch { toast(T('expenses_load_failed'), 'error') }
    finally { setLoading(false) }
  }, [filters])

  useEffect(() => { load() }, [load])
  useEffect(() => onSSE(evt => { if (evt.type === 'expense_created') load() }), [load, onSSE])

  async function save(form) {
    setSaving(true)
    try {
      const result = form.id ? await api.updateExpense(form.id, form) : await api.createExpense(form)
      if (result?.offline) {
        // FIX (offline support): refreshing via load() here would just
        // re-serve the last cached (pre-change) list and make it look like
        // nothing happened. Patch the visible list locally instead and be
        // explicit that this is queued, not yet confirmed by the server.
        toast('Imehifadhiwa nje ya mtandao — itasawazishwa ukirudi mtandaoni', 'warning')
        setExpenses(exp => form.id
          ? exp.map(e => e.id === form.id ? { ...e, ...form, _pendingSync: true } : e)
          : [{ ...form, id: result.local_ref, created_at: new Date().toISOString(), _pendingSync: true }, ...exp])
        setModal(null)
      } else {
        toast(form.id ? 'Expense updated' : 'Expense recorded', 'success')
        setModal(null)
        load()
      }
    } catch(err) { toast(err.message || 'Save failed', 'error') }
    finally { setSaving(false) }
  }

  async function deleteExpense(id) {
    try {
      const result = await api.deleteExpense(id)
      if (result?.offline) {
        toast('Kufuta kumesubiri kusawazishwa', 'warning')
        setExpenses(exp => exp.filter(e => e.id !== id))
      } else {
        toast(T('expenses_delete_ok'), 'success')
        load()
      }
      setDeleteConfirm(null)
    } catch(err) { toast(err.message || 'Cannot delete', 'error') }
  }

  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0)
  const byCategory = expenses.reduce((acc, e) => { acc[e.category] = (acc[e.category] || 0) + e.amount; return acc }, {})

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{T('expenses_title')}</div>
          <div className="page-sub">Total: <span style={{color:'var(--red)',fontWeight:700}}>{formatMoney(totalExpenses, currency)}</span></div>
        </div>
        <button className="btn btn-primary" onClick={() => setModal({ amount:'', category:'Rent', description:'', expense_date: today(), payment_method:'cash' })}>
          + Record Expense
        </button>
      </div>

      {/* Category summary chips */}
      {Object.keys(byCategory).length > 0 && (
        <div className="flex gap-2" style={{flexWrap:'wrap',marginBottom:16}}>
          {Object.entries(byCategory).sort((a,b)=>b[1]-a[1]).map(([cat,amt]) => (
            <div key={cat} style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:20,padding:'4px 12px',fontSize:12}}>
              <span style={{color:'var(--text3)'}}>{cat}: </span>
              <span style={{color:'var(--red)',fontWeight:700}}>{formatMoney(amt, currency)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="filters-row card" style={{padding:'12px 16px',marginBottom:16}}>
        <div className="input-group">
          <label className="input-label">From</label>
          <input className="input input-sm" type="date" value={filters.from} onChange={e=>setFilters(f=>({...f,from:e.target.value}))} />
        </div>
        <div className="input-group">
          <label className="input-label">To</label>
          <input className="input input-sm" type="date" value={filters.to} onChange={e=>setFilters(f=>({...f,to:e.target.value}))} />
        </div>
        <div className="input-group">
          <label className="input-label">Category</label>
          <select className="input input-sm" value={filters.category} onChange={e=>setFilters(f=>({...f,category:e.target.value}))}>
            <option value="">{T('expenses_all')}</option>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div style={{display:'flex',alignItems:'flex-end'}}>
          <button className="btn btn-primary btn-sm" onClick={load}>{T('expenses_search_btn')}</button>
        </div>
      </div>

      <div className="card" style={{padding:0,overflow:'hidden'}}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{T('expenses_col_date')}</th>
                <th>{T('expenses_col_cat')}</th>
                <th>{T('expenses_col_desc')}</th>
                <th>Payment</th>
                <th className="right">{T('expenses_col_amount')}</th>
                <th className="center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(6)].map((_,i) => <tr key={i}>{[...Array(6)].map((_,j) => <td key={j}><div className="skeleton" style={{height:14,width:'75%',borderRadius:4}} /></td>)}</tr>)
              ) : expenses.length === 0 ? (
                <tr><td colSpan={6} style={{textAlign:'center',padding:48,color:'var(--text3)'}}>No expenses in this period</td></tr>
              ) : expenses.map(e => (
                <tr key={e.id}>
                  <td style={{fontSize:12,color:'var(--text2)'}}>{e.expense_date}</td>
                  <td><span className="badge badge-amber">{e.category}</span></td>
                  <td style={{color:'var(--text2)'}}>{e.description || '—'}</td>
                  <td style={{fontSize:12}}>{e.payment_method}</td>
                  <td className="right font-bold" style={{color:'var(--red)'}}>{formatMoney(e.amount, currency)}</td>
                  <td className="center">
                    {/* FIX 5: match backend guard — only allow edit/delete if created TODAY (created_at) */}
                    {e.created_at?.startsWith(today()) ? (
                      <div className="flex gap-2 items-center" style={{justifyContent:'center'}}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setModal({...e})}>Edit</button>
                        <button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={() => setDeleteConfirm(e.id)}>Del</button>
                      </div>
                    ) : <span style={{color:'var(--text3)',fontSize:11}}>past</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <Modal title={modal.id ? T('expenses_form_title_edit') : 'Record Expense'} onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setModal(null)}>{T('cancel')}</button>
              <button className="btn btn-primary" onClick={() => save(modal)} disabled={saving}>
                {saving ? <span className="spinner" /> : 'Save'}
              </button>
            </>
          }
        >
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <div className="flex gap-3" style={{flexWrap:'wrap'}}>
              <div className="input-group" style={{flex:1,minWidth:130}}>
                <label className="input-label">Amount *</label>
                <input className="input" type="number" min="1" value={modal.amount} onChange={e=>setModal(m=>({...m,amount:e.target.value}))} autoFocus />
              </div>
              <div className="input-group" style={{flex:1,minWidth:130}}>
                <label className="input-label">Date *</label>
                <input className="input" type="date" value={modal.expense_date} onChange={e=>setModal(m=>({...m,expense_date:e.target.value}))} />
              </div>
            </div>
            <div className="input-group">
              <label className="input-label">Category *</label>
              <select className="input" value={modal.category} onChange={e=>setModal(m=>({...m,category:e.target.value}))}>
                {CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="input-group">
              <label className="input-label">Description</label>
              <input className="input" placeholder="Brief description" value={modal.description||''} onChange={e=>setModal(m=>({...m,description:e.target.value}))} />
            </div>
            <div className="input-group">
              <label className="input-label">Payment Method</label>
              <select className="input" value={modal.payment_method} onChange={e=>setModal(m=>({...m,payment_method:e.target.value}))}>
                <option value="cash">Cash</option>
                <option value="m-pesa">M-Pesa</option>
                <option value="bank-transfer">Bank Transfer</option>
              </select>
            </div>
          </div>
        </Modal>
      )}

      {deleteConfirm && (
        <Modal title="Delete Expense?" onClose={() => setDeleteConfirm(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>{T('cancel')}</button>
              <button className="btn btn-danger" onClick={() => deleteExpense(deleteConfirm)}>Delete</button>
            </>
          }
        >
          <p style={{color:'var(--text2)'}}>This will permanently remove the expense record.</p>
        </Modal>
      )}
    </div>
  )
}
