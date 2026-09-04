export const getUiCookie = async (baseUrl: string, language = 'zh') => {
  const response = await fetch(`${baseUrl}/api/ui/session`, {
    headers: { 'x-hive-language': language },
  })
  const cookie = response.headers.get('set-cookie')
  if (!cookie) {
    throw new Error('Expected UI session cookie')
  }
  return cookie
}
