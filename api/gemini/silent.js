// POST /api/gemini/silent -> no content, logs server-side
export default async function handler(req, res) {
  // CORS for serverless (Vercel)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') return res.status(204).end()

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).end()
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || ''
  if (!apiKey) return res.status(500).end()

  const { prompt, model = 'gemini-1.5-flash' } = req.body || {}
  if (!prompt || typeof prompt !== 'string') return res.status(400).end()

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const body = { contents: [{ parts: [{ text: String(prompt) }] }], generationConfig: { maxOutputTokens: 2048, temperature: 0.7 } }

  try {
    const upstream = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await upstream.json().catch(() => ({}))
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    console.log('[Gemini] Response:', text)
    return res.status(204).end()
  } catch {
    return res.status(500).end()
  }
}
