import { useApp } from '../context/AppContext'

export default function MaintenanceScreen({ message }) {
  const { refreshSystemStatus } = useApp()
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', background: 'var(--bg)',
      padding: 24, textAlign: 'center', gap: 16,
    }}>
      <div style={{ fontSize: 56 }}>🛠️</div>
      <h1 style={{ fontFamily: 'var(--font-head)', fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>
        Mfumo Uko Chini kwa Muda
      </h1>
      <p style={{ color: 'var(--text3)', fontSize: 14, maxWidth: 420, lineHeight: 1.6 }}>
        {message || 'Tunaboresha mfumo kwa sasa. Tafadhali jaribu tena baadaye.'}
      </p>
      <button className="btn btn-secondary btn-sm" onClick={refreshSystemStatus} style={{ marginTop: 8 }}>
        🔄 Jaribu Tena
      </button>
    </div>
  )
}
