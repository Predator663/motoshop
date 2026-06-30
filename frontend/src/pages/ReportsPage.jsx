// src/pages/ReportsPage.jsx
import { useState, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api, formatMoney, today, monthStart } from '../utils/api'

const TAB_KEYS = [
  { key:'pl',    icon:'📊' },
  { key:'stock', icon:'📦' },
  { key:'sales', icon:'🧾' },
  { key:'aging', icon:'💳' },
]

export default function ReportsPage() {
  const { currency, toast } = useApp()
  const T = useT()
  const TABS = [
    { key:'pl',    label:T('reports_pl'),    icon:'📊' },
    { key:'stock', label:T('reports_stock'), icon:'📦' },
    { key:'sales', label:T('reports_sales'), icon:'🧾' },
    { key:'aging', label:T('reports_aging'), icon:'💳' },
  ]
  const [tab, setTab] = useState('pl')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setData(null)
    try {
      let result
      if (tab === 'pl') result = await api.getReportPL(from, to)
      else if (tab === 'stock') result = await api.getReportStock()
      else if (tab === 'sales') result = await api.getReportSales(from, to)
      else if (tab === 'aging') result = await api.getReportDebtAging()
      setData(result)
    } catch(e) { console.error(e); toast(T('reports_load_failed'), 'error') }
    finally { setLoading(false) }
  }, [tab, from, to])

  return (
    <div>
      <div className="page-header">
        <div><div className="page-title">Financial Reports</div><div className="page-sub">Professional reports for your shop</div></div>
        <button className="btn btn-secondary btn-sm" onClick={() => window.print()}>🖨️ Print / Export PDF</button>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-2" style={{flexWrap:'wrap',marginBottom:16}}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`btn ${tab===t.key?'btn-primary':'btn-secondary'}`}
            onClick={() => { setTab(t.key); setData(null) }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Date range + generate */}
      {(tab === 'pl' || tab === 'sales') && (
        <div className="card" style={{padding:'14px 16px',marginBottom:16}}>
          <div className="flex gap-3 items-end" style={{flexWrap:'wrap'}}>
            <div className="input-group">
              <label className="input-label">From</label>
              <input className="input input-sm" type="date" value={from} onChange={e=>setFrom(e.target.value)} />
            </div>
            <div className="input-group">
              <label className="input-label">To</label>
              <input className="input input-sm" type="date" value={to} onChange={e=>setTo(e.target.value)} />
            </div>
            <button className="btn btn-primary" onClick={load} disabled={loading}>
              {loading ? <span className="spinner" /> : '⚡ Generate'}
            </button>
          </div>
        </div>
      )}

      {(tab === 'stock' || tab === 'aging') && !data && (
        <div style={{marginBottom:16}}>
          <button className="btn btn-primary" onClick={load} disabled={loading}>
            {loading ? <span className="spinner" /> : '⚡ Generate Report'}
          </button>
        </div>
      )}

      {loading && (
        <div style={{display:'flex',justifyContent:'center',padding:64}}>
          <div className="spinner" style={{width:40,height:40,borderWidth:4}} />
        </div>
      )}

      {/* Reports */}
      {data && !loading && (
        <div className="report-output">
          {tab === 'pl'    && <PLReport data={data} currency={currency} />}
          {tab === 'stock' && <StockReport data={data} currency={currency} />}
          {tab === 'sales' && <SalesReport data={data} currency={currency} />}
          {tab === 'aging' && <AgingReport data={data} currency={currency} />}
        </div>
      )}
    </div>
  )
}

// ── P&L ──────────────────────────────────────────────────────────────────
function PLReport({ data, currency }) {
  const T = useT()
  const isProfit = data.net_profit >= 0
  return (
    <div>
      <div className="report-header">
        <div className="font-head" style={{fontSize:20,fontWeight:800,marginBottom:4}}>Profit & Loss Statement</div>
        <div style={{color:'var(--text2)',fontSize:13}}>{data.period.from} → {data.period.to}</div>
      </div>

      <div className="report-kpi-grid">
        <KPI label={`Total ${T('reports_revenue')}`} value={formatMoney(data.revenue, currency)} color="var(--amber)" />
        <KPI label="Cost of Goods" value={formatMoney(data.cogs, currency)} color="var(--red)" />
        <KPI label={T('reports_gross')} value={formatMoney(data.gross_profit, currency)} color="var(--green)" />
        <KPI label={T('reports_expenses')} value={formatMoney(data.total_expenses, currency)} color="var(--red)" />
        <KPI label={T('reports_net')} value={formatMoney(data.net_profit, currency)} color={isProfit?'var(--green)':'var(--red)'} large />
      </div>

      <div className="report-section">
        <div className="report-section-header">{T('reports_revenue')}</div>
        <div className="pl-row"><span>Sales {T('reports_revenue')}</span><span style={{color:'var(--amber)',fontWeight:700}}>{formatMoney(data.revenue, currency)}</span></div>
        <div className="pl-row" style={{color:'var(--red)'}}><span>Less: Cost of Goods Sold</span><span>({formatMoney(data.cogs, currency)})</span></div>
        <div className="pl-row total profit" style={{background:'rgba(34,197,94,.1)',color:'var(--green)'}}>
          <span>GROSS PROFIT</span><span>{formatMoney(data.gross_profit, currency)}</span>
        </div>
      </div>

      <div className="report-section">
        <div className="report-section-header">Expenses</div>
        {data.expenses_by_category.map((e,i) => (
          <div key={i} className="pl-row" style={{background: i%2===0?'var(--bg2)':'var(--bg3)'}}>
            <span>{e.category}</span>
            <span style={{color:'var(--red)'}}>({formatMoney(e.total, currency)})</span>
          </div>
        ))}
        <div className="pl-row total" style={{color:'var(--red)'}}><span>{T('reports_expenses')}</span><span>({formatMoney(data.total_expenses, currency)})</span></div>
      </div>

      <div className="report-section">
        <div className={`pl-row grand`} style={{
          background: isProfit ? 'var(--green2)' : 'var(--red2)',
          color:'var(--on-accent)', padding:'18px 16px', fontSize:20, fontWeight:800
        }}>
          <span>{isProfit ? '✅ NET PROFIT' : '❌ NET LOSS'}</span>
          <span>{formatMoney(Math.abs(data.net_profit), currency)}</span>
        </div>
      </div>
    </div>
  )
}

// ── Stock valuation ───────────────────────────────────────────────────────
function StockReport({ data, currency }) {
  return (
    <div>
      <div className="report-header">
        <div className="font-head" style={{fontSize:20,fontWeight:800,marginBottom:4}}>Stock Valuation Report</div>
        <div style={{color:'var(--text2)',fontSize:13}}>Current inventory at cost and selling price</div>
      </div>

      <div className="report-kpi-grid">
        <KPI label="Total Products" value={data.items.length} color="var(--teal)" />
        <KPI label="Stock at Cost" value={formatMoney(data.total_cost, currency)} color="var(--amber)" />
        <KPI label="Stock at Sell Price" value={formatMoney(data.total_sell, currency)} color="var(--green)" />
        <KPI label="Potential Profit" value={formatMoney(data.total_sell - data.total_cost, currency)} color="var(--green)" large />
      </div>

      <div className="report-section">
        <div className="report-section-header">Product Inventory</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th>Category</th>
                <th className="right">Stock</th>
                <th className="right">Buy Price</th>
                <th className="right">Sell Price</th>
                <th className="right">Cost Value</th>
                <th className="right">Sell Value</th>
                <th className="right">Potential Profit</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item, i) => (
                <tr key={i} style={{background: i%2===0?'var(--bg2)':'var(--bg3)'}}>
                  <td style={{fontWeight:600}}>{item.name}</td>
                  <td style={{fontFamily:'monospace',fontSize:12,color:'var(--teal)'}}>{item.sku}</td>
                  <td style={{fontSize:12,color:'var(--text2)'}}>{item.category || '—'}</td>
                  <td className="right" style={{color: item.current_stock <= 0 ? 'var(--red)' : 'var(--text)'}}>{item.current_stock}</td>
                  <td className="right">{formatMoney(item.buying_price, currency)}</td>
                  <td className="right" style={{color:'var(--amber)'}}>{formatMoney(item.selling_price, currency)}</td>
                  <td className="right">{formatMoney(item.cost_value, currency)}</td>
                  <td className="right">{formatMoney(item.sell_value, currency)}</td>
                  <td className="right font-bold" style={{color: item.potential_profit >= 0 ? 'var(--green)' : 'var(--red)'}}>
                    {formatMoney(item.potential_profit, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{background:'var(--bg-primary)',borderTop:'2px solid var(--border2)'}}>
                <td colSpan={6} style={{fontWeight:700,fontSize:14,padding:'12px 16px',background:'var(--bg3)'}}>TOTALS</td>
                <td className="right font-bold" style={{color:'var(--amber)',background:'var(--bg3)'}}>{formatMoney(data.total_cost, currency)}</td>
                <td className="right font-bold" style={{color:'var(--green)',background:'var(--bg3)'}}>{formatMoney(data.total_sell, currency)}</td>
                <td className="right font-bold" style={{color:'var(--green)',background:'var(--bg3)',fontSize:15}}>{formatMoney(data.total_sell - data.total_cost, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Sales statement ───────────────────────────────────────────────────────
function SalesReport({ data, currency }) {
  const T = useT()
  return (
    <div>
      <div className="report-header">
        <div className="font-head" style={{fontSize:20,fontWeight:800,marginBottom:4}}>Sales Statement</div>
        <div style={{color:'var(--text2)',fontSize:13}}>{data.period.from} → {data.period.to}</div>
      </div>

      <div className="report-kpi-grid">
        <KPI label={`Total ${T('reports_revenue')}`} value={formatMoney(data.total, currency)} color="var(--amber)" large />
        <KPI label="Transactions" value={data.sales.length} color="var(--teal)" />
        <KPI label="Avg Sale" value={formatMoney(data.sales.length ? data.total / data.sales.length : 0, currency)} color="var(--text2)" />
        {Object.entries(data.by_method).map(([m, v]) => (
          <KPI key={m} label={m} value={formatMoney(v, currency)} color="var(--blue)" />
        ))}
      </div>

      <div className="report-section">
        <div className="report-section-header">Sales List</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Date</th>
                <th>Customer</th>
                <th>Method</th>
                <th className="right">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.sales.map((s, i) => (
                <tr key={i} style={{background: i%2===0?'var(--bg2)':'var(--bg3)'}}>
                  <td style={{fontFamily:'monospace',fontSize:12,color:'var(--teal)'}}>{s.receipt_no}</td>
                  <td style={{fontSize:12,color:'var(--text2)'}}>{new Date(s.created_at).toLocaleString('en-TZ',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
                  <td>{s.customer_name || 'Walk-in'}</td>
                  <td style={{fontSize:12}}>{s.payment_method}</td>
                  <td className="right font-bold" style={{color:'var(--amber)'}}>{formatMoney(s.total, currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{background:'var(--bg3)',borderTop:'2px solid var(--border2)'}}>
                <td colSpan={4} style={{fontWeight:800,fontSize:15,padding:'12px 16px'}}>TOTAL REVENUE</td>
                <td className="right font-bold" style={{color:'var(--amber)',fontSize:18}}>{formatMoney(data.total, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Debt aging ────────────────────────────────────────────────────────────
function AgingReport({ data, currency }) {
  const buckets = [
    { key:'0_30',   label:'0 – 30 days',  color:'var(--green)' },
    { key:'31_60',  label:'31 – 60 days', color:'var(--amber)' },
    { key:'61_90',  label:'61 – 90 days', color:'var(--accent)' },
    { key:'91_plus',label:'90+ days',     color:'var(--red)' },
  ]
  const grandTotal = buckets.reduce((s, b) => s + (data[b.key] || []).reduce((t,r) => t + r.remaining, 0), 0)

  return (
    <div>
      <div className="report-header">
        <div className="font-head" style={{fontSize:20,fontWeight:800,marginBottom:4}}>Debt Aging Report</div>
        <div style={{color:'var(--text2)',fontSize:13}}>Outstanding customer debts by age</div>
      </div>

      <div className="report-kpi-grid">
        {buckets.map(b => {
          const total = (data[b.key] || []).reduce((t,r) => t+r.remaining, 0)
          return <KPI key={b.key} label={b.label} value={formatMoney(total, currency)} color={b.color} />
        })}
        <KPI label="Grand Total Outstanding" value={formatMoney(grandTotal, currency)} color="var(--red)" large />
      </div>

      {buckets.map(b => (
        (data[b.key] || []).length > 0 && (
          <div key={b.key} className="report-section" style={{marginBottom:12}}>
            <div className="report-section-header" style={{background:b.color+'22',color:b.color,borderBottom:`1px solid ${b.color}44`}}>
              {b.label} — {formatMoney((data[b.key]||[]).reduce((t,r)=>t+r.remaining,0), currency)}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Customer</th><th>Phone</th><th>Days</th><th className="right">Remaining</th></tr>
                </thead>
                <tbody>
                  {data[b.key].map((r,i) => (
                    <tr key={i} style={{background:i%2===0?'var(--bg2)':'var(--bg3)'}}>
                      <td style={{fontWeight:600}}>{r.customer_name}</td>
                      <td style={{fontSize:12,color:'var(--text2)'}}>{r.customer_phone||'—'}</td>
                      <td><span style={{color:b.color,fontWeight:700}}>{r.days_overdue}d</span></td>
                      <td className="right font-bold" style={{color:b.color}}>{formatMoney(r.remaining, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ))}

      {grandTotal === 0 && (
        <div className="empty-state">
          <div className="empty-icon">✅</div>
          <div className="empty-title">No outstanding debts!</div>
        </div>
      )}
    </div>
  )
}

function KPI({ label, value, color, large }) {
  return (
    <div className="report-kpi" style={{borderLeft:`3px solid ${color}`}}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{color, fontSize: large ? 22 : 18}}>{value}</div>
    </div>
  )
}
