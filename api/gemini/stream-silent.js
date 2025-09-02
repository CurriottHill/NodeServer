// POST /api/gemini/stream/silent -> consume stream, log chunks, 204
export default async function handler(req, res) {
  // CORS for serverless (Vercel)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') return res.status(204).end()

  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end() }
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || ''
  if (!apiKey) return res.status(500).end()

  const { prompt, model = 'gemini-1.5-flash' } = req.body || {}
  if (!prompt || typeof prompt !== 'string') return res.status(400).end()

  const INPUT_TOKEN_LIMIT = 50_000
  const APPROX_CHARS_PER_TOKEN = 4
  const s = String(prompt)
  const maxChars = Math.floor(INPUT_TOKEN_LIMIT * APPROX_CHARS_PER_TOKEN)
  if (s.length > maxChars) return res.status(400).end()

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
  const body = { contents: [{ parts: [{ text: s }] }], generationConfig: { maxOutputTokens: 1024, temperature: 0.7 } }

  try {
    const upstream = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, body: JSON.stringify(body) })
    const bodyStream = upstream.body
    if (!bodyStream) return res.status(502).end()

    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    const emitTextsFromObj = (obj) => {
      const candidates = obj?.candidates
      if (!Array.isArray(candidates)) return
      for (const c of candidates) {
        const parts = c?.content?.parts
        if (Array.isArray(parts)) {
          for (const p of parts) {
            const t = p?.text
            if (typeof t === 'string' && t.length) {
              console.log('[Gemini][stream] chunk:', t)
            }
          }
        }
      }
    }
    const handleText = (textChunk) => {
      buffer += textChunk
      let frameIdx
      while ((frameIdx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, frameIdx)
        buffer = buffer.slice(frameIdx + 2)
        for (const rawLine of frame.split(/\r?\n/)) {
          let line = rawLine.trim()
          if (!line || line.startsWith(':') || line.toLowerCase().startsWith('event:')) continue
          if (line.toLowerCase().startsWith('data:')) line = line.slice(5).trim()
          if (!line) continue
          try { emitTextsFromObj(JSON.parse(line)) } catch {}
        }
      }
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line0 = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        let line = line0.trim()
        if (!line || line.startsWith(':') || line.toLowerCase().startsWith('event:')) continue
        if (line.toLowerCase().startsWith('data:')) line = line.slice(5).trim()
        if (!line) continue
        try { emitTextsFromObj(JSON.parse(line)) } catch {}
      }
    }

    if (typeof bodyStream.getReader === 'function') {
      const reader = bodyStream.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        handleText(decoder.decode(value, { stream: true }))
      }
      if (buffer.trim()) handleText('\n')
      return res.status(204).end()
    } else if (typeof bodyStream.on === 'function') {
      await new Promise((resolve) => {
        bodyStream.on('data', (chunk) => {
          const text = Buffer.isBuffer(chunk) ? decoder.decode(chunk, { stream: true }) : String(chunk)
          handleText(text)
        })
        bodyStream.on('end', resolve)
        bodyStream.on('error', resolve)
      })
      if (buffer.trim()) handleText('\n')
      return res.status(204).end()
    } else if (bodyStream[Symbol.asyncIterator]) {
      for await (const chunk of bodyStream) {
        const text = Buffer.isBuffer(chunk) ? decoder.decode(chunk, { stream: true }) : String(chunk)
        handleText(text)
      }
      if (buffer.trim()) handleText('\n')
      return res.status(204).end()
    } else {
      return res.status(502).end()
    }
  } catch {
    return res.status(500).end()
  }
}
