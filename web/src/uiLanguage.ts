export type UiLanguage = 'en' | 'es' | 'zh'

export const UI_LANGUAGE_STORAGE_KEY = 'hive.uiLanguage'

export const isUiLanguage = (value: string | null): value is UiLanguage =>
  value === 'en' || value === 'es' || value === 'zh'

export const readUiLanguage = (): UiLanguage | null => {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)
    if (isUiLanguage(stored)) return stored
  } catch {
    // Fall through to the browser language when storage is unavailable.
  }
  const browserLanguage = window.navigator.language.toLowerCase()
  if (browserLanguage.startsWith('zh')) return 'zh'
  return browserLanguage.startsWith('es') ? 'es' : 'en'
}
