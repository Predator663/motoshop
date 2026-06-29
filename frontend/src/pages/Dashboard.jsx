import { useState, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api, formatMoney, formatDateTime } from '../utils/api'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'

const COLORS = ['#e8500a','#f5a623','#22c55e','#14b8a6','#3b82f6','#a855f7']

export default function Dashboard() {
  const { auth, currency, onSSE, toast, setActiveTab } = useApp()
  const T = useT()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try { const d = await api.getDashboard(); setData(d) }
    catch { toast(T('dash_title') + ' — error', 'error') }
    finally { setLoading(false) }
  }, [toast])

  useEffect(() => { load() }, [load])
  useEffect(() => onSSE(evt => {
    if (['sale_created','sale_cancelled','expense_created','stock_updated'].includes(evt.type)) load()
  }), [load, onSSE])

  if (loading) return <LoadingGrid />
  if (auth?.role === 'cashier') return <CashierDash data={data} currency={currency} setActiveTab={setActiveTab} T={T} />
  return <OwnerDash data={data} currency={currency} setActiveTab={setActiveTab} T={T} />
}

function OwnerDash({ data, currency, setActiveTab, T }) {
  const d = data || {}
  const top5Data = (d.top5 || []).map(t => ({ name: t.product_name?.substring(0,14), revenue: t.revenue }))
  const payData = (d.payment_breakdown || []).map(p => ({ name: p.payment_method, value: p.total }))

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{T('dash_title')}</div>
          <div className="page-sub">{T('dash_subtitle')} — {new Date().toLocaleDateString(undefined, {weekday:'long',day:'numeric',month:'long'})}</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setActiveTab('pos')}>{T('dash_new_sale')}</button>
      </div>
      <div className="grid grid-4" style={{marginBottom:20}}>
        <StatCard label={T('dash_revenue')} value={formatMoney(d.revenue, currency)} color="var(--amber)" icon="💰" delay={0} />
        <StatCard label={T('dash_gross_profit')} value={formatMoney(d.gross_profit, currency)} color="var(--green)" icon="📈" delay={80} />
        <StatCard label={T('dash_net_profit')} value={formatMoney(d.net_profit, currency)} color={d.net_profit >= 0 ? 'var(--green)' : 'var(--red)'} icon="🏦" delay={160} />
        <StatCard label={T('dash_transactions')} value={d.tx_count || 0} color="var(--teal)" icon="🧾" delay={240} sub={`${d.customers_total || 0} ${T('dash_lifetime_customers')}`} />
      </div>
      <div className="grid grid-4" style={{marginBottom:24}}>
        <StatCard label={T('dash_expenses')} value={formatMoney(d.expenses_today, currency)} color="var(--red)" icon="💸" delay={80} />
        <StatCard label={T('dash_debts')} value={formatMoney(d.debts_total, currency)} color="var(--amber)" icon="💳" delay={160} onClick={() => setActiveTab('debts')} />
        <StatCard label={T('dash_low_stock')} value={d.low_stock_count || 0} color={d.low_stock_count > 0 ? 'var(--red)' : 'var(--green)'} icon="📦" delay={240} onClick={() => setActiveTab('stock')} />
        <StatCard label={T('dash_cogs')} value={formatMoney(d.cogs, currency)} color="var(--text2)" icon="🔧" delay={320} />
      </div>
      <div className="grid grid-2" style={{marginBottom:24}}>
        <div className="card" style={{animationDelay:'.2s',animation:'card-in .4s both'}}>
          <div className="section-title">{T('dash_top5')}</div>
          {top5Data.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={top5Data} margin={{left:-10}}>
                <XAxis dataKey="name" tick={{fontSize:11,fill:'var(--text3)'}} />
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} />
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,fontSize:12}} formatter={(v) => [formatMoney(v), T('dash_revenue_label')]} />
                <Bar dataKey="revenue" fill="var(--accent)" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyMini text={T('dash_no_sales')} />}
        </div>
        <div className="card" style={{animationDelay:'.3s',animation:'card-in .4s both'}}>
          <div className="section-title">{T('dash_payment_methods')}</div>
          {payData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={payData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({name,percent}) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={11}>
                  {payData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:8,fontSize:12}} formatter={(v) => [formatMoney(v), T('total')]} />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptyMini text={T('dash_no_sales')} />}
        </div>
      </div>
    </div>
  )
}

function CashierDash({ data, currency, setActiveTab, T }) {
  const d = data || {}
  const shiftOpen = d.shift_status === 'open'
  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{T('dash_my_title')}</div>
          <div className="page-sub">
            {shiftOpen
              ? `${T('dash_shift_open_since')} ${new Date(d.shift_opened).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}`
              : T('dash_no_shift')}
          </div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setActiveTab('pos')}>{T('dash_sell')}</button>
      </div>
      <div className="grid grid-2" style={{marginBottom:20}}>
        <StatCard label={T('dash_shift_status')} value={shiftOpen ? T('dash_open') : T('dash_closed')} color={shiftOpen ? 'var(--green)' : 'var(--red)'} icon={shiftOpen ? '🟢' : '🔴'} delay={0} />
        <StatCard label={T('dash_low_stock')} value={d.low_stock_count || 0} color={d.low_stock_count > 0 ? 'var(--red)' : 'var(--green)'} icon="📦" delay={80} onClick={() => setActiveTab('stock')} />
        <StatCard label={T('dash_shift_revenue')} value={formatMoney(d.revenue, currency)} color="var(--amber)" icon="💰" delay={160} />
        <StatCard label={T('dash_transactions')} value={d.tx_count || 0} color="var(--teal)" icon="🧾" delay={240} />
      </div>
      {!shiftOpen && (
        <div className="card" style={{borderColor:'var(--amber)',background:'rgba(245,166,35,.05)',textAlign:'center',padding:32}}>
          <div style={{fontSize:40,marginBottom:12}}>⚠️</div>
          <div className="font-head" style={{fontSize:16,marginBottom:8}}>{T('dash_no_shift_warning')}</div>
          <p style={{color:'var(--text3)',marginBottom:16}}>{T('dash_no_shift_msg')}</p>
          <button className="btn btn-primary" onClick={() => setActiveTab('shifts')}>{T('dash_open_shift')}</button>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color, icon, delay=0, sub, onClick }) {
  return (
    <div className="stat-card" style={{'--accent-line':color,animationDelay:`${delay}ms`,cursor:onClick?'pointer':undefined}} onClick={onClick}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between'}}>
        <div className="stat-label">{label}</div>
        <span style={{fontSize:18}}>{icon}</span>
      </div>
      <div className="stat-value" style={{color}}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}
function EmptyMini({ text }) {
  return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:150,color:'var(--text3)',fontSize:13}}>{text}</div>
}
function LoadingGrid() {
  return (
    <div>
      <div className="page-header"><div className="skeleton" style={{width:200,height:28}} /></div>
      <div className="grid grid-4" style={{marginBottom:20}}>
        {[...Array(8)].map((_,i)=><div key={i} className="skeleton" style={{height:90,borderRadius:'var(--radius)'}} />)}
      </div>
    </div>
  )
}
