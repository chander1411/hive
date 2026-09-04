import type { PromptLanguage } from './prompt-language.js'

export const wrapSystemMessage = (content: string, language: PromptLanguage = 'zh') => {
  if (language === 'zh') return `[Hive 系统消息：${content}]`
  if (language === 'es') return `[Mensaje del sistema Hive: ${content}]`
  return `[Hive system message: ${content}]`
}
