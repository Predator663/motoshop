// src/pages/StockPage.jsx — Real-time stock viewer
import { useState, useEffect, useCallback, useRef } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api, formatMoney } from '../utils/api'

export default function StockPage() {
  const { currency, onSSE, toast, auth } = useApp()
  const isOwner = auth?.role === 'owner'
  const T = useT()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('all') // all, low, out
  const [sortBy, setSortBy] = useState('stock_asc')
  const [lastUpdate, setLastUpdate] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const timerRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const result = await api.getStockRealtime()
      setData(result)
      setLastUpdate(new Date())
    } catch (e) {
      toast(T('stock_load_failed'), 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 15 seconds if enabled
  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(load, 15000)
    } else {
      clearInterval(timerRef.current)
    }
    return () => clearInterval(timerRef.current)
  }, [autoRefresh, load])

  // React to SSE stock updates
  useEffect(() => onSSE(evt => {
    if (['stock_updated','product_created','product_updated','sale_created','sale_cancelled'].includes(evt.type)) {
      load()
    }
  }), [load, onSSE])

  const products = data?.products || []

  const filtered = products
    .filter(p => {
      const matchSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.sku.toLowerCase().includes(search.toLowerCase()) ||
        (p.category_name || '').toLowerCase().includes(search.toLowerCase())
      const matchFilter =
        filterStatus === 'all' ? true :
        filterStatus === 'low' ? (p.low_stock && p.current_stock > 0) :
        filterStatus === 'out' ? p.current_stock <= 0 : true
      return matchSearch && matchFilter
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'stock_asc': return a.current_stock - b.current_stock
        case 'stock_desc': return b.current_stock - a.current_stock
        case 'name': return a.name.localeCompare(b.name)
        case 'value_desc': return b.stock_value - a.stock_value
        default: return 0
      }
    })

  const summary = data?.summary || {}

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="page-title">{T('stock_title')}</div>
          <div className="page-sub">
            {lastUpdate ? `${T('stock_subtitle')} ${lastUpdate.toLocaleTimeString()}` : 'Inapakia...'}
            {autoRefresh && <span style={{marginLeft:8,color:'var(--green)',fontSize:11}}>{T('stock_updating')}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            className={`btn btn-sm ${autoRefresh ? 'btn-success' : 'btn-secondary'}`}
            onClick={() => setAutoRefresh(v => !v)}
            title={autoRefresh ? 'Zima usasishaji wa moja kwa moja' : 'Wezesha usasishaji wa moja kwa moja'}
          >
            {autoRefresh ? `⏸ ${T('stock_auto')}` : `▶ ${T('stock_auto')}`}
          </button>
          <button className="btn btn-primary btn-sm" onClick={load}>
            🔄 Sasisha
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-4" style={{marginBottom:20}}>
        <div className="stat-card" style={{'--accent-line':'var(--teal)'}}>
          <div className="stat-label">Jumla ya Bidhaa</div>
          <div className="stat-value teal">{summary.total_products || 0}</div>
          <div className="stat-sub">Bidhaa hai</div>
        </div>
        {isOwner && (
          <div className="stat-card" style={{'--accent-line':'var(--amber)'}}>
            <div className="stat-label">Thamani ya Akiba</div>
            <div className="stat-value amber" style={{fontSize:18}}>{formatMoney(summary.total_value || 0, currency)}</div>
            <div className="stat-sub">Kwa bei ya mauzo</div>
          </div>
        )}
        <div className="stat-card" style={{'--accent-line':'var(--amber)'}}>
          <div className="stat-label">Akiba Kidogo</div>
          <div className="stat-value" style={{color:'var(--amber)'}}>{summary.low_stock_count || 0}</div>
          <div className="stat-sub">Zinahitaji kujazwa</div>
        </div>
        <div className="stat-card" style={{'--accent-line':'var(--red)'}}>
          <div className="stat-label">Zilizokwisha</div>
          <div className="stat-value red">{summary.out_of_stock_count || 0}</div>
          <div className="stat-sub">Hazipo kabisa</div>
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{padding:'14px 16px',marginBottom:16}}>
        <div className="flex gap-2" style={{flexWrap:'wrap',alignItems:'flex-end'}}>
          <div className="input-group" style={{flex:1,minWidth:200}}>
            <label className="input-label">Tafuta Bidhaa</label>
            <input
              className="input input-sm"
              placeholder={T('stock_search')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="input-group" style={{minWidth:150}}>
            <label className="input-label">Chuja kwa Hali</label>
            <select className="input input-sm" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="all">{T('stock_all')}</option>
              <option value="low">{T('stock_filter_low')}</option>
              <option value="out">{T('stock_filter_out')}</option>
            </select>
          </div>
          <div className="input-group" style={{minWidth:160}}>
            <label className="input-label">Panga kwa</label>
            <select className="input input-sm" value={sortBy} onChange={e => setSortBy(e.target.value)}>
              <option value="stock_asc">{T('stock_sort_stock_asc')}</option>
              <option value="stock_desc">{T('stock_sort_stock_desc')}</option>
              <option value="name">{T('stock_sort_name')}</option>
              {isOwner && <option value="value_desc">{T('stock_sort_value')}</option>}
            </select>
          </div>
        </div>
      </div>

      {/* Stock Table */}
      <div className="card" style={{padding:0,overflow:'hidden'}}>
        <div className="table-wrap">
          {loading ? (
            <div style={{padding:40,textAlign:'center'}}>
              <div className="spinner" style={{margin:'0 auto 12px'}} />
              <div style={{color:'var(--text3)'}}>Inapakia akiba...</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{T('stock_col_name')}</th>
                  <th>{T('stock_col_sku')}</th>
                  <th>{T('stock_col_cat')}</th>
                  <th className="right">{T('stock_col_qty')}</th>
                  <th className="right">{T('stock_col_min')}</th>
                  {isOwner && <th className="right">{T('stock_col_buy')}</th>}
                  <th className="right">{T('stock_col_sell')}</th>
                  {isOwner && <th className="right">{T('stock_col_value')}</th>}
                  <th className="center">{T('stock_col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{textAlign:'center',padding:40,color:'var(--text3)'}}>
                      <div className="empty-state">
                        <div className="empty-icon">📦</div>
                        <div className="empty-title">Hakuna bidhaa zilizopatikana</div>
                      </div>
                    </td>
                  </tr>
                ) : filtered.map(p => (
                  <StockRow key={p.id} product={p} currency={currency} isOwner={isOwner} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {!loading && filtered.length > 0 && (
        <div style={{marginTop:12,fontSize:12,color:'var(--text3)',textAlign:'right'}}>
          {T('stock_showing')} {filtered.length} {T('stock_of')} {products.length}
        </div>
      )}
    </div>
  )
}

function StockRow({ product: p, currency, isOwner }) {
  const isOut = p.current_stock <= 0
  const isLow = p.low_stock && p.current_stock > 0

  return (
    <tr className={`stock-row ${isOut ? 'row-out' : isLow ? 'row-low' : ''}`}>
      <td style={{fontWeight:600}}>{p.name}</td>
      <td style={{fontFamily:'monospace',fontSize:11,color:'var(--text3)'}}>{p.sku}</td>
      <td style={{fontSize:12}}>{p.category_name || '—'}</td>
      <td className="right">
        <span className={`stock-qty ${isOut ? 'text-red' : isLow ? 'text-amber' : 'text-green'}`} style={{fontFamily:'var(--font-head)',fontWeight:700,fontSize:15}}>
          {Number(p.current_stock).toFixed(1)}
        </span>
        <span style={{fontSize:11,color:'var(--text3)',marginLeft:4}}>{p.unit_type}</span>
      </td>
      <td className="right" style={{fontSize:13,color:'var(--text3)'}}>{p.min_stock}</td>
      {isOwner && <td className="right" style={{fontSize:13}}>{formatMoney(p.buying_price, currency)}</td>}
      <td className="right" style={{fontSize:13,color:'var(--amber)'}}>{formatMoney(p.selling_price, currency)}</td>
      {isOwner && <td className="right" style={{fontSize:13,fontWeight:600}}>{formatMoney(p.stock_value, currency)}</td>}
      <td className="center">
        {isOut ? (
          <span className="badge badge-red">Imekwisha</span>
        ) : isLow ? (
          <span className="badge badge-amber">⚠ Kidogo</span>
        ) : (
          <span className="badge badge-green">✓ Sawa</span>
        )}
      </td>
    </tr>
  )
}
