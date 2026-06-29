const BASE = '/api'

function getToken() {
  return localStorage.getItem('motoshop_token')
}

async function request(method, path, body, signal) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  const opts = { method, headers, signal }
  if (body !== undefined) opts.body = JSON.stringify(body)

  let res
  try {
    res = await fetch(BASE + path, opts)
  } catch (e) {
    // fetch() itself threw — no connection, DNS failure, etc. Tag it so
    // callers can tell "genuinely offline" apart from "server said no".
    throw { status: undefined, message: 'Network unreachable', networkError: true }
  }
  if (res.status === 204) return null

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw { status: res.status, message: data.error || 'Request failed' }
  return data
}

// FIX (offline support): a real server-side rejection (401 expired token,
// 400 validation, 404, etc.) has a defined status code and must NOT be
// treated as "offline" — masking it with stale cache or a silent queue
// would hide genuine problems (e.g. an expired session) from the user.
// Only the absence of any response at all (status undefined) counts as
// offline for queueing/cache-fallback purposes.
function isOffline(err) {
  return !navigator.onLine || (err && err.status === undefined)
}

export const api = {
  get:    (path, signal) => request('GET', path, undefined, signal),
  post:   (path, body)   => request('POST', path, body),
  put:    (path, body)   => request('PUT', path, body),
  delete: (path)         => request('DELETE', path),

  // Auth
  login:              (u, p) => api.post('/auth/login', { username: u, password: p }),
  changePassword:     (old_password, new_password) => api.post('/auth/change-password', { old_password, new_password }),
  resetCashierPw:     (new_password, cashier_id) => api.post('/auth/reset-cashier-password', { new_password, ...(cashier_id != null ? { cashier_id } : {}) }),
  getCashierStatus:   () => api.get('/auth/cashier-status'),
  setCashierStatus:   (is_active) => api.put('/auth/cashier-status', { is_active }),

  // Setup
  setupStatus:        () => api.get('/setup/status'),
  setup:              (d) => api.post('/setup', d),

  // Settings
  // FIX (offline support): settings drive currency/VAT/language/shop name
  // across the whole app — too important to leave to the service worker's
  // generic GET cache alone. Explicit fallback here too.
  getSettings:        async () => {
    try {
      const data = await api.get('/settings')
      try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(data)) } catch {}
      return data
    } catch (err) {
      if (!isOffline(err)) throw err
      const cached = localStorage.getItem(SETTINGS_CACHE_KEY)
      if (cached) return JSON.parse(cached)
      throw err
    }
  },
  // FIX (offline support): owners do occasionally tweak settings (receipt
  // footer, VAT default, shop name) without connectivity — safe to queue,
  // nothing server-side depends on state we can't see locally.
  updateSettings:     (d) => mutateOrQueue('PUT', '/settings', d, 'settings_update'),
  downloadBackup:     () => window.open('/api/settings/backup?token=' + getToken()),

  // Categories
  getCategories:      () => api.get('/categories'),
  createCategory:     (d) => mutateOrQueue('POST', '/categories', d, 'category_create'),
  updateCategory:     (id, d) => mutateOrQueue('PUT', '/categories/' + id, d, 'category_update'),
  // FIX (offline support): same reasoning as deleteProduct — the server
  // refuses to delete a category still assigned to products, which we
  // can't reliably verify offline. Requires a connection.
  deleteCategory:     (id) => api.delete('/categories/' + id),

  // Products
  // FIX (offline support): cache the last successful product list so the
  // POS grid still has something to sell from when offline, instead of
  // going blank. Cache is refreshed on every successful online fetch.
  getProducts:        async (active_only = true) => {
    try {
      const data = await api.get('/products?active_only=' + (active_only ? 1 : 0))
      try { localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(data)) } catch {}
      return data
    } catch (err) {
      if (!isOffline(err)) throw err
      const cached = localStorage.getItem(PRODUCTS_CACHE_KEY)
      if (cached) return JSON.parse(cached)
      throw err
    }
  },
  getProduct:         (id) => api.get('/products/' + id),
  // FIX (offline support): receiving a delivery or creating/editing a
  // product are routine and safe to queue — they don't depend on
  // server-side state we can't verify locally.
  createProduct:      (d) => mutateOrQueue('POST', '/products', d, 'product_create'),
  updateProduct:      (id, d) => mutateOrQueue('PUT', '/products/' + id, d, 'product_update'),
  // FIX (offline support): deletion is deliberately NOT queued — the server
  // refuses to delete a product that already has sales history, and while
  // offline we can't reliably know whether that's still true (a queued
  // sale of this exact product might be sitting in front of this very
  // delete in the queue). Queuing it could silently fail later with no
  // clear moment for the owner to notice. Require a connection instead so
  // the rejection (if any) is seen immediately.
  deleteProduct:      (id) => api.delete('/products/' + id),
  receiveStock:       (id, d) => mutateOrQueue('POST', '/products/' + id + '/receive', d, 'stock_receive'),
  adjustStock:        (id, d) => mutateOrQueue('POST', '/products/' + id + '/adjust', d, 'stock_adjust'),
  getMovements:       (id) => api.get('/products/' + id + '/movements'),

  // Stock realtime
  getStockRealtime:   () => api.get('/stock/realtime'),

  // Shifts
  // FIX (offline support): the shift gate (see App-level enforcement) needs
  // to work before anything has ever synced — including on a fresh install
  // that goes offline before the first shift is opened. getCurrentShift
  // falls back to the last known shift state; openShift/closeShift update
  // that local state optimistically and queue the real request.
  getCurrentShift:    async () => {
    try {
      const data = await api.get('/shifts/current')
      setCachedShift(data)
      return data
    } catch (err) {
      if (!isOffline(err)) throw err
      return getCachedShift()
    }
  },
  openShift:          async (d) => {
    const optimistic = () => {
      const shift = {
        id: 'LOCAL-' + Date.now(),
        cashier_id: localStorage.getItem('motoshop_user_id'),
        cashier_name: localStorage.getItem('motoshop_username'),
        opening_cash: parseFloat(d.opening_cash) || 0,
        status: 'open',
        opened_at: new Date().toISOString(),
        offline: true,
      }
      setCachedShift(shift)
      return shift
    }
    if (!navigator.onLine) return queueGenericAction('POST', '/shifts/open', d, 'shift_open', optimistic())
    try {
      const data = await api.post('/shifts/open', d)
      // Server doesn't echo back the full shift row — refetch so the
      // cache (and anything reading it) has the real id/opened_at.
      try { setCachedShift(await api.get('/shifts/current')) } catch {}
      return data
    } catch (err) {
      if (isOffline(err)) return queueGenericAction('POST', '/shifts/open', d, 'shift_open', optimistic())
      throw err
    }
  },
  closeShift:         async (d) => {
    const optimistic = () => { clearCachedShift(); return { ok: true, offline: true } }
    if (!navigator.onLine) return queueGenericAction('POST', '/shifts/close', d, 'shift_close', optimistic())
    try {
      const data = await api.post('/shifts/close', d)
      clearCachedShift()
      return data
    } catch (err) {
      if (isOffline(err)) return queueGenericAction('POST', '/shifts/close', d, 'shift_close', optimistic())
      throw err
    }
  },
  getAllShifts:        () => api.get('/shifts'),

  // Sales
  getSales:           (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return api.get('/sales' + (q ? '?' + q : ''))
  },
  getSale:            (id) => api.get('/sales/' + id),
  // FIX (offline support): if there's no connection at all, don't even try
  // the network call — queue the sale immediately. If we are "online" per
  // the browser but the request still can't reach the server (err.status
  // is undefined, meaning fetch() itself failed rather than the server
  // responding with an error), queue it too. A real server-side rejection
  // (e.g. insufficient stock, validation error) still throws normally so
  // the cashier sees it right away instead of it being silently queued.
  createSale:         async (d) => {
    if (!navigator.onLine) return queueOfflineSale(d)
    try {
      return await api.post('/sales', d)
    } catch (err) {
      if (isOffline(err)) return queueOfflineSale(d)
      throw err
    }
  },
  cancelSale:         (id) => mutateOrQueue('POST', '/sales/' + id + '/cancel', {}, 'sale_cancel'),

  // Debts
  getDebts:           (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return api.get('/debts' + (q ? '?' + q : ''))
  },
  // FIX (offline support): paying off a debt is routine daily-ops work for
  // a cashier and very likely to happen mid-outage. Queue it like a sale
  // instead of just throwing — see mutateOrQueue below.
  payDebt:            (id, d) => mutateOrQueue('POST', '/debts/' + id + '/pay', d, 'debt_payment'),

  // Expenses
  getExpenses:        (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return api.get('/expenses' + (q ? '?' + q : ''))
  },
  createExpense:      (d) => mutateOrQueue('POST', '/expenses', d, 'expense_create'),
  updateExpense:      (id, d) => mutateOrQueue('PUT', '/expenses/' + id, d, 'expense_update'),
  deleteExpense:      (id) => mutateOrQueue('DELETE', '/expenses/' + id, undefined, 'expense_delete'),

  // Dashboard & Reports
  getDashboard:       () => api.get('/dashboard'),
  getReportPL:        (from, to) => api.get('/reports/pl?from=' + from + '&to=' + to),
  getReportStock:     () => api.get('/reports/stock-valuation'),
  getReportDebtAging: () => api.get('/reports/debt-aging'),
  getReportSales:     (from, to) => api.get('/reports/sales-statement?from=' + from + '&to=' + to),
}

export function formatMoney(n, currency = 'Tsh') {
  if (n == null) return currency + ' 0'
  const abs = Math.abs(Number(n))
  const formatted = abs.toLocaleString('en-TZ', { maximumFractionDigits: 0 })
  return (n < 0 ? '-' : '') + currency + ' ' + formatted
}

export function formatDate(s) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-TZ', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDateTime(s) {
  if (!s) return '—'
  return new Date(s).toLocaleString('en-TZ', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function today() {
  return new Date().toISOString().split('T')[0]
}

export function monthStart() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

// ── Offline sync queue ────────────────────────────────────────────────────
const OFFLINE_QUEUE_KEY = 'motoshop_offline_queue'
const PRODUCTS_CACHE_KEY = 'motoshop_products_cache'
const SETTINGS_CACHE_KEY = 'motoshop_settings_cache'

// FIX (offline support): generic version of queueOfflineSale for the other
// day-to-day writes a shop makes while offline — recording an expense,
// paying down a debt. Same idea: if we're offline, or the request fails
// with no server response at all, queue it instead of losing the work.
// Real server-side rejections (validation errors, 404s, expired auth) are
// NOT queued — they're thrown immediately so the user sees them.
async function mutateOrQueue(method, path, body, kind) {
  if (!navigator.onLine) return queueGenericAction(method, path, body, kind)
  try {
    return await request(method, path, body)
  } catch (err) {
    if (isOffline(err)) return queueGenericAction(method, path, body, kind)
    throw err
  }
}

function queueGenericAction(method, path, body, kind, optimistic = {}) {
  const local_ref = kind + '-' + Date.now().toString().slice(-8)
  addToOfflineQueue({ method, path, body, kind, local_ref })
  return { ...optimistic, offline: true, local_ref, queued_at: new Date().toISOString() }
}

// ── Shift cache (offline-first shift gate) ─────────────────────────────────
const SHIFT_CACHE_KEY = 'motoshop_shift_cache'

export function getCachedShift() {
  try { return JSON.parse(localStorage.getItem(SHIFT_CACHE_KEY) || 'null') } catch { return null }
}
function setCachedShift(shift) {
  try { localStorage.setItem(SHIFT_CACHE_KEY, JSON.stringify(shift)) } catch {}
}
function clearCachedShift() {
  try { localStorage.removeItem(SHIFT_CACHE_KEY) } catch {}
}

export function getCachedProducts() {
  try { return JSON.parse(localStorage.getItem(PRODUCTS_CACHE_KEY) || '[]') } catch { return [] }
}
export function setCachedProducts(list) {
  try { localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(list)) } catch {}
}

export function getOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]')
  } catch { return [] }
}

export function addToOfflineQueue(action) {
  const q = getOfflineQueue()
  q.push({ ...action, id: Date.now() + Math.random(), queued_at: new Date().toISOString() })
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q))
  return q[q.length - 1]
}

export function clearOfflineQueue() {
  localStorage.setItem(OFFLINE_QUEUE_KEY, '[]')
}

// FIX (offline support): decrement the locally cached product stock so that,
// if several sales happen back-to-back during the same outage, the POS
// grid doesn't let the cashier oversell beyond what's actually on the shelf.
// This is just a local display safeguard — the server recalculates the real
// stock from scratch when each queued sale is synced.
function adjustCachedStock(items) {
  try {
    const cached = JSON.parse(localStorage.getItem(PRODUCTS_CACHE_KEY) || '[]')
    const updated = cached.map(p => {
      const sold = items.find(i => i.product_id === p.id)
      if (!sold) return p
      return { ...p, current_stock: Math.max(0, (p.current_stock || 0) - (parseFloat(sold.qty) || 0)) }
    })
    localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(updated))
  } catch {}
}

// FIX (offline support): record a sale locally instead of failing it outright.
// Returns a result shaped like the real API response so the POS page can show
// a receipt immediately, marked as pending sync.
function queueOfflineSale(payload) {
  const localRef = 'NJE-' + Date.now().toString().slice(-8)
  addToOfflineQueue({ method: 'POST', path: '/sales', body: payload, local_ref: localRef, kind: 'sale' })
  adjustCachedStock(payload.items || [])
  return {
    receipt_no: localRef,
    created_at: new Date().toISOString(),
    offline: true,
  }
}

// FIX (offline support): guards against duplicate sales if the browser
// fires several 'online' events in quick succession on a flaky connection —
// without this, two overlapping syncs could both send the same queued sale.
let _syncInFlight = false

export async function syncOfflineQueue(toast) {
  if (_syncInFlight) return 0
  _syncInFlight = true
  try {
    const q = getOfflineQueue()
    if (q.length === 0) return 0
    let synced = 0
    let failedPermanently = 0
    const remaining = []
    for (const item of q) {
      try {
        await request(item.method, item.path, item.body)
        synced++
      } catch (e) {
        if (isOffline(e)) {
          // Still no connection (or it dropped again mid-sync) — keep it
          // queued, untouched, for the next sync attempt.
          remaining.push(item)
        } else {
          // The server actively rejected it (e.g. stock now insufficient,
          // a debt already paid by someone else, validation failure).
          // Retrying forever would just spam the same failure every time
          // we come back online, so give it a few attempts then drop it
          // and tell the user so they can fix it manually.
          const attempts = (item._attempts || 0) + 1
          if (attempts >= 3) {
            failedPermanently++
          } else {
            remaining.push({ ...item, _attempts: attempts })
          }
        }
      }
    }
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining))
    if (synced > 0 && toast) toast(`${synced} offline uuzaji umesawazishwa`, 'success')
    if (failedPermanently > 0 && toast) {
      toast(`${failedPermanently} hazikuweza kusawazishwa — tafadhali kagua`, 'error')
    }
    return synced
  } finally {
    _syncInFlight = false
  }
}

// ── Swahili translations ──────────────────────────────────────────────────
export const SW = {
  // Navigation
  dashboard: 'Dashibodi',
  pos: 'Mauzo ya Haraka',
  sales: 'Historia ya Mauzo',
  debts: 'Madeni',
  products: 'Bidhaa',
  expenses: 'Matumizi',
  reports: 'Ripoti',
  shifts: 'Zamu',
  settings: 'Mipangilio',
  profile: 'Wasifu',
  stock: 'Akiba ya Bidhaa',

  // Common
  save: 'Hifadhi',
  cancel: 'Ghairi',
  delete: 'Futa',
  edit: 'Hariri',
  add: 'Ongeza',
  search: 'Tafuta',
  loading: 'Inapakia...',
  confirm: 'Thibitisha',
  close: 'Funga',
  yes: 'Ndiyo',
  no: 'Hapana',
  total: 'Jumla',
  subtotal: 'Jumla Ndogo',
  discount: 'Punguzo',
  vat: 'VAT/Kodi',
  cash: 'Pesa Taslimu',
  credit: 'Mkopo',
  payment: 'Malipo',
  customer: 'Mteja',
  date: 'Tarehe',
  status: 'Hali',
  action: 'Kitendo',
  receipt: 'Risiti',
  amount: 'Kiasi',
  price: 'Bei',
  quantity: 'Idadi',
  stock: 'Akiba',
  category: 'Aina',
  name: 'Jina',
  phone: 'Simu',

  // POS
  cart: 'Kikapu',
  clearCart: 'Futa Kikapu',
  completeSale: 'Kamilisha Uuzaji',
  addToCart: 'Ongeza Kikapuni',
  outOfStock: 'Bidhaa Imekwisha',
  saleComplete: 'Uuzaji Umekamilika',
  printReceipt: 'Chapisha Risiti',

  // Sales History
  salesHistory: 'Historia ya Mauzo',
  mySales: 'Mauzo Yangu',
  soldBy: 'Imelipwa na',
  owner: 'Mmiliki',
  cashier: 'Mkashia',

  // Settings
  shopInfo: 'Taarifa za Duka',
  shopName: 'Jina la Duka',
  language: 'Lugha',
  swahili: 'Kiswahili',
  english: 'Kiingereza',
  headerSettings: 'Mipangilio ya Kichwa',
  headerTitle: 'Kichwa cha Mfumo',
  headerSubtitle: 'Maneno Chini ya Kichwa',
  headerIcon: 'Ikoni ya Kichwa',
  manageCategories: 'Simamia Aina',
  addCategory: 'Ongeza Aina Mpya',

  // Stock
  stockPage: 'Akiba ya Bidhaa',
  realTimeStock: 'Akiba ya Sasa Hivi',
  lowStock: 'Akiba Kidogo',
  outOfStockItems: 'Bidhaa Zilizokwisha',
  stockValue: 'Thamani ya Akiba',

  // Offline
  offline: 'Nje ya Mtandao',
  online: 'Mtandaoni',
  syncing: 'Inasawazisha...',
  syncNow: 'Sawazisha Sasa',
  pendingSync: 'Yanayosubiri Kusawazishwa',
}

export function t(key, lang = 'sw') {
  if (lang === 'sw') return SW[key] || key
  return key
}
