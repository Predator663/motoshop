// src/components/ToastContainer.jsx
const ICONS = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' }

export default function ToastContainer({ toasts, onRemove }) {
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`toast toast-${t.type}`}
          onClick={() => onRemove(t.id)}
        >
          <span className="toast-icon">{ICONS[t.type] || 'ℹ️'}</span>
          <span style={{flex:1}}>{t.msg}</span>
          <span style={{cursor:'pointer',color:'var(--text3)',fontSize:16}}>×</span>
        </div>
      ))}
    </div>
  )
}
