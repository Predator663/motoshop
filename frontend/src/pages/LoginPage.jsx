import { useState } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'

export default function LoginPage() {
  const { login, settings } = useApp()
  const T = useT()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin(e) {
    e.preventDefault()
    if (!username || !password) { setError(T('login_error_empty')); return }
    setLoading(true); setError('')
    try { await login(username, password) }
    catch(err) { setError(err.message || T('login_failed')) }
    finally { setLoading(false) }
  }

  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg)',padding:20}}>
      <div style={{width:'100%',maxWidth:360}}>
        <div style={{textAlign:'center',marginBottom:32}}>
          <div style={{fontSize:52,marginBottom:10}}>{settings?.header_icon || '🏍️'}</div>
          <h1 style={{fontFamily:'var(--font-head)',fontSize:26,fontWeight:800,color:'var(--text)',marginBottom:4}}>
            {settings?.header_title || settings?.shop_name || 'MotoShop'}
          </h1>
          <p style={{color:'var(--text3)',fontSize:13}}>{T('login_subtitle')}</p>
        </div>
        <div className="card">
          <form onSubmit={handleLogin} style={{display:'flex',flexDirection:'column',gap:14}}>
            <div className="input-group">
              <label className="input-label">{T('login_username')}</label>
              <input className="input" placeholder="owner" value={username} onChange={e=>setUsername(e.target.value)} autoFocus autoComplete="username" />
            </div>
            <div className="input-group">
              <label className="input-label">{T('login_password')}</label>
              <input className="input" type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" />
            </div>
            {error && <div style={{background:'rgba(239,68,68,.1)',border:'1px solid rgba(239,68,68,.3)',borderRadius:8,padding:'10px 14px',color:'var(--red)',fontSize:13}}>{error}</div>}
            <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={loading}>
              {loading ? <span className="spinner" /> : T('login_btn')}
            </button>
          </form>
        </div>
        <p style={{textAlign:'center',color:'var(--text3)',fontSize:11,marginTop:16}}>{T('login_subtitle')}</p>
      </div>
    </div>
  )
}
