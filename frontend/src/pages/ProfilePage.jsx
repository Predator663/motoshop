import { useState } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api } from '../utils/api'

export default function ProfilePage() {
  const { auth, logout, toast } = useApp()
  const T = useT()
  const [form, setForm] = useState({ old_password:'', new_password:'', confirm:'' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function changePassword(e) {
    e.preventDefault(); setError('')
    if (form.new_password !== form.confirm) { setError(T('profile_pw_mismatch')); return }
    if (form.new_password.length < 4) { setError(T('profile_pw_short')); return }
    setSaving(true)
    try {
      await api.changePassword(form.old_password, form.new_password)
      toast(T('profile_pw_ok'), 'success')
      setTimeout(logout, 1500)
    } catch(err) { setError(err.message || T('profile_pw_failed')) }
    finally { setSaving(false) }
  }

  return (
    <div style={{maxWidth:480}}>
      <div className="page-header">
        <div><div className="page-title">{T('profile_title')}</div></div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div className="section-title">{T('profile_title')}</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,padding:'4px 0'}}>
          <div><div className="input-label">{T('profile_username')}</div><div style={{fontWeight:700,marginTop:4,fontSize:15}}>{auth?.username}</div></div>
          <div><div className="input-label">{T('profile_role')}</div>
            <div style={{marginTop:4}}>
              <span className={`badge ${auth?.role==='owner'?'badge-amber':'badge-teal'}`}>
                {auth?.role === 'owner' ? T('profile_role_owner') : T('profile_role_cashier')}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div className="section-title">{T('profile_change_pw')}</div>
        <form onSubmit={changePassword} style={{display:'flex',flexDirection:'column',gap:12}}>
          <div className="input-group">
            <label className="input-label">{T('profile_old_pw')}</label>
            <input className="input" type="password" value={form.old_password} onChange={e=>setForm(f=>({...f,old_password:e.target.value}))} autoComplete="current-password" />
          </div>
          <div className="input-group">
            <label className="input-label">{T('profile_new_pw')}</label>
            <input className="input" type="password" value={form.new_password} onChange={e=>setForm(f=>({...f,new_password:e.target.value}))} autoComplete="new-password" />
          </div>
          <div className="input-group">
            <label className="input-label">{T('profile_confirm_pw')}</label>
            <input className="input" type="password" value={form.confirm} onChange={e=>setForm(f=>({...f,confirm:e.target.value}))} autoComplete="new-password" />
          </div>
          {error && <div style={{color:'var(--red)',fontSize:13,padding:'8px 12px',background:'rgba(239,68,68,.1)',borderRadius:8}}>{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? <span className="spinner" /> : T('profile_save_pw')}
          </button>
        </form>
      </div>

      <div className="card">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div>
            <div style={{fontWeight:600}}>{T('profile_logout')}</div>
            <div style={{fontSize:12,color:'var(--text3)',marginTop:2}}>{T('profile_logout')}</div>
          </div>
          <button className="btn btn-danger btn-sm" onClick={() => { if(confirm(T('profile_logout') + '?')) logout() }}>{T('profile_logout')}</button>
        </div>
      </div>
    </div>
  )
}
