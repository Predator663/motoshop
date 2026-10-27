// src/pages/SetupPage.jsx
import { useState } from 'react'
import { api } from '../utils/api'
import { useT } from '../hooks/useT'

export default function SetupPage({ onDone }) {
  const T = useT()
  const [form, setForm] = useState({
    shop_name: '', shop_phone: '', shop_address: '',
    owner_password: '', cashier_name: '', cashier_password: '',
    receipt_footer: 'Asante kwa biashara yako!'
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = k => e => setForm(f => ({...f, [k]: e.target.value}))

  async function submit() {
    const required = ['shop_name','shop_phone','shop_address','owner_password','cashier_name','cashier_password']
    for (const f of required) {
      if (!form[f]) { setError(`Tafadhali jaza: ${f.replace(/_/g,' ')}`); return }
    }
    setLoading(true); setError('')
    try {
      await api.setup(form)
      onDone()
    } catch(e) { setError(e.message || T('setup_failed')) }
    finally { setLoading(false) }
  }

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)', padding:20 }}>
      <div style={{ width:'100%', maxWidth:520 }}>
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <div style={{ fontSize:48, marginBottom:8 }}>🏍️</div>
          <h1 style={{ fontFamily:'var(--font-head)', fontSize:28, fontWeight:800, color:'var(--text)', marginBottom:4 }}>Karibu MotoShop</h1>
          <p style={{ color:'var(--text3)', fontSize:14 }}>Sanidi mfumo wako wa duka la kwanza</p>
        </div>

        <div className="card" style={{ marginBottom:16 }}>
          <div className="section-title">Taarifa za Duka</div>
          <div style={{ display:'grid', gap:12 }}>
            <div className="input-group">
              <label className="input-label">Jina la Duka *</label>
              <input className="input" placeholder={T('setup_shop_name_placeholder')} value={form.shop_name} onChange={set('shop_name')} />
            </div>
            <div className="input-group">
              <label className="input-label">Nambari ya Simu *</label>
              <input className="input" placeholder="+255 XXX XXX XXX" value={form.shop_phone} onChange={set('shop_phone')} />
            </div>
            <div className="input-group">
              <label className="input-label">Anwani *</label>
              <input className="input" placeholder="Mfano: Dar es Salaam, Tanzania" value={form.shop_address} onChange={set('shop_address')} />
            </div>
            <div className="input-group">
              <label className="input-label">Ujumbe wa Risiti</label>
              <input className="input" value={form.receipt_footer} onChange={set('receipt_footer')} />
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom:16 }}>
          <div className="section-title">Akaunti ya Mmiliki</div>
          <div style={{ display:'grid', gap:12 }}>
            <div className="input-group">
              <label className="input-label">Nywila ya Mmiliki *</label>
              <input className="input" type="password" placeholder="Nywila ya siri" value={form.owner_password} onChange={set('owner_password')} />
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom:20 }}>
          <div className="section-title">Akaunti ya Mkashia</div>
          <div style={{ display:'grid', gap:12 }}>
            <div className="input-group">
              <label className="input-label">Jina la Mtumiaji wa Mkashia *</label>
              <input className="input" placeholder="Mfano: mkashia1" value={form.cashier_name} onChange={set('cashier_name')} />
            </div>
            <div className="input-group">
              <label className="input-label">Nywila ya Mkashia *</label>
              <input className="input" type="password" placeholder="Nywila ya mkashia" value={form.cashier_password} onChange={set('cashier_password')} />
            </div>
          </div>
        </div>

        {error && (
          <div style={{ background:'rgba(239,68,68,.1)', border:'1px solid rgba(239,68,68,.3)', borderRadius:8, padding:'10px 14px', color:'var(--red)', fontSize:13, marginBottom:12 }}>
            {error}
          </div>
        )}

        <button className="btn btn-primary btn-block btn-lg" onClick={submit} disabled={loading}>
          {loading ? <><span className="spinner" style={{width:18,height:18}} /> Inasanidi...</> : '🚀 Kamilisha Usanidi'}
        </button>
      </div>
    </div>
  )
}
