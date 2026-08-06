import { useState, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'
import Sidebar from './Sidebar'
import Dashboard from '../pages/Dashboard'
import POSPage from '../pages/POSPage'
import SalesHistory from '../pages/SalesHistory'
import DebtsPage from '../pages/DebtsPage'
import ProductsPage from '../pages/ProductsPage'
import ExpensesPage from '../pages/ExpensesPage'
import ReportsPage from '../pages/ReportsPage'
import ShiftsPage from '../pages/ShiftsPage'
import SettingsPage from '../pages/SettingsPage'
import ProfilePage from '../pages/ProfilePage'
import StockPage from '../pages/StockPage'
import TrashPage from '../pages/TrashPage'

export default function Shell() {
  const { auth, activeTab, setActiveTab, sseConnected, logout, settings, isOnline, pendingSyncCount, theme, toggleTheme,
          canInstall, installed, promptInstall, updateAvailable, applyUpdate, systemStatus } = useApp()
  const T = useT()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // FIX (superuser control): a module can be switched off site-wide from
  // the Superuser panel (feature_flags). Absent/true = enabled; explicit
  // false = hidden from everyone, owner included.
  const featureFlags = systemStatus?.feature_flags || {}
  const enabled = (tab) => featureFlags[tab] !== false
  const OWNER_TABS = ['dashboard','pos','sales','debts','products','stock','expenses','reports','shifts','settings','trash','profile'].filter(enabled)
  const CASHIER_TABS = ['dashboard','pos','sales','stock','shifts','profile'].filter(enabled)

  useEffect(() => {
    const allowed = auth?.role === 'owner' ? OWNER_TABS : CASHIER_TABS
    if (!allowed.includes(activeTab)) setActiveTab('dashboard')
  }, [auth, systemStatus])

  const pages = {
    dashboard: <Dashboard />, pos: <POSPage />, sales: <SalesHistory />,
    debts: auth?.role === 'owner' ? <DebtsPage /> : null,
    products: <ProductsPage />, stock: <StockPage />,
    expenses: auth?.role === 'owner' ? <ExpensesPage /> : null,
    reports: auth?.role === 'owner' ? <ReportsPage /> : null,
    shifts: <ShiftsPage />,
    settings: auth?.role === 'owner' ? <SettingsPage /> : null,
    trash: auth?.role === 'owner' ? <TrashPage /> : null,
    profile: <ProfilePage />,
  }

  const headerTitle = settings.header_title || settings.shop_name || 'MotoShop'
  const headerSubtitle = settings.header_subtitle || T('topbar_subtitle')
  const headerIcon = settings.header_icon || '🏍️'
  const logoImage = settings.logo_image || ''
  // FIX (cashier control): a message the owner pins from Settings — stays
  // visible to the cashier on every page until the owner removes it there.
  // Not shown to the owner themselves (it's addressed to the cashier).
  const pinnedMessage = auth?.role === 'cashier' ? (settings.cashier_pinned_message || '').trim() : ''

  const mobileItems = (auth?.role === 'owner'
    ? [
        { key:'dashboard', icon:'📊', label: T('nav_dashboard') },
        { key:'pos',       icon:'🛒', label: T('nav_pos') },
        { key:'sales',     icon:'🧾', label: T('nav_sales') },
        { key:'stock',     icon:'📦', label: T('nav_stock') },
        { key:'reports',   icon:'📈', label: T('nav_reports') },
      ]
    : [
        { key:'dashboard', icon:'📊', label: T('nav_dashboard') },
        { key:'pos',       icon:'🛒', label: T('nav_pos') },
        { key:'sales',     icon:'🧾', label: T('nav_my_sales') },
        { key:'stock',     icon:'📦', label: T('nav_stock') },
        { key:'profile',   icon:'👤', label: T('nav_profile') },
      ]).filter(item => enabled(item.key))

  return (
    <div className="app-shell">
      <div className={`sidebar-overlay ${sidebarOpen ? 'show' : ''}`} onClick={() => setSidebarOpen(false)} />
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} activeTab={activeTab} onNav={(tab) => { setActiveTab(tab); setSidebarOpen(false) }} />

      <div className="main-area">
        <div className="topbar">
          <button className="btn btn-ghost btn-icon" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu" style={{marginRight:4}}>☰</button>
          <div className="topbar-brand">
            {logoImage ? (
              <img src={logoImage} alt="logo" style={{height:32,width:32,objectFit:'contain',borderRadius:6,flexShrink:0}} />
            ) : (
              <span className="topbar-icon">{headerIcon}</span>
            )}
            <div className="topbar-titles">
              <span className="topbar-title">{headerTitle}</span>
              {headerSubtitle && <span className="topbar-subtitle">{headerSubtitle}</span>}
            </div>
          </div>
          <div className="topbar-right">
            <div className={`online-badge ${isOnline ? 'online' : 'offline'}`}>
              <span className="online-dot" />
              <span className="online-label">{isOnline ? T('online') : T('offline')}</span>
              {pendingSyncCount > 0 && <span className="sync-badge">{pendingSyncCount}</span>}
            </div>
            <span className="sse-indicator" style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--text3)'}}>
              <span className={`sse-dot ${sseConnected ? '' : 'offline'}`} />
              <span className="sse-label">{sseConnected ? T('live') : '—'}</span>
            </span>
            {canInstall && !installed && (
              <button
                className="btn btn-secondary btn-sm btn-install"
                onClick={promptInstall}
                title="Sakinisha app hii kwenye kifaa chako"
                style={{fontSize:12,display:'flex',alignItems:'center',gap:4}}
              >
                <span>📲</span><span className="btn-compact-label">Sakinisha</span>
              </button>
            )}
            <button
              className="btn btn-ghost btn-icon"
              onClick={toggleTheme}
              aria-label={theme === 'light' ? T('theme_switch_dark') : T('theme_switch_light')}
              title={theme === 'light' ? T('theme_switch_dark') : T('theme_switch_light')}
              style={{fontSize:16}}
            >
              {theme === 'light' ? '🌙' : '☀️'}
            </button>
            <button className="btn btn-ghost btn-sm btn-logout" onClick={logout} aria-label={T('logout')} title={T('logout')} style={{fontSize:12}}>
              <span className="btn-logout-icon">🚪</span>
              <span className="btn-logout-label">{T('logout')}</span>
            </button>
          </div>
        </div>

        {updateAvailable && (
          <div style={{
            background:'#2563eb', color:'#fff', padding:'10px 16px',
            display:'flex', alignItems:'center', gap:10, fontSize:13, fontWeight:600,
            borderBottom:'1px solid rgba(0,0,0,.15)', flexWrap:'wrap'
          }}>
            <span style={{fontSize:15,lineHeight:1}}>⬆️</span>
            <span style={{flex:1}}>Toleo jipya la app limepatikana.</span>
            <button
              className="btn btn-sm"
              style={{background:'#fff',color:'#2563eb',fontWeight:700,border:'none'}}
              onClick={applyUpdate}
            >Sasisha Sasa</button>
          </div>
        )}

        {pinnedMessage && (
          <div style={{
            background:'var(--amber2, #f5a524)', color:'#1a1300', padding:'10px 16px',
            display:'flex', alignItems:'flex-start', gap:8, fontSize:13, fontWeight:600,
            borderBottom:'1px solid rgba(0,0,0,.15)'
          }}>
            <span style={{fontSize:15,lineHeight:1}}>📌</span>
            <span style={{whiteSpace:'pre-wrap',flex:1}}>{pinnedMessage}</span>
          </div>
        )}

        <div className="scroll-page" key={activeTab}>
          {pages[activeTab] || <Dashboard />}
        </div>

        <footer className="app-footer">
          <span>{headerTitle} &copy; {new Date().getFullYear()}</span>
          <span className="footer-sep">·</span>
          <span>{T('footer_system')}</span>
          <span className="footer-sep">·</span>
          <span style={{color: isOnline ? 'var(--green)' : 'var(--red)'}}>
            {isOnline ? `🟢 ${T('online')}` : `🔴 ${T('offline')}`}
          </span>
        </footer>
      </div>

      <div className="mobile-nav">
        <div className="mobile-nav-items">
          {mobileItems.map(it => (
            <div key={it.key} className={`mobile-nav-item ${activeTab === it.key ? 'active' : ''}`} onClick={() => setActiveTab(it.key)}>
              <span className="nav-icon">{it.icon}</span>
              {it.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
