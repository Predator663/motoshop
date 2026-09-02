// src/hooks/usePagination.js — client-side pagination for list pages.
// Slices an already-loaded array into pages and keeps the current page
// valid as the underlying data changes (filtering, search, deletes, etc).
import { useState, useMemo, useEffect } from 'react'

export function usePagination(items, { pageSize = 10, resetKey } = {}) {
  const [page, setPage] = useState(1)

  // Jump back to page 1 whenever the caller-supplied reset key changes
  // (typically a filter/search value) — browsing a stale page after a
  // new filter is applied is confusing, so we don't try to preserve it.
  useEffect(() => { setPage(1) }, [resetKey])

  const total = items.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // Clamp if the list shrank (e.g. an item was deleted) below the current page.
  useEffect(() => {
    setPage(p => Math.min(p, totalPages))
  }, [totalPages])

  const paged = useMemo(() => {
    const start = (page - 1) * pageSize
    return items.slice(start, start + pageSize)
  }, [items, page, pageSize])

  return { paged, page, setPage, totalPages, total, pageSize }
}
