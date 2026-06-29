// src/App.jsx
import React, { useState, useEffect } from 'react'
import { AppProvider, useApp } from './context/AppContext'
import { api } from './utils/api'
import SetupPage from './pages/SetupPage'
import LoginPage from './pages/LoginPage'
import Shell from './components/Shell'
import ToastContainer from './components/ToastContainer'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('MotoShop crash:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f1923', padding: 20, flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 48 }}>💥</div>
          <h2 style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: 18 }}>Application Error</h2>
          <pre style={{ color: '#f5a623', background: '#162030', padding: 16, borderRadius: 8, fontSize: 12, maxWidth: 600, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button onClick={() => this.setState({ error: null })} style={{ background: '#e8500a', color: '#fff', border: 'none', padding: '10px 24px', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
            Try Again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function AppInner() {
  const { auth } = useApp()
  const [setupDone, setSetupDone] = useState(null)

  useEffect(() => {
    // FIX (offline support): previously, if setupStatus() failed for any
    // reason — including simply being offline — the page fell back to the
    // setup wizard, even for a shop that finished setup long ago. That
    // wrongly bounced an offline cashier/owner into "create your shop"
    // instead of the dashboard. Trust what we already know locally first.
    const cachedSetup = localStorage.getItem('motoshop_setup_done')
    const hasToken = !!localStorage.getItem('motoshop_token')
    if (cachedSetup === '1' || hasToken) setSetupDone(true)
    else if (cachedSetup === '0') setSetupDone(false)

    api.setupStatus()
      .then(d => {
        setSetupDone(d.setup_done)
        localStorage.setItem('motoshop_setup_done', d.setup_done ? '1' : '0')
      })
      .catch(() => {
        // Only fall back to "needs setup" if we truly have no prior
        // history at all (first-ever load, never online before).
        if (cachedSetup === null && !hasToken) setSetupDone(false)
      })
  }, [])

  if (setupDone === null) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', flexDirection:'column', gap:16 }}>
        <div className="spinner" style={{ width:44, height:44, borderWidth:4 }} />
        <p style={{ color:'var(--text3)', fontFamily:'var(--font-head)', fontSize:15 }}>Inaanza MotoShop…</p>
      </div>
    )
  }

  if (!setupDone) return <SetupPage onDone={() => setSetupDone(true)} />
  if (!auth) return <LoginPage />
  return <Shell />
}

export default function App() {
  return (
    <ErrorBoundary>
    <AppProvider>
      <AppInner />
      <ToastWrapper />
    </AppProvider>
    </ErrorBoundary>
  )
}

function ToastWrapper() {
  const { toasts, removeToast } = useApp()
  return <ToastContainer toasts={toasts} onRemove={removeToast} />
}
