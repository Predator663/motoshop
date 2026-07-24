import { useState, useEffect, useCallback, useRef } from 'react'
import { useApp } from '../context/AppContext'
import { api, formatDateTime } from '../utils/api'

const ALL_MODULES = [
  { key: 'dashboard', label: 'Dashibodi' },
  { key: 'pos', label: 'POS (Mauzo Mapya)' },
  { key: 'sales', label: 'Historia ya Mauzo' },
  { key: 'debts', label: 'Madeni' },
  { key: 'products', label: 'Bidhaa' },
  { key: 'stock', label: 'Stock' },
  { key: 'expenses', label: 'Matumizi' },
  { key: 'reports', label: 'Ripoti' },
  { key: 'shifts', label: 'Zamu' },
  { key: 'settings', label: 'Settings' },
  { key: 'profile', label: 'Profile' },
]

function fmtBytes(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
function fmtDuration(sec) {
  if (sec == null) return '—'
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export default function SuperAdminPage() {
  const { auth, logout, toast, refreshSystemStatus } = useApp()
  const [tab, setTab] = useState('overview')

  return (
    <div style={{ minHeight: '100vh', background: '#0a0f16', color: '#e2e8f0' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px', background: '#0f1923', borderBottom: '2px solid #f5a524',
        position: 'sticky', top: 0, zIndex: 10, flexWrap: 'wrap', gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>🛡️</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, fontFamily: 'monospace' }}>SUPERUSER CONTROL PANEL</div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>Umeingia kama {auth?.username}</div>
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={logout}>Toka</button>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '10px 14px', flexWrap: 'wrap', borderBottom: '1px solid #1e293b' }}>
        {[
          ['overview', '📊 Muhtasari'],
          ['flags', '🧩 Moduli'],
          ['browser', '🗄️ Data Browser'],
          ['backups', '💾 Backups'],
          ['legal', '📄 Legal & About'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="btn btn-sm"
            style={{
              background: tab === key ? '#f5a524' : '#162030',
              color: tab === key ? '#0a0f16' : '#e2e8f0',
              fontWeight: tab === key ? 700 : 500, border: 'none',
            }}
          >{label}</button>
        ))}
      </div>

      <div style={{ padding: 16, maxWidth: 1100, margin: '0 auto' }}>
        {tab === 'overview' && <OverviewPanel toast={toast} refreshSystemStatus={refreshSystemStatus} />}
        {tab === 'flags' && <FeatureFlagsPanel toast={toast} refreshSystemStatus={refreshSystemStatus} />}
        {tab === 'browser' && <DataBrowserPanel toast={toast} />}
        {tab === 'backups' && <BackupsPanel toast={toast} />}
        {tab === 'legal' && <LegalContentPanel toast={toast} />}
      </div>
    </div>
  )
}

// ── Overview + Maintenance Mode ─────────────────────────────────────────
function OverviewPanel({ toast, refreshSystemStatus }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    api.adminGetSystem().then(d => { setData(d); setMsg(d.maintenance_message || '') }).catch(e => toast(e.message, 'error')).finally(() => setLoading(false))
  }, [toast])
  useEffect(() => { load() }, [load])

  async function toggleMaintenance(next) {
    setSaving(true)
    try {
      await api.adminUpdateSystem({ maintenance_mode: next, maintenance_message: msg })
      toast(next ? 'Mfumo umezimwa kwa watumiaji wote (isipokuwa wewe)' : 'Mfumo umewashwa upya', next ? 'warning' : 'success')
      load(); refreshSystemStatus()
    } catch (e) { toast(e.message || 'Imeshindwa', 'error') }
    finally { setSaving(false) }
  }

  async function saveMessage() {
    setSaving(true)
    try {
      await api.adminUpdateSystem({ maintenance_message: msg })
      toast('Ujumbe umehifadhiwa', 'success')
      load()
    } catch (e) { toast(e.message || 'Imeshindwa', 'error') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="spinner" />
  const info = data?.system_info || {}

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{
        background: data?.maintenance_mode ? 'rgba(239,68,68,.1)' : '#0f1923',
        border: `1px solid ${data?.maintenance_mode ? '#ef4444' : '#1e293b'}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Hali ya Mfumo</div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              {data?.maintenance_mode ? '🔴 UMEZIMWA — owner na mkashia hawawezi kuingia' : '🟢 Mfumo unafanya kazi kawaida'}
            </div>
          </div>
          <button
            className="btn btn-sm"
            disabled={saving}
            style={{ background: data?.maintenance_mode ? '#22c55e' : '#ef4444', color: '#fff', fontWeight: 700, border: 'none' }}
            onClick={() => toggleMaintenance(!data?.maintenance_mode)}
          >{data?.maintenance_mode ? 'Washa Mfumo' : 'Zima Mfumo Kwa Wote'}</button>
        </div>
        <div className="input-group">
          <label className="input-label" style={{ color: '#94a3b8' }}>Ujumbe utakaoonekana kwa watumiaji</label>
          <textarea className="input" rows={2} value={msg} onChange={e => setMsg(e.target.value)}
            style={{ background: '#0a0f16', color: '#e2e8f0', border: '1px solid #1e293b' }} />
        </div>
        <button className="btn btn-secondary btn-sm" onClick={saveMessage} disabled={saving} style={{ marginTop: 8 }}>Hifadhi Ujumbe</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10 }}>
        {[
          ['Muda Umeendesha', fmtDuration(info.uptime_seconds)],
          ['Ukubwa wa Database', fmtBytes(info.db_size_bytes)],
          ['Watumiaji', info.counts?.users ?? '—'],
          ['Bidhaa', info.counts?.products ?? '—'],
          ['Mauzo', info.counts?.sales ?? '—'],
          ['Madeni', info.counts?.debts ?? '—'],
          ['Matumizi', info.counts?.expenses ?? '—'],
          ['SECRET_KEY Chanzo', info.secret_key_source === 'env' ? 'Environment Var' : 'Database (persistent)'],
        ].map(([label, value]) => (
          <div key={label} className="card" style={{ background: '#0f1923', border: '1px solid #1e293b', padding: 14 }}>
            <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, fontFamily: 'monospace' }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>DB path: {info.db_path}</div>
    </div>
  )
}

// ── Feature Flags (per-module kill switch) ──────────────────────────────
function FeatureFlagsPanel({ toast, refreshSystemStatus }) {
  const [flags, setFlags] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.adminGetSystem().then(d => setFlags(d.feature_flags || {})).catch(e => toast(e.message, 'error')).finally(() => setLoading(false))
  }, [toast])

  function toggle(key) {
    setFlags(f => ({ ...f, [key]: f[key] === false ? true : false }))
  }

  async function save() {
    setSaving(true)
    try {
      await api.adminUpdateSystem({ feature_flags: flags })
      toast('Moduli zimesasishwa', 'success')
      refreshSystemStatus()
    } catch (e) { toast(e.message || 'Imeshindwa', 'error') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="spinner" />

  return (
    <div className="card" style={{ background: '#0f1923', border: '1px solid #1e293b' }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Zima/Washa Moduli Site-Wide</div>
      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 14 }}>
        Ukizima moduli hapa, itatoweka kwa OWNER na MKASHIA wote wawili, papo hapo (baada ya refresh yao).
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 8 }}>
        {ALL_MODULES.map(m => {
          const isEnabled = flags[m.key] !== false
          return (
            <label key={m.key} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 12px', background: '#0a0f16', border: '1px solid #1e293b', borderRadius: 8,
              cursor: 'pointer',
            }}>
              <span style={{ fontSize: 13 }}>{m.label}</span>
              <input type="checkbox" checked={isEnabled} onChange={() => toggle(m.key)} style={{ width: 18, height: 18 }} />
            </label>
          )
        })}
      </div>
      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving} style={{ marginTop: 16 }}>
        {saving ? <span className="spinner" /> : 'Hifadhi Mabadiliko'}
      </button>
    </div>
  )
}

// ── Generic Data Browser (Django-admin style) ───────────────────────────
function DataBrowserPanel({ toast }) {
  const [tables, setTables] = useState([])
  const [table, setTable] = useState('')
  const [rows, setRows] = useState([])
  const [columns, setColumns] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [editRow, setEditRow] = useState(null) // {} for new, {...row} for edit
  const limit = 25

  useEffect(() => { api.adminListTables().then(setTables).catch(e => toast(e.message, 'error')) }, [toast])

  const loadRows = useCallback(() => {
    if (!table) return
    setLoading(true)
    api.adminGetRows(table, page, limit, q)
      .then(d => { setRows(d.rows); setColumns(d.columns); setTotal(d.total) })
      .catch(e => toast(e.message, 'error'))
      .finally(() => setLoading(false))
  }, [table, page, q, toast])
  useEffect(() => { loadRows() }, [loadRows])

  function pkOf() { return columns.find(c => c.pk)?.name || 'id' }

  async function deleteRow(row) {
    const pk = pkOf()
    if (!window.confirm(`Futa row hii (${pk}=${row[pk]}) kutoka "${table}"? Hatua hii haiwezi kurudishwa.`)) return
    try {
      await api.adminDeleteRow(table, row[pk])
      toast('Imefutwa', 'success')
      loadRows()
    } catch (e) { toast(e.message || 'Imeshindwa kufuta', 'error') }
  }

  async function saveRow(data, isNew) {
    try {
      if (isNew) await api.adminCreateRow(table, data)
      else await api.adminUpdateRow(table, data[pkOf()], data)
      toast(isNew ? 'Imeongezwa' : 'Imesasishwa', 'success')
      setEditRow(null)
      loadRows()
    } catch (e) { toast(e.message || 'Imeshindwa kuhifadhi', 'error') }
  }

  const displayCols = columns.filter(c => !(table === 'users' && c.name === 'password_hash')).slice(0, 7)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="input input-sm" style={{ maxWidth: 220, background: '#0f1923', color: '#e2e8f0', border: '1px solid #1e293b' }}
          value={table} onChange={e => { setTable(e.target.value); setPage(1); setQ('') }}>
          <option value="">— Chagua Table —</option>
          {tables.map(t => <option key={t.name} value={t.name}>{t.name} ({t.row_count ?? '?'})</option>)}
        </select>
        {table && (
          <>
            <input className="input input-sm" placeholder="Tafuta..." value={q}
              onChange={e => { setQ(e.target.value); setPage(1) }}
              style={{ maxWidth: 200, background: '#0f1923', color: '#e2e8f0', border: '1px solid #1e293b' }} />
            <button className="btn btn-primary btn-sm" onClick={() => setEditRow({})}>+ Ongeza Row</button>
          </>
        )}
      </div>

      {loading && <div className="spinner" />}

      {!loading && table && (
        <div style={{ overflowX: 'auto', border: '1px solid #1e293b', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#0f1923' }}>
                {displayCols.map(c => (
                  <th key={c.name} style={{ padding: '8px 10px', textAlign: 'left', color: '#94a3b8', borderBottom: '1px solid #1e293b' }}>{c.name}</th>
                ))}
                <th style={{ padding: '8px 10px' }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #16202f' }}>
                  {displayCols.map(c => (
                    <td key={c.name} style={{ padding: '8px 10px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {String(r[c.name] ?? '—')}
                    </td>
                  ))}
                  <td style={{ padding: '8px 10px', display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setEditRow(r)}>Hariri</button>
                    <button className="btn btn-sm" style={{ fontSize: 11, padding: '4px 8px', background: '#ef4444', color: '#fff', border: 'none' }} onClick={() => deleteRow(r)}>Futa</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={displayCols.length + 1} style={{ padding: 16, textAlign: 'center', color: '#64748b' }}>Hakuna data</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && table && total > limit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
          <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Nyuma</button>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>Ukurasa {page} / {Math.ceil(total / limit)}</span>
          <button className="btn btn-secondary btn-sm" disabled={page >= Math.ceil(total / limit)} onClick={() => setPage(p => p + 1)}>Mbele →</button>
        </div>
      )}

      {editRow !== null && (
        <RowEditModal
          table={table} columns={columns} row={editRow}
          onClose={() => setEditRow(null)}
          onSave={(data) => saveRow(data, Object.keys(editRow).length === 0)}
        />
      )}
    </div>
  )
}

function RowEditModal({ table, columns, row, onClose, onSave }) {
  const isNew = Object.keys(row).length === 0
  const pk = columns.find(c => c.pk)?.name || 'id'
  const [form, setForm] = useState(() => {
    const initial = {}
    columns.forEach(c => {
      if (c.name === 'password_hash') return
      initial[c.name] = row[c.name] ?? ''
    })
    if (table === 'users') initial.password = ''
    return initial
  })

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function handleSave() {
    const data = { ...form }
    if (isNew) delete data[pk]
    if (table === 'users' && !data.password) delete data.password
    onSave(data)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16,
    }} onClick={onClose}>
      <div className="card" style={{
        background: '#0f1923', border: '1px solid #1e293b', maxWidth: 480, width: '100%',
        maxHeight: '85vh', overflowY: 'auto',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>
          {isNew ? `Ongeza Row Mpya — ${table}` : `Hariri — ${table} #${row[pk]}`}
        </div>
        {columns.filter(c => c.name !== 'password_hash').map(c => (
          <div className="input-group" key={c.name} style={{ marginBottom: 10 }}>
            <label className="input-label" style={{ color: '#94a3b8' }}>
              {c.name}{c.pk ? ' (PK)' : ''}{c.notnull ? ' *' : ''}
            </label>
            {(c.type || '').toUpperCase().includes('TEXT') && String(form[c.name] || '').length > 60 ? (
              <textarea className="input" rows={3} value={form[c.name]} disabled={c.pk}
                onChange={e => set(c.name, e.target.value)}
                style={{ background: '#0a0f16', color: '#e2e8f0', border: '1px solid #1e293b' }} />
            ) : (
              <input className="input" value={form[c.name]} disabled={c.pk && !isNew}
                onChange={e => set(c.name, e.target.value)}
                style={{ background: '#0a0f16', color: '#e2e8f0', border: '1px solid #1e293b' }} />
            )}
          </div>
        ))}
        {table === 'users' && (
          <div className="input-group" style={{ marginBottom: 10 }}>
            <label className="input-label" style={{ color: '#94a3b8' }}>Nywila Mpya (acha wazi kutobadilisha)</label>
            <input className="input" type="password" value={form.password} onChange={e => set('password', e.target.value)}
              style={{ background: '#0a0f16', color: '#e2e8f0', border: '1px solid #1e293b' }} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={handleSave}>Hifadhi</button>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Ghairi</button>
        </div>
      </div>
    </div>
  )
}

// ── Legal & About content (Privacy, Terms, About Me + photo) ────────────
function LegalContentPanel({ toast }) {
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.adminGetLegalContent().then(setForm).catch(e => toast(e.message, 'error')).finally(() => setLoading(false))
  }, [toast])

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function onPhotoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 6 * 1024 * 1024) { toast('Picha ni kubwa mno (max 6MB)', 'error'); return }
    const reader = new FileReader()
    reader.onload = (ev) => set('about_photo', ev.target.result)
    reader.readAsDataURL(file)
  }

  async function save() {
    setSaving(true)
    try {
      await api.adminUpdateLegalContent(form)
      toast('Content imehifadhiwa', 'success')
    } catch (e) { toast(e.message || 'Imeshindwa kuhifadhi', 'error') }
    finally { setSaving(false) }
  }

  if (loading || !form) return <div className="spinner" />

  const inputStyle = { background: '#0a0f16', color: '#e2e8f0', border: '1px solid #1e293b' }
  const labelStyle = { color: '#94a3b8' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 12, color: '#94a3b8' }}>
        Content hizi zinaonekana kwa umma kupitia <span style={{ fontFamily: 'monospace' }}>/?page=privacy</span>,{' '}
        <span style={{ fontFamily: 'monospace' }}>/?page=terms</span>, na <span style={{ fontFamily: 'monospace' }}>/?page=about</span> —
        zinapatikana hata bila kuingia (login), pamoja na kwenye ukurasa wa Login.
      </div>

      <div className="card" style={{ background: '#0f1923', border: '1px solid #1e293b' }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>🔒 Sera ya Faragha (Privacy Policy)</div>
        <div className="input-group" style={{ marginBottom: 10 }}>
          <label className="input-label" style={labelStyle}>Kichwa</label>
          <input className="input" style={inputStyle} value={form.privacy_title} onChange={e => set('privacy_title', e.target.value)} />
        </div>
        <div className="input-group">
          <label className="input-label" style={labelStyle}>Maudhui</label>
          <textarea className="input" style={inputStyle} rows={8} value={form.privacy_body} onChange={e => set('privacy_body', e.target.value)} />
        </div>
      </div>

      <div className="card" style={{ background: '#0f1923', border: '1px solid #1e293b' }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>📜 Vigezo na Masharti (Terms)</div>
        <div className="input-group" style={{ marginBottom: 10 }}>
          <label className="input-label" style={labelStyle}>Kichwa</label>
          <input className="input" style={inputStyle} value={form.terms_title} onChange={e => set('terms_title', e.target.value)} />
        </div>
        <div className="input-group">
          <label className="input-label" style={labelStyle}>Maudhui</label>
          <textarea className="input" style={inputStyle} rows={8} value={form.terms_body} onChange={e => set('terms_body', e.target.value)} />
        </div>
      </div>

      <div className="card" style={{ background: '#0f1923', border: '1px solid #1e293b' }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>🧑‍💻 Kuhusu (About Me)</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <div style={{
            width: 84, height: 84, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
            background: '#0a0f16', border: '1px solid #1e293b', display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontSize: 30,
          }}>
            {form.about_photo ? (
              <img src={form.about_photo} alt="Kuhusu" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : '🧑‍💻'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', display: 'inline-block' }}>
              📷 {form.about_photo ? 'Badilisha Picha' : 'Pakia Picha'}
              <input type="file" accept="image/*" onChange={onPhotoChange} style={{ display: 'none' }} />
            </label>
            {form.about_photo && (
              <button className="btn btn-sm" style={{ background: '#ef4444', color: '#fff', border: 'none' }} onClick={() => set('about_photo', '')}>Ondoa Picha</button>
            )}
          </div>
        </div>
        <div className="input-group" style={{ marginBottom: 10 }}>
          <label className="input-label" style={labelStyle}>Jina</label>
          <input className="input" style={inputStyle} value={form.about_name} onChange={e => set('about_name', e.target.value)} placeholder="Mfano: Yuen" />
        </div>
        <div className="input-group" style={{ marginBottom: 10 }}>
          <label className="input-label" style={labelStyle}>Cheo / Title</label>
          <input className="input" style={inputStyle} value={form.about_title} onChange={e => set('about_title', e.target.value)} placeholder="Mfano: Muundaji wa MotoShop" />
        </div>
        <div className="input-group">
          <label className="input-label" style={labelStyle}>Maelezo (Bio)</label>
          <textarea className="input" style={inputStyle} rows={6} value={form.about_bio} onChange={e => set('about_bio', e.target.value)} />
        </div>
      </div>

      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving} style={{ alignSelf: 'flex-start' }}>
        {saving ? <span className="spinner" /> : 'Hifadhi Yote'}
      </button>
    </div>
  )
}
// ── Backups ──────────────────────────────────────────────────────────────
function BackupsPanel({ toast }) {
  const [backups, setBackups] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [restoring, setRestoring] = useState(null) // filename currently being restored, or null
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef(null)

  const load = useCallback(() => {
    setLoading(true)
    api.adminListBackups().then(setBackups).catch(e => toast(e.message, 'error')).finally(() => setLoading(false))
  }, [toast])
  useEffect(() => { load() }, [load])

  async function createBackup() {
    setCreating(true)
    try {
      await api.adminCreateBackup()
      toast('Backup mpya imetengenezwa', 'success')
      load()
    } catch (e) { toast(e.message || 'Imeshindwa', 'error') }
    finally { setCreating(false) }
  }

  async function deleteBackup(filename) {
    if (!window.confirm(`Futa backup "${filename}"? Haiwezi kurudishwa.`)) return
    try {
      await api.adminDeleteBackup(filename)
      toast('Imefutwa', 'success')
      load()
    } catch (e) { toast(e.message || 'Imeshindwa', 'error') }
  }

  async function restoreBackup(filename) {
    if (!window.confirm(
      `Rudisha database kutoka "${filename}"?\n\nHatua hii itabadilisha data yote ya sasa na data ya backup hii. ` +
      `Nakala ya usalama ya data ya sasa itahifadhiwa kiotomatiki kabla ya kurudisha.`
    )) return
    setRestoring(filename)
    try {
      const res = await api.adminRestoreBackup(filename)
      toast('Database imerudishwa kikamilifu', 'success')
      if (res && res.safety_backup) {
        toast(`Nakala ya usalama imetengenezwa: ${res.safety_backup}`, 'success')
      }
      load()
    } catch (e) { toast(e.message || 'Imeshindwa kurudisha', 'error') }
    finally { setRestoring(null) }
  }

  async function handleUploadFile(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.db')) {
      toast('Chagua faili la .db pekee', 'error')
      return
    }
    setUploading(true)
    try {
      await api.adminUploadBackup(file)
      toast('Backup imepandishwa. Sasa bonyeza Rudisha kwenye orodha.', 'success')
      load()
    } catch (e2) { toast(e2.message || 'Imeshindwa kupandisha', 'error') }
    finally { setUploading(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ background: '#0f1923', border: '1px solid #1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontWeight: 700 }}>Backups za Database</div>
          <div style={{ fontSize: 12, color: '#94a3b8' }}>Snapshot kamili ya database, imehifadhiwa kwenye persistent disk.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input ref={fileInputRef} type="file" accept=".db" style={{ display: 'none' }} onChange={handleUploadFile} />
          <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current && fileInputRef.current.click()} disabled={uploading}>
            {uploading ? <span className="spinner" /> : '⬆️ Pandisha Backup'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={createBackup} disabled={creating}>
            {creating ? <span className="spinner" /> : '+ Tengeneza Backup Sasa'}
          </button>
        </div>
      </div>

      {loading ? <div className="spinner" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {backups.length === 0 && <div style={{ color: '#64748b', fontSize: 13, textAlign: 'center', padding: 20 }}>Hakuna backup bado.</div>}
          {backups.map(b => (
            <div key={b.filename} className="card" style={{
              background: '#0f1923', border: '1px solid #1e293b', display: 'flex',
              justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
            }}>
              <div>
                <div style={{ fontFamily: 'monospace', fontSize: 13 }}>{b.filename}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{fmtBytes(b.size_bytes)} • {formatDateTime(b.created_at)}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="btn btn-sm"
                  style={{ background: '#16a34a', color: '#fff', border: 'none', minWidth: 90 }}
                  onClick={() => restoreBackup(b.filename)}
                  disabled={!!restoring}
                >
                  {restoring === b.filename ? <span className="spinner" /> : '♻️ Rudisha'}
                </button>
                <button className="btn btn-secondary btn-sm" disabled={!!restoring} onClick={() => api.adminDownloadBackup(b.filename).catch(e => toast(e.message, 'error'))}>⬇️ Pakua</button>
                <button className="btn btn-sm" style={{ background: '#ef4444', color: '#fff', border: 'none' }} disabled={!!restoring} onClick={() => deleteBackup(b.filename)}>Futa</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
