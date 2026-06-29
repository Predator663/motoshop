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

export default function Shell() {
  const { auth, activeTab, setActiveTab, sseConnected, logout, settings, isOnline, pendingSyncCount } = useApp()
  const T = useT()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const OWNER_TABS = ['dashboard','pos','sales','debts','products','stock','expenses','reports','shifts','settings','profile']
  const CASHIER_TABS = ['dashboard','pos','sales','stock','shifts','profile']

  useEffect(() => {
    const allowed = auth?.role === 'owner' ? OWNER_TABS : CASHIER_TABS
    if (!allowed.includes(activeTab)) setActiveTab('dashboard')
  }, [auth])

  const pages = {
    dashboard: <Dashboard />, pos: <POSPage />, sales: <SalesHistory />,
    debts: auth?.role === 'owner' ? <DebtsPage /> : null,
    products: <ProductsPage />, stock: <StockPage />,
    expenses: auth?.role === 'owner' ? <ExpensesPage /> : null,
    reports: auth?.role === 'owner' ? <ReportsPage /> : null,
    shifts: <ShiftsPage />,
    settings: auth?.role === 'owner' ? <SettingsPage /> : null,
    profile: <ProfilePage />,
  }

  const headerTitle = settings.header_title || settings.shop_name || 'MotoShop'
  const headerSubtitle = settings.header_subtitle || T('topbar_subtitle')
  const headerIcon = settings.header_icon || '🏍️'
  const logoImage = settings.logo_image || ''

  const mobileItems = auth?.role === 'owner'
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
      ]

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
            <span style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--text3)'}}>
              <span className={`sse-dot ${sseConnected ? '' : 'offline'}`} />
              {sseConnected ? T('live') : '—'}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={logout} style={{fontSize:12}}>{T('logout')}</button>
          </div>
        </div>

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
