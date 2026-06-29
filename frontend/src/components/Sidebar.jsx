import { useApp } from '../context/AppContext'
import { useT } from '../hooks/useT'

export default function Sidebar({ isOpen, onClose, activeTab, onNav }) {
  const { auth, settings } = useApp()
  const T = useT()
  const isOwner = auth?.role === 'owner'

  const ownerNav = [
    { key:'dashboard', icon:'📊', label: T('nav_dashboard') },
    { section: T('nav_section_sales') },
    { key:'pos',      icon:'🛒', label: T('nav_pos') },
    { key:'sales',    icon:'🧾', label: T('nav_sales') },
    { key:'debts',    icon:'💳', label: T('nav_debts') },
    { section: T('nav_section_products') },
    { key:'products', icon:'📦', label: T('nav_products') },
    { key:'stock',    icon:'📊', label: T('nav_stock') },
    { section: T('nav_section_finance') },
    { key:'expenses', icon:'💸', label: T('nav_expenses') },
    { key:'reports',  icon:'📈', label: T('nav_reports') },
    { key:'shifts',   icon:'⏱️', label: T('nav_shifts') },
    { section: T('nav_section_system') },
    { key:'settings', icon:'⚙️', label: T('nav_settings') },
    { key:'profile',  icon:'👤', label: T('nav_profile') },
  ]

  const cashierNav = [
    { key:'dashboard', icon:'📊', label: T('nav_dashboard') },
    { section: T('nav_section_sales') },
    { key:'pos',      icon:'🛒', label: T('nav_pos') },
    { key:'sales',    icon:'🧾', label: T('nav_my_sales') },
    { key:'shifts',   icon:'⏱️', label: T('nav_my_shifts') },
    { section: T('nav_section_products') },
    { key:'products', icon:'📦', label: T('nav_products') },
    { key:'stock',    icon:'📊', label: T('nav_stock') },
    { section: T('nav_section_account') },
    { key:'profile',  icon:'👤', label: T('nav_profile') },
  ]

  const nav = isOwner ? ownerNav : cashierNav
  const shopName = settings.header_title || settings.shop_name || 'MotoShop'
  const shopIcon = settings.header_icon || '🏍️'

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-brand">
        <div className="brand-logo">
          <div className="brand-icon">{shopIcon}</div>
          <div>
            <div className="brand-name">{shopName}</div>
            <div className="brand-sub">{T('topbar_subtitle')}</div>
          </div>
        </div>
      </div>
      <nav className="sidebar-nav">
        {nav.map((item, i) =>
          item.section
            ? <div key={i} className="nav-section-label">{item.section}</div>
            : (
              <div key={item.key} className={`nav-item ${activeTab === item.key ? 'active' : ''}`} onClick={() => onNav(item.key)}>
                <span className="nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </div>
            )
        )}
      </nav>
      <div className="sidebar-user">
        <div className="user-chip">
          <div className="user-avatar">{(auth?.username || 'U')[0].toUpperCase()}</div>
          <div className="user-info">
            <div className="user-name">{auth?.username}</div>
            <div className="user-role">{isOwner ? T('profile_role_owner') : T('profile_role_cashier')}</div>
          </div>
        </div>
      </div>
    </aside>
  )
}
