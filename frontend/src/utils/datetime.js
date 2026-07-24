// src/utils/datetime.js
//
// Single source of truth for date/time formatting across the app.
// The shop's operating timezone is a Settings value (defaults to EAT —
// this is a Tanzania shop, and EAT is what "today" and receipt/report
// times should mean regardless of the device's own clock/locale).
//
// AppContext calls setTimezone(settings.timezone) whenever settings load
// or change, so every formatter below picks it up automatically — no
// need to thread a timezone prop through every page/component.

export const DEFAULT_TIMEZONE = 'Africa/Dar_es_Salaam' // EAT, UTC+3

// A practical list, not the full IANA set — East Africa first since
// that's who this app is built for, then other zones a Tanzanian
// business might realistically deal with (regional neighbours,
// diaspora owners, suppliers abroad).
export const TIMEZONES = [
  { value: 'Africa/Dar_es_Salaam', label: 'Afrika Mashariki — Dar es Salaam (EAT, UTC+3)' },
  { value: 'Africa/Nairobi',       label: 'Afrika Mashariki — Nairobi (EAT, UTC+3)' },
  { value: 'Africa/Kampala',       label: 'Afrika Mashariki — Kampala (EAT, UTC+3)' },
  { value: 'Africa/Kigali',        label: 'Afrika ya Kati — Kigali (CAT, UTC+2)' },
  { value: 'Africa/Johannesburg',  label: 'Afrika Kusini — Johannesburg (SAST, UTC+2)' },
  { value: 'Africa/Lagos',         label: 'Afrika Magharibi — Lagos (WAT, UTC+1)' },
  { value: 'Africa/Cairo',         label: 'Misri — Cairo (EET, UTC+2)' },
  { value: 'UTC',                  label: 'UTC (Muda wa Dunia)' },
  { value: 'Europe/London',        label: 'Uingereza — London' },
  { value: 'Europe/Paris',         label: 'Ulaya — Paris/Berlin' },
  { value: 'Asia/Dubai',           label: 'Dubai (UTC+4)' },
  { value: 'Asia/Kolkata',         label: 'India — Kolkata (UTC+5:30)' },
  { value: 'Asia/Shanghai',        label: 'China — Shanghai' },
  { value: 'America/New_York',     label: 'Marekani — New York' },
  { value: 'America/Los_Angeles',  label: 'Marekani — Los Angeles' },
]

let activeTimezone = DEFAULT_TIMEZONE

export function setTimezone(tz) {
  activeTimezone = tz && typeof tz === 'string' ? tz : DEFAULT_TIMEZONE
}

export function getTimezone() {
  return activeTimezone
}

// The backend stores timestamps as naive SQLite `datetime('now')` strings
// ("YYYY-MM-DD HH:MM:SS") which are UTC but carry no zone marker. Handed
// straight to `new Date(...)`, engines treat that shape as *local browser
// time*, silently mis-parsing every server timestamp. Normalize: if a
// string has no zone info, treat it as UTC by appending 'Z'.
export function parseServerDate(value) {
  if (value == null) return null
  if (value instanceof Date) return value
  if (typeof value === 'number') return new Date(value)
  let s = String(value).trim()
  if (!s) return null
  const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(s)
  if (!hasZone) {
    s = s.replace(' ', 'T')
    s += 'Z'
  }
  return new Date(s)
}

function fmt(value, options) {
  const d = parseServerDate(value)
  if (!d || isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-TZ', { ...options, timeZone: getTimezone() }).format(d)
}

export function formatDate(value) {
  return fmt(value, { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDateTime(value) {
  return fmt(value, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatTime(value) {
  return fmt(value, { hour: '2-digit', minute: '2-digit' })
}

// e.g. "Jumatatu, 21 Julai" style long date used for the dashboard subtitle
export function formatDateLong(value) {
  return fmt(value, { weekday: 'long', day: 'numeric', month: 'long' })
}

// "Today"/"start of month" as YYYY-MM-DD *in the active timezone* — used
// for report date-range defaults so a shop past UTC midnight but still
// mid-afternoon in EAT doesn't get yesterday's date.
export function todayInTZ() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: getTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = (t) => parts.find(p => p.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function monthStartInTZ() {
  const [y, m] = todayInTZ().split('-')
  return `${y}-${m}-01`
}
