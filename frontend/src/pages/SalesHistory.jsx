// src/pages/SalesHistory.jsx
import { useState, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api, formatMoney, formatDateTime, today } from '../utils/api'
import Modal from '../components/Modal'

export default function SalesHistory() {
  const { auth, currency, toast, onSSE } = useApp()
  const T = useT()
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [filters, setFilters] = useState({ from: today(), to: today(), method: '', customer: '' })
  const [cancelConfirm, setCancelConfirm] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (filters.from) params.from = filters.from
      if (filters.to) params.to = filters.to
      if (filters.method) params.method = filters.method
      if (filters.customer) params.customer = filters.customer
      const data = await api.getSales(params)
      setSales(data)
    } catch { toast(T('sales_load_failed'), 'error') }
    finally { setLoading(false) }
  }, [filters])

  useEffect(() => { load() }, [load])
  useEffect(() => onSSE(evt => {
    if (['sale_created','sale_cancelled'].includes(evt.type)) load()
  }), [load, onSSE])

  async function openDetail(id) {
    setDetailLoading(true)
    setDetail({ id, loading: true })
    try {
      const d = await api.getSale(id)
      setDetail(d)
    } catch { toast(T('sales_detail_load_failed'), 'error'); setDetail(null) }
    finally { setDetailLoading(false) }
  }

  async function cancelSale(id) {
    try {
      const result = await api.cancelSale(id)
      if (result?.offline) {
        toast('Kughairi kumehifadhiwa nje ya mtandao — itasawazishwa ukirudi mtandaoni', 'warning')
        setSales(s => s.map(x => x.id === id ? { ...x, status: 'cancelled', _pendingSync: true } : x))
      } else {
        toast(T('sales_cancelled_ok'), 'success')
        load()
      }
      setCancelConfirm(null)
      setDetail(null)
    } catch(err) { toast(err.message || T('sales_cancel_failed'), 'error') }
  }

  const total = sales.filter(s => s.status === 'completed').reduce((s, x) => s + x.total, 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">
            {auth?.role === 'cashier' ? T('sales_my_title') : T('sales_title')}
          </div>
          <div className="page-sub">{sales.length} {T('sales_records')} — {formatMoney(total, currency)} jumla</div>
        </div>
      </div>

      {/* Filters */}
      <div className="filters-row card" style={{padding:'14px 16px',marginBottom:16}}>
        <div className="input-group">
          <label className="input-label">{T('sales_from')}</label>
          <input className="input input-sm" type="date" value={filters.from} onChange={e => setFilters(f=>({...f,from:e.target.value}))} />
        </div>
        <div className="input-group">
          <label className="input-label">{T('sales_to')}</label>
          <input className="input input-sm" type="date" value={filters.to} onChange={e => setFilters(f=>({...f,to:e.target.value}))} />
        </div>
        {auth?.role === 'owner' && (
          <>
            <div className="input-group">
              <label className="input-label">Njia ya Malipo</label>
              <select className="input input-sm" value={filters.method} onChange={e => setFilters(f=>({...f,method:e.target.value}))}>
                <option value="">{T('sales_all')}</option>
                <option value="cash">Pesa Taslimu</option>
                <option value="m-pesa">M-Pesa</option>
                <option value="tigo-pesa">Tigo Pesa</option>
                <option value="airtel-money">Airtel Money</option>
                <option value="bank-transfer">Benki</option>
                <option value="credit">Mkopo</option>
              </select>
            </div>
            <div className="input-group">
              <label className="input-label">Mteja</label>
              <input className="input input-sm" placeholder={T('sales_customer_search')+'…'} value={filters.customer} onChange={e => setFilters(f=>({...f,customer:e.target.value}))} />
            </div>
          </>
        )}
        <div style={{display:'flex',alignItems:'flex-end'}}>
          <button className="btn btn-primary btn-sm" onClick={load}>{T('sales_search_btn')}</button>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{padding:0,overflow:'hidden'}}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{T('sales_col_receipt')}</th>
                <th>{T('sales_col_datetime')}</th>
                <th>{T('sales_col_products')}</th>
                <th>{T('sales_col_customer')}</th>
                {auth?.role === 'owner' && <th>{T('sales_col_owner_cashier')}</th>}
                <th>{T('sales_col_payment')}</th>
                <th className="right">{T('sales_col_total')}</th>
                <th className="center">{T('sales_col_status')}</th>
                <th className="center">{T('sales_col_action')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(8)].map((_,i) => (
                  <tr key={i}>
                    {[...Array(auth?.role === 'owner' ? 9 : 8)].map((_,j) => (
                      <td key={j}><div className="skeleton" style={{height:14,borderRadius:4,width:'80%'}} /></td>
                    ))}
                  </tr>
                ))
              ) : sales.length === 0 ? (
                <tr><td colSpan={auth?.role === 'owner' ? 9 : 8} style={{textAlign:'center',padding:40,color:'var(--text3)'}}>Hakuna mauzo yaliyopatikana</td></tr>
              ) : sales.map(s => (
                <SaleRow
                  key={s.id}
                  sale={s}
                  currency={currency}
                  role={auth?.role}
                  onView={() => openDetail(s.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail modal */}
      {detail && (
        <Modal
          title={`Uuzaji — ${detail.receipt_no || '…'}`}
          onClose={() => setDetail(null)}
          size="lg"
          footer={
            auth?.role === 'owner' && detail.status === 'completed' ? (
              <button className="btn btn-danger btn-sm" onClick={() => setCancelConfirm(detail.id)}>Ghairi Uuzaji</button>
            ) : null
          }
        >
          {detail.loading ? (
            <div style={{display:'flex',justifyContent:'center',padding:40}}><div className="spinner" /></div>
          ) : (
            <SaleDetail sale={detail} currency={currency} />
          )}
        </Modal>
      )}

      {/* Cancel confirm */}
      {cancelConfirm && (
        <Modal title={T('sales_cancel_confirm_title')} onClose={() => setCancelConfirm(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setCancelConfirm(null)}>{T('sales_cancel_no')}</button>
              <button className="btn btn-danger" onClick={() => cancelSale(cancelConfirm)}>{T('sales_cancel_yes')}</button>
            </>
          }
        >
          <p style={{color:'var(--text2)'}}>{T('sales_cancel_confirm_msg')}</p>
        </Modal>
      )}
    </div>
  )
}

function SaleRow({
  sale: s, currency, role, onView }) {
  const T = useT()
  // product_names comes from the list query (GROUP_CONCAT of up to 3 items)
  const productSummary = s.product_names || '—'

  return (
    <tr style={{cursor:'pointer'}} onClick={onView}>
      <td style={{fontFamily:'monospace',fontSize:12,color:'var(--teal)'}}>{s.receipt_no}</td>
      <td style={{fontSize:12,color:'var(--text2)'}}>{formatDateTime(s.created_at)}</td>
      <td style={{fontSize:12,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:'var(--text2)'}}>
        {productSummary}
      </td>
      <td>{s.customer_name || <span style={{color:'var(--text3)'}}>Mgeni</span>}</td>
      {role === 'owner' && (
        <td style={{fontSize:12}}>
          <div style={{display:'flex',flexDirection:'column',gap:2}}>
            <span style={{color:'var(--amber)',fontSize:11}}>👑 {s.owner_name || T('sales_owner')}</span>
            <span style={{color:'var(--teal)',fontSize:11}}>🧾 {s.sold_by_name}</span>
          </div>
        </td>
      )}
      <td><PayBadge method={s.payment_method} /></td>
      <td className="right font-bold" style={{color:'var(--amber)'}}>{formatMoney(s.total, currency)}</td>
      <td className="center">
        <span className={`badge ${s.status === 'completed' ? 'badge-green' : 'badge-red'}`}>
          {s.status === 'completed' ? T('sales_completed') : T('sales_cancelled')}
        </span>
      </td>
      <td className="center">
        <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); onView() }}>{T('sales_view')}</button>
      </td>
    </tr>
  )
}

function SaleDetail({
  sale, currency }) {
  const T = useT()
  return (
    <div style={{display:'flex',flexDirection:'column',gap:12}}>
      <div className="grid grid-2" style={{gap:10}}>
        <Info label="Nambari ya Risiti" value={sale.receipt_no} mono />
        <Info label="Tarehe" value={formatDateTime(sale.created_at)} />
        <Info label="Mmiliki" value={sale.owner_name || 'owner'} />
        <Info label="Mkashia (Aliuza)" value={sale.sold_by_name} />
        <Info label="Mteja" value={sale.customer_name || T('sales_walk_in')} />
        <Info label="Njia ya Malipo" value={sale.payment_method} />
        {sale.payment_ref && <Info label="Nambari ya Malipo" value={sale.payment_ref} mono />}
        <Info label="Hali" value={sale.status === 'completed' ? 'Imekamilika' : 'Imeghairiwa'} colored />
      </div>
      <div className="table-wrap" style={{marginTop:8}}>
        <table>
          <thead>
            <tr>
              <th>Bidhaa</th>
              <th className="right">Idadi</th>
              <th className="right">Bei ya Kitengo</th>
              <th className="right">Punguzo</th>
              <th className="right">Jumla</th>
            </tr>
          </thead>
          <tbody>
            {(sale.items || []).map((item, i) => (
              <tr key={i}>
                <td style={{fontWeight:600}}>{item.product_name}</td>
                <td className="right">{Number(item.qty).toFixed(1)}</td>
                <td className="right">{formatMoney(item.unit_price, currency)}</td>
                <td className="right">{item.discount_pct > 0 ? `${item.discount_pct}%` : '—'}</td>
                <td className="right font-bold">{formatMoney(item.line_total, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{background:'var(--bg3)',borderRadius:'var(--radius-sm)',padding:'12px 16px'}}>
        <div className="total-line"><span>Jumla Ndogo</span><span>{formatMoney(sale.subtotal, currency)}</span></div>
        {sale.discount_amt > 0 && <div className="total-line" style={{color:'var(--green)'}}><span>Punguzo</span><span>−{formatMoney(sale.discount_amt, currency)}</span></div>}
        {sale.vat_amt > 0 && <div className="total-line"><span>VAT ({sale.vat_pct}%)</span><span>{formatMoney(sale.vat_amt, currency)}</span></div>}
        <div className="total-line bold" style={{marginTop:6,paddingTop:6,borderTop:'1px solid var(--border)'}}><span>JUMLA</span><span style={{color:'var(--amber)',fontSize:18}}>{formatMoney(sale.total, currency)}</span></div>
        {!sale.is_credit && <div className="total-line"><span>Kilicholipwa</span><span>{formatMoney(sale.amount_paid, currency)}</span></div>}
        {sale.change_given > 0 && <div className="total-line"><span>Chenji</span><span style={{color:'var(--green)'}}>{formatMoney(sale.change_given, currency)}</span></div>}
        {sale.is_credit && <div className="total-line" style={{color:'var(--red)'}}><span>⚠️ Uuzaji wa Mkopo</span><span>Deni limerekodiwa</span></div>}
      </div>
    </div>
  )
}

function Info({
  label, value, mono, colored }) {
  const T = useT()
  return (
    <div>
      <div className="input-label">{label}</div>
      <div style={{fontFamily:mono?'monospace':undefined,color:colored && (value==='Imekamilika'||value==='completed')?'var(--green)':colored?'var(--red)':undefined,fontSize:14,marginTop:2,padding:'6px 0'}}>{value || '—'}</div>
    </div>
  )
}

function PayBadge({
  method }) {
  const T = useT()
  const map = { cash:'badge-green', 'm-pesa':'badge-teal', 'tigo-pesa':'badge-blue', 'airtel-money':'badge-amber', 'bank-transfer':'badge-blue', credit:'badge-red' }
  const labels = { cash:'Taslimu', 'm-pesa':'M-Pesa', 'tigo-pesa':'Tigo', 'airtel-money':'Airtel', 'bank-transfer':'Benki', credit:'Mkopo' }
  return <span className={`badge ${map[method] || 'badge-gray'}`}>{labels[method] || method}</span>
}
