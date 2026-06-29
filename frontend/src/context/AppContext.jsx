// src/context/AppContext.jsx
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { api, syncOfflineQueue, getOfflineQueue } from '../utils/api'

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [auth, setAuth] = useState(() => {
    const token = localStorage.getItem('motoshop_token')
    const role  = localStorage.getItem('motoshop_role')
    const username = localStorage.getItem('motoshop_username')
    const user_id  = localStorage.getItem('motoshop_user_id')
    return token ? { token, role, username, user_id } : null
  })
  const [toasts, setToasts] = useState([])
  const [sseConnected, setSseConnected] = useState(false)
  const [activeTab, setActiveTab] = useState('dashboard')
  const [settings, setSettings] = useState({})
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [pendingSyncCount, setPendingSyncCount] = useState(0)
  const sseRef = useRef(null)
  const sseCallbacks = useRef([])

  // ── Online / offline ──────────────────────────────────────────────────
  useEffect(() => {
    const trySync = async () => {
      const q = getOfflineQueue()
      if (q.length === 0) return
      setPendingSyncCount(q.length)
      await syncOfflineQueue((msg, type) => toast(msg, type))
      setPendingSyncCount(getOfflineQueue().length)
    }
    const goOnline = async () => { setIsOnline(true); await trySync() }
    const goOffline = () => setIsOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)

    // FIX (offline support): previously sync only ran on the 'online'
    // event — i.e. the transition from offline to online. If the app was
    // simply launched/refreshed while already online with leftover queued
    // items from a previous session, nothing ever triggered a sync until
    // the connection dropped and came back again. Try once immediately.
    if (navigator.onLine) trySync()

    // FIX (offline support): the browser's 'online' event fires based on
    // network interface state, not actual server reachability — on a weak
    // or captive-portal connection it can fire while the API is still
    // unreachable. Without a periodic retry, queued items could get stuck
    // forever waiting for an 'online' event that already happened. This
    // is a cheap no-op when the queue is empty or we're truly offline.
    const interval = setInterval(() => { if (navigator.onLine) trySync() }, 20000)

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      clearInterval(interval)
    }
  }, [])

  useEffect(() => { setPendingSyncCount(getOfflineQueue().length) }, [])

  // ── Toast ─────────────────────────────────────────────────────────────
  const toast = useCallback((msg, type = 'info', duration = 3500) => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, msg, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), duration)
  }, [])
  const removeToast = useCallback((id) => setToasts(t => t.filter(x => x.id !== id)), [])

  // ── SSE registration ──────────────────────────────────────────────────
  const onSSE = useCallback((cb) => {
    sseCallbacks.current.push(cb)
    return () => { sseCallbacks.current = sseCallbacks.current.filter(x => x !== cb) }
  }, [])

  // ── SSE connection ────────────────────────────────────────────────────
  useEffect(() => {
    if (!auth) { sseRef.current?.close(); return }
    let es, retryTimer
    const connect = () => {
      const token = localStorage.getItem('motoshop_token')
      es = new EventSource(`/api/events?token=${encodeURIComponent(token)}&_t=${Date.now()}`)
      es.onopen = () => setSseConnected(true)
      es.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data)
          sseCallbacks.current.forEach(cb => cb(evt))
          // Notify owner when a cashier sold items below buying price
          const storedRole = localStorage.getItem('motoshop_role')
          if (storedRole === 'owner' && evt.type === 'sale_created' && evt.data?.below_price_items?.length > 0) {
            const names = evt.data.below_price_items.map(i => i.name).join(', ')
            toast(`⚠️ Imeuuzwa chini ya bei ya kununulia: ${names} (risiti: ${evt.data.receipt_no})`, 'warning', 8000)
          }
        } catch {}
      }
      es.onerror = () => {
        setSseConnected(false); es.close()
        retryTimer = setTimeout(connect, 5000)
      }
      sseRef.current = es
    }
    connect()
    return () => { es?.close(); clearTimeout(retryTimer) }
  }, [auth])

  // ── Load settings on login ────────────────────────────────────────────
  useEffect(() => {
    if (auth) { api.getSettings().then(setSettings).catch(() => {}) }
    else { setSettings({}) }
  }, [auth])

  // ── Auth ──────────────────────────────────────────────────────────────
  const login = useCallback(async (username, password) => {
    const data = await api.login(username, password)
    localStorage.setItem('motoshop_token', data.token)
    localStorage.setItem('motoshop_role', data.role)
    localStorage.setItem('motoshop_username', data.username)
    localStorage.setItem('motoshop_user_id', data.user_id)
    setAuth({ token: data.token, role: data.role, username: data.username, user_id: data.user_id })
    setActiveTab('dashboard')
    return data
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('motoshop_token')
    localStorage.removeItem('motoshop_role')
    localStorage.removeItem('motoshop_username')
    localStorage.removeItem('motoshop_user_id')
    sseRef.current?.close()
    setAuth(null)
    setActiveTab('dashboard')
  }, [])

  // ── Derived values ────────────────────────────────────────────────────
  // lang is LIVE — reads directly from settings object which is always fresh
  const currency = settings.currency || 'Tsh'
  const lang = settings.language || 'sw'

  return (
    <AppContext.Provider value={{
      auth, login, logout,
      toasts, toast, removeToast,
      sseConnected, onSSE,
      activeTab, setActiveTab,
      settings, setSettings,
      currency, lang,
      isOnline, pendingSyncCount, setPendingSyncCount,
    }}>
      {children}
    </AppContext.Provider>
  )
}

export const useApp = () => useContext(AppContext)
