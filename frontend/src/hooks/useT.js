// src/hooks/useT.js — translation hook
import { useApp } from '../context/AppContext'
import { translations } from '../utils/i18n'

export function useT() {
  const { lang } = useApp()
  const dict = translations[lang] || translations.sw
  return (key) => dict[key] ?? key
}
