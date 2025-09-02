// POST /api/gemini -> text completion
export default async function handler(req, res) {
  // CORS for serverless (Vercel)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') return res.status(204).end()

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || ''
  if (!apiKey) return res.status(500).json({ error: 'Missing Gemini API key' })

  const { prompt, model = 'gemini-1.5-flash' } = req.body || {}
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing prompt' })
  }

  const INPUT_TOKEN_LIMIT = 50_000
  const APPROX_CHARS_PER_TOKEN = 4
  const s = String(prompt)
  const maxChars = Math.floor(INPUT_TOKEN_LIMIT * APPROX_CHARS_PER_TOKEN)
  if (s.length > maxChars) return res.status(400).json({ error: 'Input too long, 50k tokens max' })

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const body = { contents: [{ parts: [{ text: s }] }], generationConfig: { maxOutputTokens: 2048, temperature: 0.7 } }

  try {
    const upstream = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!upstream.ok) {
      let detail = ''
      try { const j = await upstream.json(); detail = j?.error?.message || JSON.stringify(j) } catch { try { detail = await upstream.text() } catch {} }
      return res.status(upstream.status).json({ error: detail || 'Gemini API error' })
    }
    const data = await upstream.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    return res.status(200).json({ text })
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Gemini request failed' })
  }
}
