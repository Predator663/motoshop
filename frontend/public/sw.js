// MotoShop Service Worker — Offline support
// v3: resilient install (one bad asset can't kill offline mode), generic
// network-first-with-cache-fallback for ALL /api/ GET requests (dashboard,
// debts, expenses, stock, settings, reports, etc. all keep working offline
// using the last successful response instead of going blank), and a proper
// offline navigation fallback so a hard refresh while offline still loads
// the app shell instead of the browser's own error page.

const SHELL_CACHE = 'motoshop-shell-v3'
const API_CACHE = 'motoshop-api-v3'
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json']

self.addEventListener('install', evt => {
  evt.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      // FIX (offline support): addAll() fails atomically — if a single
      // asset 404s, the whole install rejects and the SW never activates,
      // meaning the app never gets offline support at all. Cache each
      // asset independently instead so one bad entry can't sink the rest.
      Promise.all(STATIC_ASSETS.map(url => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== SHELL_CACHE && k !== API_CACHE)
        .map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', evt => {
  const req = evt.request
  const url = new URL(req.url)

  // ── API requests ─────────────────────────────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') {
      // Writes always go to the network. The app itself (api.js) is
      // responsible for queueing failed writes — the SW can't safely
      // retry a POST/PUT/DELETE on its own without risking duplicates.
      evt.respondWith(
        fetch(req).catch(() =>
          new Response(JSON.stringify({ error: 'Nje ya mtandao' }), {
            status: 503, headers: { 'Content-Type': 'application/json' }
          })
        )
      )
      return
    }

    // GET /api/* — network-first, cache fallback. This is what keeps the
    // dashboard, debts, expenses, stock, settings and reports pages from
    // going blank/erroring the moment connectivity drops: every successful
    // read is cached, and the most recent cached copy is served whenever
    // the network call fails.
    evt.respondWith(
      caches.open(API_CACHE).then(async cache => {
        try {
          const fresh = await fetch(req)
          if (fresh.ok) cache.put(req, fresh.clone())
          return fresh
        } catch {
          const cached = await cache.match(req)
          if (cached) return cached
          return new Response(JSON.stringify({ error: 'Nje ya mtandao' }), {
            status: 503, headers: { 'Content-Type': 'application/json' }
          })
        }
      })
    )
    return
  }

  // ── App shell / static assets ───────────────────────────────────────
  // Navigations (full page loads / hard refreshes) must work offline even
  // if the exact URL was never cached before — always fall back to the
  // cached index.html shell so the SPA can boot and take over routing.
  if (req.mode === 'navigate') {
    evt.respondWith(
      fetch(req).then(resp => {
        caches.open(SHELL_CACHE).then(c => c.put(req, resp.clone())).catch(() => {})
        return resp
      }).catch(() =>
        caches.match('/index.html').then(cached => cached || caches.match('/'))
      )
    )
    return
  }

  evt.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached
      return fetch(req).then(resp => {
        if (resp.ok && req.method === 'GET') {
          caches.open(SHELL_CACHE).then(c => c.put(req, resp.clone())).catch(() => {})
        }
        return resp
      }).catch(() => caches.match('/index.html'))
    })
  )
})
