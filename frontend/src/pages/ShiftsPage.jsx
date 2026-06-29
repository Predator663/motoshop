import { useState, useEffect, useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api, formatMoney, formatDateTime } from '../utils/api'
import Modal from '../components/Modal'

export default function ShiftsPage() {
  const { auth, currency, toast, onSSE } = useApp()
  const T = useT()
  const [current, setCurrent] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [openModal, setOpenModal] = useState(false)
  const [closeModal, setCloseModal] = useState(false)
  const [openCash, setOpenCash] = useState('')
  const [closeCash, setCloseCash] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cur, hist] = await Promise.all([
        api.getCurrentShift(),
        auth?.role === 'owner' ? api.getAllShifts() : Promise.resolve([])
      ])
      setCurrent(cur); setHistory(hist)
    } catch { toast(T('shifts_load_failed'), 'error') }
    finally { setLoading(false) }
  }, [auth])

  useEffect(() => { load() }, [load])
  useEffect(() => onSSE(evt => { if (['shift_opened','shift_closed'].includes(evt.type)) load() }), [load, onSSE])

  async function openShift() {
    setSaving(true)
    try {
      const result = await api.openShift({ opening_cash: parseFloat(openCash) || 0 })
      toast(result.offline ? '📴 Zamu imefunguliwa nje ya mtandao — itasawazishwa' : T('shifts_open_ok'), result.offline ? 'warning' : 'success')
      setOpenModal(false); setOpenCash(''); load()
    } catch(err) { toast(err.message || T('shifts_open_failed'), 'error') }
    finally { setSaving(false) }
  }

  async function closeShift() {
    setSaving(true)
    try {
      const result = await api.closeShift({ closing_cash: parseFloat(closeCash) || 0 })
      if (result.offline) {
        // FIX (offline support): no server-computed variance exists yet —
        // it'll be calculated once the close request actually syncs. Don't
        // pretend to show a number we don't have.
        toast('📴 Kufunga zamu kumehifadhiwa nje ya mtandao — tofauti (variance) itahesabiwa baada ya kusawazisha', 'warning', 6000)
      } else {
        const v = result.variance
        toast(T('shifts_close_ok') + (Math.abs(v) < 1 ? ' ✅' : ` — ${v > 0 ? '+' : ''}${formatMoney(v, currency)}`), Math.abs(v) < 1 ? 'success' : 'warning')
      }
      setCloseModal(false); setCloseCash(''); load()
    } catch(err) { toast(err.message || T('shifts_close_failed'), 'error') }
    finally { setSaving(false) }
  }

  const elapsed = current ? Math.floor((Date.now() - new Date(current.opened_at).getTime()) / 60000) : 0

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">{T('shifts_title')}</div>
          <div className="page-sub">{current ? T('shifts_current_label') : T('shifts_no_shift')}</div>
        </div>
      </div>

      <div className={`card`} style={{marginBottom:20,border:`1px solid ${current?'var(--green)':'var(--border)'}`,background:current?'rgba(34,197,94,.04)':undefined}}>
        {current ? (
          <div>
            <div className="flex items-center justify-between" style={{marginBottom:16}}>
              <div>
                <div className="font-head" style={{fontSize:18,fontWeight:700,color:'var(--green)'}}>🟢 {T('shifts_current_label')}{current.offline && <span style={{fontSize:11,color:'var(--amber)',marginLeft:8,fontWeight:600}}>📴 inasubiri kusawazishwa</span>}</div>
                <div style={{color:'var(--text2)',fontSize:13,marginTop:2}}>{T('shifts_since')} {formatDateTime(current.opened_at)} — {elapsed} min</div>
              </div>
              <button className="btn btn-danger" onClick={() => setCloseModal(true)}>{T('shifts_close_btn')}</button>
            </div>
            <div className="grid grid-3" style={{gap:12}}>
              <InfoBox label={T('shifts_cashier')} value={current.cashier_name} />
              <InfoBox label={T('shifts_opening_cash')} value={formatMoney(current.opening_cash, currency)} color="var(--amber)" />
              <InfoBox label="Duration" value={`${Math.floor(elapsed/60)}h ${elapsed%60}m`} />
            </div>
          </div>
        ) : (
          <div style={{textAlign:'center',padding:20}}>
            <div style={{fontSize:40,marginBottom:12}}>⏱️</div>
            <div className="font-head" style={{fontSize:16,marginBottom:6}}>{T('shifts_no_shift')}</div>
            <button className="btn btn-success btn-lg" onClick={() => setOpenModal(true)}>{T('shifts_open_btn')}</button>
          </div>
        )}
      </div>

      {auth?.role === 'owner' && (
        <div>
          <div className="section-title">{T('shifts_history')}</div>
          <div className="card" style={{padding:0,overflow:'hidden'}}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{T('shifts_col_cashier')}</th>
                    <th>{T('shifts_col_opened')}</th>
                    <th>{T('shifts_col_closed')}</th>
                    <th className="right">{T('shifts_col_cash_in')}</th>
                    <th className="right">{T('shifts_col_expected')}</th>
                    <th className="right">{T('shifts_col_actual')}</th>
                    <th className="right">{T('shifts_col_variance')}</th>
                    <th className="center">{T('shifts_col_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    [...Array(4)].map((_,i) => <tr key={i}>{[...Array(8)].map((_,j) => <td key={j}><div className="skeleton" style={{height:14,width:'75%',borderRadius:4}} /></td>)}</tr>)
                  ) : history.length === 0 ? (
                    <tr><td colSpan={8} style={{textAlign:'center',padding:32,color:'var(--text3)'}}>{T('shifts_empty')}</td></tr>
                  ) : history.map(s => (
                    <tr key={s.id}>
                      <td style={{fontWeight:600}}>{s.cashier_name}</td>
                      <td style={{fontSize:12,color:'var(--text2)'}}>{formatDateTime(s.opened_at)}</td>
                      <td style={{fontSize:12,color:'var(--text2)'}}>{s.closed_at ? formatDateTime(s.closed_at) : <span style={{color:'var(--green)'}}>{T('shifts_still_open')}</span>}</td>
                      <td className="right">{formatMoney(s.opening_cash, currency)}</td>
                      <td className="right">{s.closing_cash_expected != null ? formatMoney(s.closing_cash_expected, currency) : '—'}</td>
                      <td className="right">{s.closing_cash_actual != null ? formatMoney(s.closing_cash_actual, currency) : '—'}</td>
                      <td className="right">{s.variance != null ? (
                        <span style={{color: Math.abs(s.variance)<1?'var(--green)':s.variance>0?'var(--amber)':'var(--red)',fontWeight:700}}>
                          {s.variance>0?'+':''}{formatMoney(s.variance, currency)}
                        </span>
                      ) : '—'}</td>
                      <td className="center"><span className={`badge ${s.status==='open'?'badge-green':'badge-gray'}`}>{s.status==='open'?T('shifts_still_open'):T('shifts_col_closed')}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {openModal && (
        <Modal title={T('shifts_open_shift')} onClose={() => setOpenModal(false)}
          footer={<><button className="btn btn-secondary" onClick={() => setOpenModal(false)}>{T('cancel')}</button><button className="btn btn-success" onClick={openShift} disabled={saving}>{saving ? <span className="spinner" /> : `🟢 ${T('shifts_open_shift')}`}</button></>}
        >
          <div className="input-group">
            <label className="input-label">{T('shifts_opening_cash')}</label>
            <input className="input" type="number" min="0" placeholder="0" value={openCash} onChange={e=>setOpenCash(e.target.value)} autoFocus />
          </div>
        </Modal>
      )}

      {closeModal && (
        <Modal title={T('shifts_close_shift')} onClose={() => setCloseModal(false)}
          footer={<><button className="btn btn-secondary" onClick={() => setCloseModal(false)}>{T('cancel')}</button><button className="btn btn-danger" onClick={closeShift} disabled={saving}>{saving ? <span className="spinner" /> : T('shifts_close_btn')}</button></>}
        >
          <div className="input-group">
            <label className="input-label">{T('shifts_closing_cash')}</label>
            <input className="input" type="number" min="0" value={closeCash} onChange={e=>setCloseCash(e.target.value)} autoFocus />
          </div>
        </Modal>
      )}
    </div>
  )
}

function InfoBox({ label, value, color }) {
  return (
    <div style={{background:'var(--bg3)',borderRadius:'var(--radius-sm)',padding:'12px 14px'}}>
      <div className="stat-label">{label}</div>
      <div style={{fontWeight:700,marginTop:4,color:color||'var(--text)'}}>{value}</div>
    </div>
  )
}
