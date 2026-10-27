// src/components/Pagination.jsx — smooth, animated pagination control.
// A sliding pill tracks the active page number (measured via refs, no
// layout libs), and prev/next are disabled + faded at the ends. Renders
// nothing when there's only one page.
import { useRef, useLayoutEffect, useState } from 'react'
import { useT } from '../hooks/useT'

function pageList(current, total) {
  const delta = 1
  const range = []
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || (i >= current - delta && i <= current + delta)) range.push(i)
  }
  const withDots = []
  let last
  for (const i of range) {
    if (last != null) {
      if (i - last === 2) withDots.push(last + 1)
      else if (i - last !== 1) withDots.push('…')
    }
    withDots.push(i)
    last = i
  }
  return withDots
}

export default function Pagination({ page, totalPages, onChange, total, pageSize }) {
  const T = useT()
  const wrapRef = useRef(null)
  const btnRefs = useRef({})
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false })

  useLayoutEffect(() => {
    const el = btnRefs.current[page]
    const wrap = wrapRef.current
    if (el && wrap) {
      setIndicator({
        left: el.offsetLeft,
        width: el.offsetWidth,
        ready: true,
      })
    }
  }, [page, totalPages])

  if (totalPages <= 1) return null

  const pages = pageList(page, totalPages)
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="pagination-bar">
      <div className="pagination-info">
        {T('pagination_showing')} <strong>{from}–{to}</strong> {T('pagination_of')} <strong>{total}</strong>
      </div>
      <nav className="pagination" ref={wrapRef} aria-label={T('pagination_page')}>
        <span
          className="pagination-indicator"
          style={{
            transform: `translateX(${indicator.left}px)`,
            width: indicator.width,
            opacity: indicator.ready ? 1 : 0,
          }}
        />
        <button
          type="button"
          className="pagination-arrow"
          disabled={page === 1}
          onClick={() => onChange(page - 1)}
          aria-label={T('pagination_prev')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>

        {pages.map((p, i) => p === '…' ? (
          <span key={`d${i}`} className="pagination-dots">⋯</span>
        ) : (
          <button
            key={p}
            type="button"
            ref={el => { btnRefs.current[p] = el }}
            className={`pagination-num${p === page ? ' active' : ''}`}
            onClick={() => onChange(p)}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </button>
        ))}

        <button
          type="button"
          className="pagination-arrow"
          disabled={page === totalPages}
          onClick={() => onChange(page + 1)}
          aria-label={T('pagination_next')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </nav>
    </div>
  )
}
