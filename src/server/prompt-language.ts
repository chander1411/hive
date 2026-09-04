export type PromptLanguage = 'en' | 'es' | 'zh'

export const isPromptLanguage = (value: unknown): value is PromptLanguage =>
  value === 'en' || value === 'es' || value === 'zh'

export const getStoredPromptLanguage = (value: unknown): PromptLanguage =>
  isPromptLanguage(value) ? value : 'en'
