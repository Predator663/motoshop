import { useState, useEffect } from 'react'
import { api } from '../utils/api'

export default function LegalPage({ page }) {
  const [content, setContent] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getLegalContent().then(setContent).catch(() => setContent({})).finally(() => setLoading(false))
  }, [])

  function goBack() {
    window.location.href = '/'
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: 36, height: 36, borderWidth: 4 }} />
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: '32px 16px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <button onClick={goBack} className="btn btn-secondary btn-sm" style={{ marginBottom: 20 }}>← Rudi kwenye App</button>

        {page === 'about' ? (
          <AboutContent content={content} />
        ) : (
          <LegalContent
            title={page === 'terms' ? content.terms_title : content.privacy_title}
            body={page === 'terms' ? content.terms_body : content.privacy_body}
          />
        )}

        <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 32, fontSize: 12 }}>
          <a href="/?page=privacy" style={{ color: 'var(--text3)' }}>Faragha</a>
          <a href="/?page=terms" style={{ color: 'var(--text3)' }}>Vigezo na Masharti</a>
          <a href="/?page=about" style={{ color: 'var(--text3)' }}>Kuhusu</a>
        </div>
      </div>
    </div>
  )
}

function LegalContent({ title, body }) {
  return (
    <div className="card">
      <h1 style={{ fontFamily: 'var(--font-head)', fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 16 }}>
        {title}
      </h1>
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, color: 'var(--text2)', fontSize: 14 }}>
        {body}
      </div>
    </div>
  )
}

function AboutContent({ content }) {
  const hasPhoto = !!content.about_photo
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <div style={{
        width: 120, height: 120, borderRadius: '50%', margin: '0 auto 16px',
        overflow: 'hidden', background: 'var(--bg2)', border: '2px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40,
      }}>
        {hasPhoto ? (
          <img src={content.about_photo} alt={content.about_name || 'Kuhusu'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : '🧑‍💻'}
      </div>
      <h1 style={{ fontFamily: 'var(--font-head)', fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>
        {content.about_name || 'Kuhusu'}
      </h1>
      {content.about_title && (
        <div style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 600, marginTop: 2 }}>{content.about_title}</div>
      )}
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, color: 'var(--text2)', fontSize: 14, marginTop: 16, textAlign: 'left' }}>
        {content.about_bio || 'Taarifa bado hazijawekwa.'}
      </div>
    </div>
  )
}
