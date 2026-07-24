// src/context/AppContext.jsx
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { api, syncOfflineQueue, getOfflineQueue } from '../utils/api'
import { setTimezone, DEFAULT_TIMEZONE } from '../utils/datetime'

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
  const [activeTab, setActiveTab] = useState(() => {
    // Supports the manifest "shortcuts" (long-press the installed icon ->
    // "Mauzo Mapya" / "Dashibodi") which launch with e.g. /?tab=pos.
    const t = new URLSearchParams(window.location.search).get('tab')
    return t || 'dashboard'
  })
  const [settings, setSettings] = useState({})
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [pendingSyncCount, setPendingSyncCount] = useState(0)
  // ── Theme (device/browser preference, not synced to backend shop settings) ──
  const [theme, setThemeState] = useState(() => {
    const saved = localStorage.getItem('motoshop_theme')
    if (saved === 'light' || saved === 'dark') return saved
    // No saved preference yet — respect the OS/browser preference if available.
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light'
    return 'dark'
  })
  const sseRef = useRef(null)
  const sseCallbacks = useRef([])

  // ── System status (maintenance mode) — checked before login too ────────
  const [systemStatus, setSystemStatus] = useState(null)
  const refreshSystemStatus = useCallback(() => {
    api.getSystemStatus().then(setSystemStatus).catch(() => setSystemStatus({ maintenance: false }))
  }, [])
  useEffect(() => { refreshSystemStatus() }, [refreshSystemStatus])

  // ── PWA: custom install prompt ──────────────────────────────────────
  // Chrome/Edge suppress their own install UI unless the manifest+SW meet
  // certain criteria, and even then the address-bar icon is easy to miss.
  // Capturing the browser's event ourselves lets Shell show an obvious
  // "Sakinisha App" button instead of relying on the person noticing it.
  const [installEvent, setInstallEvent] = useState(null)
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    const onBeforeInstall = (e) => { e.preventDefault(); setInstallEvent(e) }
    const onInstalled = () => { setInstallEvent(null); setInstalled(true) }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) setInstalled(true)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])
  const promptInstall = useCallback(async () => {
    if (!installEvent) return false
    installEvent.prompt()
    const { outcome } = await installEvent.userChoice
    setInstallEvent(null)
    return outcome === 'accepted'
  }, [installEvent])

  // ── PWA: "new version available" banner ─────────────────────────────
  // sw.js activates new versions immediately (skipWaiting + clients.claim),
  // but the JS already running in the open tab is still the OLD bundle
  // until it's reloaded. Rather than force-reload mid-sale, flag it and
  // let the person choose when to refresh.
  const [updateAvailable, setUpdateAvailable] = useState(false)
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.getRegistration().then(reg => {
      if (!reg) return
      if (reg.waiting && navigator.serviceWorker.controller) setUpdateAvailable(true)
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing
        if (!sw) return
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) setUpdateAvailable(true)
        })
      })
    }).catch(() => {})
  }, [])
  const applyUpdate = useCallback(() => window.location.reload(), [])

  // Apply the theme to <html data-theme="..."> so every CSS variable in
  // global.css repaints immediately, and persist the choice per-device.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('motoshop_theme', theme)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6f9' : '#0f1923')
  }, [theme])

  const setTheme = useCallback((t) => setThemeState(t === 'light' ? 'light' : 'dark'), [])
  const toggleTheme = useCallback(() => setThemeState(t => t === 'light' ? 'dark' : 'light'), [])

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

  // Every date/time formatter in utils/datetime.js reads a single
  // module-level "active timezone" instead of taking it as a prop, so
  // this is the one place that has to keep it in sync with Settings.
  // Defaults to EAT until Settings has loaded (or when logged out).
  useEffect(() => {
    setTimezone(settings.timezone || DEFAULT_TIMEZONE)
  }, [settings.timezone])

  // Keep the browser tab title (and iOS "Add to Home Screen" title) in
  // sync with the shop's own name — the installed-app name/icon come from
  // /api/manifest.webmanifest instead, which reflects Settings even
  // before login.
  useEffect(() => {
    const name = settings.header_title || settings.shop_name
    if (!name) return
    document.title = name
    const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]')
    if (appleTitle) appleTitle.setAttribute('content', name)
  }, [settings.header_title, settings.shop_name])

  // Badge the installed app icon with the count of sales/actions still
  // waiting to sync — a visible nudge to reconnect, without opening the app.
  useEffect(() => {
    if (!('setAppBadge' in navigator)) return
    if (pendingSyncCount > 0) navigator.setAppBadge(pendingSyncCount).catch(() => {})
    else navigator.clearAppBadge?.().catch(() => {})
  }, [pendingSyncCount])

  // ── Auth ──────────────────────────────────────────────────────────────
  const login = useCallback(async (username, password) => {
    let data
    try {
      data = await api.login(username, password)
    } catch (err) {
      if (err && err.maintenance) refreshSystemStatus()
      throw err
    }
    localStorage.setItem('motoshop_token', data.token)
    localStorage.setItem('motoshop_role', data.role)
    localStorage.setItem('motoshop_username', data.username)
    localStorage.setItem('motoshop_user_id', data.user_id)
    setAuth({ token: data.token, role: data.role, username: data.username, user_id: data.user_id })
    setActiveTab('dashboard')
    if (data.offline) toast('Umeingia bila mtandao — data itasawazishwa ukirudi mtandaoni', 'warning', 5000)
    return data
  }, [toast, refreshSystemStatus])

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
      theme, setTheme, toggleTheme,
      canInstall: !!installEvent, installed, promptInstall,
      updateAvailable, applyUpdate,
      systemStatus, refreshSystemStatus,
    }}>
      {children}
    </AppContext.Provider>
  )
}

export const useApp = () => useContext(AppContext)
