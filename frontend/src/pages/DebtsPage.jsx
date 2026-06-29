import { useState, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api, formatMoney, formatDate } from '../utils/api'
import Modal from '../components/Modal'

export default function DebtsPage() {
  const { currency, toast, onSSE } = useApp()
  const T = useT()
  const [debts, setDebts] = useState([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [payModal, setPayModal] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (statusFilter) params.status = statusFilter
      if (customerSearch) params.customer = customerSearch
      setDebts(await api.getDebts(params))
    } catch { toast(T('debts_load_failed'), 'error') }
    finally { setLoading(false) }
  }, [statusFilter, customerSearch])

  useEffect(() => { load() }, [load])
  useEffect(() => onSSE(evt => { if (evt.type==='debt_paid'||evt.type==='sale_cancelled') load() }), [load, onSSE])

  async function payDebt(id, form) {
    setSaving(true)
    try {
      const result = await api.payDebt(id, form)
      if (result?.offline) {
        // FIX (offline support): we don't have a server-computed remaining
        // balance yet, but we do still have the debt record we opened the
        // modal with — compute the same numbers locally so the table
        // reflects the payment right away instead of looking unchanged.
        const amount = parseFloat(form.amount) || 0
        const debt = debts.find(d => d.id === id)
        const newRemaining = debt ? Math.max(0, debt.remaining - amount) : null
        const newStatus = newRemaining === 0 ? 'paid' : 'partial'
        toast(`Malipo yamehifadhiwa nje ya mtandao — yatasawazishwa ukirudi mtandaoni`, 'warning')
        setDebts(ds => ds.map(d => d.id === id
          ? { ...d, remaining: newRemaining ?? d.remaining, paid_amount: d.paid_amount + amount, status: newStatus, _pendingSync: true }
          : d))
      } else {
        toast(`${T('debts_pay_ok')} — ${result.status==='paid'?'✅':formatMoney(result.new_remaining,currency)}`, 'success')
        load()
      }
      setPayModal(null)
    } catch(err) { toast(err.message||T('debts_pay_failed'), 'error') }
    finally { setSaving(false) }
  }

  const totalOutstanding = debts.filter(d=>['unpaid','partial'].includes(d.status)).reduce((s,d)=>s+d.remaining,0)
  const agingColor = (days) => days<=30?'var(--green)':days<=60?'var(--amber)':days<=90?'var(--accent)':'var(--red)'

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{T('debts_title')}</div>
          <div className="page-sub">{T('debts_total')}: <span style={{color:'var(--red)',fontWeight:700}}>{formatMoney(totalOutstanding, currency)}</span></div>
        </div>
      </div>

      <div className="filters-row card" style={{padding:'12px 16px',marginBottom:16}}>
        <div className="input-group">
          <label className="input-label">{T('debts_filter_status')}</label>
          <select className="input input-sm" value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>
            <option value="">{T('debts_all')}</option>
            <option value="unpaid">{T('debts_unpaid')}</option>
            <option value="partial">{T('debts_partial')}</option>
            <option value="paid">{T('debts_paid')}</option>
          </select>
        </div>
        <div className="input-group" style={{flex:2}}>
          <label className="input-label">{T('debts_search')}</label>
          <input className="input input-sm" placeholder={T('debts_search')+'…'} value={customerSearch} onChange={e=>setCustomerSearch(e.target.value)} />
        </div>
        <div style={{display:'flex',alignItems:'flex-end'}}>
          <button className="btn btn-primary btn-sm" onClick={load}>{T('debts_search_btn')}</button>
        </div>
      </div>

      <div className="card" style={{padding:0,overflow:'hidden'}}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{T('debts_col_customer')}</th><th>{T('phone')}</th>
                <th>{T('debts_col_receipt')}</th><th>{T('date')}</th>
                <th className="right">{T('debts_col_original')}</th>
                <th className="right">{T('debts_col_paid')}</th>
                <th className="right">{T('debts_col_remaining')}</th>
                <th className="center">{T('debts_col_age')}</th>
                <th className="center">{T('debts_col_status')}</th>
                <th className="center">{T('debts_col_action')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(6)].map((_,i)=><tr key={i}>{[...Array(10)].map((_,j)=><td key={j}><div className="skeleton" style={{height:14,width:'75%',borderRadius:4}} /></td>)}</tr>)
              ) : debts.length===0 ? (
                <tr><td colSpan={10} style={{textAlign:'center',padding:48,color:'var(--text3)'}}>{T('debts_empty')}</td></tr>
              ) : debts.map(d=>(
                <tr key={d.id}>
                  <td style={{fontWeight:600}}>{d.customer_name}</td>
                  <td style={{fontSize:12,color:'var(--text2)'}}>{d.customer_phone||'—'}</td>
                  <td style={{fontFamily:'monospace',fontSize:12,color:'var(--teal)'}}>{d.receipt_no}</td>
                  <td style={{fontSize:12,color:'var(--text2)'}}>{formatDate(d.created_at)}</td>
                  <td className="right">{formatMoney(d.original_amount,currency)}</td>
                  <td className="right" style={{color:'var(--green)'}}>{formatMoney(d.paid_amount,currency)}</td>
                  <td className="right font-bold" style={{color:'var(--red)'}}>{formatMoney(d.remaining,currency)}</td>
                  <td className="center"><span style={{color:agingColor(d.days_overdue),fontWeight:700,fontSize:12}}>{d.days_overdue}{T('debts_days')}</span></td>
                  <td className="center"><span className={`badge ${d.status==='paid'?'badge-green':d.status==='partial'?'badge-amber':'badge-red'}`}>{d.status==='paid'?T('debts_paid'):d.status==='partial'?T('debts_partial'):T('debts_unpaid')}</span></td>
                  <td className="center">{['unpaid','partial'].includes(d.status)&&<button className="btn btn-success btn-sm" onClick={()=>setPayModal(d)}>{T('debts_pay_btn')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {payModal && <PayDebtModal debt={payModal} currency={currency} saving={saving} T={T} onPay={(form)=>payDebt(payModal.id,form)} onClose={()=>setPayModal(null)} />}
    </div>
  )
}

function PayDebtModal({ debt, currency, saving, T, onPay, onClose }) {
  const [form, setForm] = useState({ amount: debt.remaining, payment_method:'cash', reference:'', note:'' })
  const set = k => e => setForm(f=>({...f,[k]:e.target.value}))
  return (
    <Modal title={`${T('debts_pay_title')} — ${debt.customer_name}`} onClose={onClose}
      footer={<><button className="btn btn-secondary" onClick={onClose}>{T('cancel')}</button><button className="btn btn-success" onClick={()=>onPay(form)} disabled={saving}>{saving?<span className="spinner"/>:`✅ ${T('debts_pay_btn2')}`}</button></>}
    >
      <div style={{display:'flex',flexDirection:'column',gap:12}}>
        <div style={{background:'var(--bg3)',borderRadius:'var(--radius-sm)',padding:'12px 16px',display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,fontSize:13}}>
          <div><span style={{color:'var(--text3)'}}>{T('debts_col_original')}: </span><strong>{formatMoney(debt.original_amount,currency)}</strong></div>
          <div><span style={{color:'var(--text3)'}}>{T('debts_col_remaining')}: </span><strong style={{color:'var(--red)'}}>{formatMoney(debt.remaining,currency)}</strong></div>
        </div>
        <div className="input-group">
          <label className="input-label">{T('debts_pay_amount')} *</label>
          <input className="input" type="number" min="1" max={debt.remaining} value={form.amount} onChange={set('amount')} autoFocus />
        </div>
        <div className="input-group">
          <label className="input-label">{T('debts_pay_method')}</label>
          <select className="input" value={form.payment_method} onChange={set('payment_method')}>
            {['cash','m-pesa','tigo-pesa','airtel-money','bank-transfer'].map(m=><option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        {form.payment_method!=='cash'&&<div className="input-group"><label className="input-label">{T('debts_pay_ref')}</label><input className="input" value={form.reference} onChange={set('reference')} /></div>}
        <div className="input-group"><label className="input-label">{T('debts_pay_note')}</label><input className="input" value={form.note} onChange={set('note')} /></div>
      </div>
    </Modal>
  )
}
