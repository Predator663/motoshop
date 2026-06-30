// src/pages/SettingsPage.jsx
import { useState, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import { api } from '../utils/api'
import Modal from '../components/Modal'

export default function SettingsPage() {
  const { settings, setSettings, toast } = useApp()
  const T = useT()
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [cashierStatus, setCashierStatus] = useState(null)
  const [cashierId, setCashierId] = useState(null)
  const [cashierActiveUntil, setCashierActiveUntil] = useState(null)
  const [accessMode, setAccessMode] = useState('permanent') // 'permanent' | 'days'
  const [accessDays, setAccessDays] = useState(1)
  const [resetPwModal, setResetPwModal] = useState(false)
  const [newCashierPw, setNewCashierPw] = useState('')
  const [catModal, setCatModal] = useState(false)

  useEffect(() => {
    setForm({
      shop_name: settings.shop_name || '',
      shop_phone: settings.shop_phone || '',
      shop_address: settings.shop_address || '',
      receipt_footer: settings.receipt_footer || '',
      vat_default: settings.vat_default || '0',
      currency: settings.currency || 'Tsh',
      low_stock_multiplier: settings.low_stock_multiplier || '1.5',
      language: settings.language || 'sw',
      header_title: settings.header_title || settings.shop_name || '',
      header_subtitle: settings.header_subtitle || 'Mfumo wa Usimamizi',
      header_icon: settings.header_icon || '🏍️',
      logo_image: settings.logo_image || '',
    })
    api.getCashierStatus().then(d => {
      setCashierStatus(d.is_active)
      if (d.id) setCashierId(d.id)
      setCashierActiveUntil(d.active_until || null)
    }).catch(() => {})
  }, [settings])

  async function save() {
    setSaving(true)
    try {
      const result = await api.updateSettings(form)
      // Optimistic update applies either way — updateSettings already
      // queues itself offline, so this is safe to do unconditionally.
      setSettings(s => ({...s, ...form}))
      toast(result?.offline ? 'Imehifadhiwa nje ya mtandao — itasawazishwa ukirudi mtandaoni' : T('settings_saved'), result?.offline ? 'warning' : 'success')
    } catch(err) { toast(err.message || T('settings_save_failed'), 'error') }
    finally { setSaving(false) }
  }

  async function toggleCashier() {
    try {
      if (cashierStatus) {
        // Disabling — no days needed.
        const result = await api.setCashierStatus(false)
        setCashierStatus(result.is_active)
        setCashierActiveUntil(null)
        toast('Akaunti ya mkashia imezimwa', 'success')
      } else {
        // Enabling — respect the chosen access mode.
        const days = accessMode === 'days' ? accessDays : null
        const result = await api.setCashierStatus(true, days)
        setCashierStatus(result.is_active)
        setCashierActiveUntil(result.active_until || null)
        toast(
          result.active_until
            ? `Akaunti imewezeshwa kwa siku ${accessDays}`
            : 'Akaunti imewezeshwa permanently',
          'success'
        )
      }
    } catch(err) { toast(err.message || T('settings_cashier_toggle_failed'), 'error') }
  }

  async function resetCashierPw() {
    if (!newCashierPw || newCashierPw.length < 4) { toast(T('settings_reset_pw_short'), 'error'); return }
    try {
      await api.resetCashierPw(newCashierPw, cashierId)
      toast(T('settings_reset_pw_ok'), 'success')
      setResetPwModal(false)
      setNewCashierPw('')
    } catch(err) { toast(err.message || T('settings_cashier_toggle_failed'), 'error') }
  }

  const set = k => e => setForm(f => ({...f, [k]: e.target.value}))

  // Emoji options for header icon
  const iconOptions = ['🏍️','🔧','🛒','🏪','⚙️','🔩','🚗','🚙','🛞','🔑','💼','🏬']

  return (
    <div style={{maxWidth:720}}>
      <div className="page-header">
        <div><div className="page-title">{T('settings_title')}</div><div className="page-sub">Mipangilio ya duka na mfumo</div></div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? <span className="spinner" /> : '💾 Hifadhi Mipangilio'}
        </button>
      </div>

      {/* Header Customization */}
      <div className="card" style={{marginBottom:16,border:'2px solid var(--accent)',borderRadius:'var(--radius)'}}>
        <div className="section-title" style={{color:'var(--accent)'}}>🎨 Mipangilio ya Kichwa cha Mfumo</div>
        <p style={{fontSize:12,color:'var(--text3)',marginBottom:14}}>{T('settings_header_desc')}</p>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
          <div className="input-group" style={{gridColumn:'1/-1'}}>
            <label className="input-label">Kichwa cha Mfumo (Header Title)</label>
            <input className="input" value={form.header_title||''} onChange={set('header_title')} placeholder="MotoShop" />
          </div>
          <div className="input-group" style={{gridColumn:'1/-1'}}>
            <label className="input-label">Maandishi Chini ya Kichwa (Subtitle)</label>
            <input className="input" value={form.header_subtitle||''} onChange={set('header_subtitle')} placeholder="Mfumo wa Usimamizi" />
          </div>
          <div className="input-group">
            <label className="input-label">Ikoni ya Kichwa (Header Icon)</label>
            <input className="input" value={form.header_icon||''} onChange={set('header_icon')} placeholder="🏍️" maxLength={4} style={{fontSize:20}} />
          </div>
          <div className="input-group">
            <label className="input-label">Chagua Ikoni Haraka</label>
            <div style={{display:'flex',flexWrap:'wrap',gap:6,marginTop:4}}>
              {iconOptions.map(ic => (
                <button
                  key={ic}
                  type="button"
                  onClick={() => setForm(f => ({...f, header_icon: ic}))}
                  style={{
                    fontSize:20, padding:'6px 10px', borderRadius:8, cursor:'pointer',
                    border: form.header_icon === ic ? '2px solid var(--accent)' : '1px solid var(--border)',
                    background: form.header_icon === ic ? 'var(--bg3)' : 'var(--bg4)',
                    transition:'all .15s'
                  }}
                >{ic}</button>
              ))}
            </div>
          </div>
        </div>
        {/* Preview */}
        <div style={{marginTop:14,padding:'12px 16px',background:'var(--bg3)',borderRadius:'var(--radius-sm)',border:'1px solid var(--border)'}}>
          <div style={{fontSize:11,color:'var(--text3)',marginBottom:6}}>{T('settings_preview')}</div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            {form.logo_image ? (
              <img src={form.logo_image} alt="logo" style={{height:36,width:36,objectFit:'contain',borderRadius:6,border:'1px solid var(--border)'}} />
            ) : (
              <span style={{fontSize:24}}>{form.header_icon || '🏍️'}</span>
            )}
            <div>
              <div style={{fontFamily:'var(--font-head)',fontWeight:700,fontSize:16,color:'var(--text)'}}>{form.header_title || 'MotoShop'}</div>
              {form.header_subtitle && <div style={{fontSize:11,color:'var(--text3)'}}>{form.header_subtitle}</div>}
            </div>
          </div>
        </div>

        {/* Logo Image Upload */}
        <div style={{marginTop:14,padding:'12px 16px',background:'var(--bg3)',borderRadius:'var(--radius-sm)',border:'1px solid var(--border)'}}>
          <div style={{fontSize:11,fontWeight:600,color:'var(--text2)',textTransform:'uppercase',letterSpacing:'.6px',marginBottom:8}}>📸 Picha ya Nembo (Logo)</div>
          <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
            {form.logo_image && (
              <img src={form.logo_image} alt="logo preview" style={{height:56,maxWidth:120,objectFit:'contain',borderRadius:8,border:'1px solid var(--border)',background:'#fff',padding:4}} />
            )}
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              <label style={{cursor:'pointer',display:'inline-flex',alignItems:'center',gap:6,padding:'7px 14px',background:'var(--bg4)',border:'1.5px dashed var(--border2)',borderRadius:'var(--radius-sm)',fontSize:13,color:'var(--text2)',fontWeight:600,transition:'border-color .15s'}}
                onMouseEnter={e=>e.currentTarget.style.borderColor='var(--accent)'}
                onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border2)'}
              >
                📂 Pakia Picha ya Nembo
                <input type="file" accept="image/*" style={{display:'none'}} onChange={e => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  if (file.size > 512 * 1024) { alert('Picha lazima iwe chini ya 512KB'); return }
                  const reader = new FileReader()
                  reader.onload = ev => setForm(f => ({...f, logo_image: ev.target.result}))
                  reader.readAsDataURL(file)
                }} />
              </label>
              {form.logo_image && (
                <button type="button" className="btn btn-ghost btn-sm" style={{color:'var(--red)',fontSize:12}} onClick={() => setForm(f => ({...f, logo_image: ''}))}>
                  🗑 Ondoa Nembo
                </button>
              )}
              <span style={{fontSize:11,color:'var(--text3)'}}>PNG/JPG, chini ya 512KB</span>
            </div>
          </div>
        </div>
      </div>

      {/* Shop Info */}
      <div className="card" style={{marginBottom:16}}>
        <div className="section-title">Taarifa za Duka</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
          <div className="input-group" style={{gridColumn:'1/-1'}}>
            <label className="input-label">Jina la Duka</label>
            <input className="input" value={form.shop_name||''} onChange={set('shop_name')} />
          </div>
          <div className="input-group">
            <label className="input-label">Nambari ya Simu</label>
            <input className="input" value={form.shop_phone||''} onChange={set('shop_phone')} />
          </div>
          <div className="input-group">
            <label className="input-label">Sarafu (Currency)</label>
            <input className="input" value={form.currency||''} onChange={set('currency')} placeholder="Tsh" />
          </div>
          <div className="input-group" style={{gridColumn:'1/-1'}}>
            <label className="input-label">Anwani</label>
            <input className="input" value={form.shop_address||''} onChange={set('shop_address')} />
          </div>
          <div className="input-group" style={{gridColumn:'1/-1'}}>
            <label className="input-label">Ujumbe wa Mwisho wa Risiti</label>
            <input className="input" value={form.receipt_footer||''} onChange={set('receipt_footer')} />
          </div>
        </div>
      </div>

      {/* POS Settings */}
      <div className="card" style={{marginBottom:16}}>
        <div className="section-title">Mipangilio ya Mauzo</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
          <div className="input-group">
            <label className="input-label">VAT ya Kawaida</label>
            <select className="input" value={form.vat_default||'0'} onChange={set('vat_default')}>
              <option value="0">{T('settings_vat_off')}</option>
              <option value="18">{T('settings_vat_on')}</option>
            </select>
          </div>
          <div className="input-group">
            <label className="input-label">Kiwango cha Onyo la Akiba</label>
            <input className="input" type="number" step="0.1" min="1" value={form.low_stock_multiplier||'1.5'} onChange={set('low_stock_multiplier')} />
            <span style={{fontSize:11,color:'var(--text3)',marginTop:4}}>Onya wakati akiba &lt; kiwango × {form.low_stock_multiplier || '1.5'}</span>
          </div>
          <div className="input-group">
            <label className="input-label">Lugha ya Mfumo</label>
            <select className="input" value={form.language||'sw'} onChange={set('language')}>
              <option value="sw">{T('settings_lang_sw')}</option>
              <option value="en">{T('settings_lang_en')}</option>
            </select>
          </div>
        </div>
      </div>

      {/* Cashier Management */}
      <div className="card" style={{marginBottom:16}}>
        <div className="section-title">Akaunti ya Mkashia</div>
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          <div className="flex items-center justify-between" style={{padding:'12px 0',borderBottom:'1px solid var(--border)'}}>
            <div>
              <div style={{fontWeight:600}}>Hali ya Akaunti ya Mkashia</div>
              <div style={{fontSize:12,color:'var(--text3)',marginTop:2}}>
                {cashierStatus ? T('settings_cashier_enabled') : T('settings_cashier_disabled')}
                {cashierStatus && cashierActiveUntil && (
                  <span> · Itazimika: {new Date(cashierActiveUntil).toLocaleString('sw-TZ', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</span>
                )}
                {cashierStatus && !cashierActiveUntil && (
                  <span> · Permanent</span>
                )}
              </div>
            </div>
            <button className={`btn btn-sm ${cashierStatus ? 'btn-danger' : 'btn-success'}`} onClick={toggleCashier}>
              {cashierStatus ? 'Zima' : 'Wezesha'}
            </button>
          </div>

          {!cashierStatus && (
            <div style={{padding:'4px 0 12px',borderBottom:'1px solid var(--border)'}}>
              <div style={{fontSize:12,fontWeight:600,color:'var(--text2)',marginBottom:8}}>Aina ya Ufikiaji Ukiwezesha</div>
              <div className="flex gap-2" style={{marginBottom: accessMode === 'days' ? 10 : 0, flexWrap:'wrap'}}>
                <button
                  className={`btn btn-sm ${accessMode === 'permanent' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setAccessMode('permanent')}
                >Permanent</button>
                <button
                  className={`btn btn-sm ${accessMode === 'days' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setAccessMode('days')}
                >Idadi ya Siku</button>
              </div>
              {accessMode === 'days' && (
                <div className="input-group" style={{maxWidth:160}}>
                  <label className="input-label text-xs">Siku ngapi?</label>
                  <input
                    className="input input-sm"
                    type="number"
                    min="1"
                    max="365"
                    value={accessDays}
                    onChange={e => setAccessDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
                  />
                  <span style={{fontSize:11,color:'var(--text3)',marginTop:4}}>
                    Akaunti itajizima yenyewe baada ya siku {accessDays} — owner hatahitaji kuwezesha kila siku.
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between" style={{padding:'12px 0'}}>
            <div>
              <div style={{fontWeight:600}}>Badilisha Nywila ya Mkashia</div>
              <div style={{fontSize:12,color:'var(--text3)',marginTop:2}}>Weka nywila mpya kwa mkashia</div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => setResetPwModal(true)}>{T('settings_reset_pw_btn')}</button>
          </div>
        </div>
      </div>

      {/* Data */}
      <div className="card" style={{marginBottom:16}}>
        <div className="section-title">Usimamizi wa Data</div>
        <div className="flex items-center justify-between" style={{padding:'12px 0',borderBottom:'1px solid var(--border)'}}>
          <div>
            <div style={{fontWeight:600}}>Nakala ya Hifadhidata</div>
            <div style={{fontSize:12,color:'var(--text3)',marginTop:2}}>Pakua faili kamili la SQLite</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => api.downloadBackup()}>{T('settings_backup_btn')}</button>
        </div>
        <div className="flex items-center justify-between" style={{padding:'12px 0'}}>
          <div>
            <div style={{fontWeight:600}}>Simamia Aina za Bidhaa</div>
            <div style={{fontSize:12,color:'var(--text3)',marginTop:2}}>Ongeza, hariri, au futa aina za bidhaa</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => setCatModal(true)}>{T('settings_cats_btn')}</button>
        </div>
      </div>

      {resetPwModal && (
        <Modal title={T('settings_reset_pw_title')} onClose={() => setResetPwModal(false)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setResetPwModal(false)}>Ghairi</button>
              <button className="btn btn-primary" onClick={resetCashierPw}>{T('settings_reset_pw_btn')}</button>
            </>
          }
        >
          <div className="input-group">
            <label className="input-label">Nywila Mpya (angalau herufi 4)</label>
            <input className="input" type="password" value={newCashierPw} onChange={e=>setNewCashierPw(e.target.value)} autoFocus />
          </div>
        </Modal>
      )}

      {catModal && <CategoriesModal onClose={() => setCatModal(false)} toast={toast} />}
    </div>
  )
}

function CategoriesModal({
  onClose, toast }) {
  const T = useT()
  const [categories, setCategories] = useState([])
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [editId, setEditId] = useState(null)
  const [editName, setEditName] = useState('')

  useEffect(() => { api.getCategories().then(setCategories).catch(() => {}) }, [])

  async function add() {
    if (!newName.trim()) { toast(T('settings_cat_empty_name'), 'warning'); return }
    setSaving(true)
    try {
      const name = newName.trim()
      const result = await api.createCategory({ name })
      if (result?.offline) {
        // FIX (offline support): the server hasn't assigned a real id/name
        // yet — use what we already know locally instead of the bare
        // {offline, local_ref} shape, so the row renders correctly.
        setCategories(c => [...c, { id: result.local_ref, name, _pendingSync: true }])
        toast(`Aina "${name}" imehifadhiwa nje ya mtandao`, 'warning')
      } else {
        setCategories(c => [...c, result])
        toast(`Aina "${result.name}" imeongezwa`, 'success')
      }
      setNewName('')
    } catch(err) { toast(err.message || T('settings_cat_add_failed'), 'error') }
    finally { setSaving(false) }
  }

  async function saveEdit(id) {
    if (!editName.trim()) { toast('Weka jina', 'warning'); return }
    try {
      const result = await api.updateCategory(id, { name: editName.trim() })
      setCategories(c => c.map(x => x.id === id ? {...x, name: editName.trim(), _pendingSync: !!result?.offline} : x))
      setEditId(null)
      toast(result?.offline ? 'Imehifadhiwa nje ya mtandao' : T('settings_cat_updated'), result?.offline ? 'warning' : 'success')
    } catch(err) { toast(err.message || T('settings_cat_update_failed'), 'error') }
  }

  async function del(id, name) {
    if (!confirm(T('settings_cat_delete_confirm') + ' "' + name + '"?')) return
    try {
      await api.deleteCategory(id)
      setCategories(c => c.filter(x => x.id !== id))
      toast(T('settings_cat_deleted'), 'success')
    } catch(err) {
      // FIX (offline support): deletion needs a live server check (whether
      // any product still uses this category), so it can't be queued.
      toast(err.message || (!navigator.onLine ? 'Kufuta kunahitaji mtandao' : T('settings_cat_delete_failed')), 'error')
    }
  }

  return (
    <Modal title="📂 Simamia Aina za Bidhaa" onClose={onClose} size="lg">
      <div style={{display:'flex',flexDirection:'column',gap:16}}>
        {/* Add new */}
        <div style={{background:'var(--bg3)',borderRadius:'var(--radius-sm)',padding:14}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:10,color:'var(--text2)'}}>{T('settings_cats_add_section')}</div>
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Jina la aina mpya (mfano: Vipande vya Pikipiki)"
              value={newName}
              onChange={e=>setNewName(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&add()}
            />
            <button className="btn btn-primary" onClick={add} disabled={saving}>
              {saving ? <span className="spinner" style={{width:16,height:16}} /> : '+ Ongeza'}
            </button>
          </div>
        </div>

        {/* List */}
        <div>
          <div style={{fontSize:12,color:'var(--text3)',marginBottom:8}}>{T('settings_cats_list_label')} ({categories.length})</div>
          <div style={{maxHeight:350,overflowY:'auto',display:'flex',flexDirection:'column',gap:4}}>
            {categories.length === 0 ? (
              <div style={{textAlign:'center',padding:20,color:'var(--text3)'}}>Hakuna aina</div>
            ) : categories.map(c => (
              <div key={c.id} className="cat-row">
                {editId === c.id ? (
                  <div className="flex gap-2 flex-1">
                    <input
                      className="input input-sm flex-1"
                      value={editName}
                      onChange={e=>setEditName(e.target.value)}
                      onKeyDown={e=>e.key==='Enter'&&saveEdit(c.id)}
                      autoFocus
                    />
                    <button className="btn btn-success btn-sm" onClick={() => saveEdit(c.id)}>✓</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}>✕</button>
                  </div>
                ) : (
                  <>
                    <span style={{flex:1,fontWeight:500}}>{c.name}</span>
                    <button className="btn btn-ghost btn-sm" style={{color:'var(--teal)'}} onClick={() => { setEditId(c.id); setEditName(c.name) }}>✏️</button>
                    <button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} onClick={() => del(c.id, c.name)}>🗑️</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
