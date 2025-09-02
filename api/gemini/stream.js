// POST /api/gemini/stream -> SSE of text chunks
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
  const body = { contents: [{ parts: [{ text: s }] }], generationConfig: { maxOutputTokens: 1024, temperature: 0.7 } }

  try {
    const upstream = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, body: JSON.stringify(body) })
    if (!upstream.ok || !upstream.body) {
      let detail = ''
      try { const j = await upstream.json(); detail = j?.error?.message || JSON.stringify(j) } catch { try { detail = await upstream.text() } catch {} }
      return res.status(upstream.status).json({ error: detail || 'Gemini streaming error' })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.flushHeaders?.()

    const hb = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)

    const bodyStream = upstream.body
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
              res.write(`data: ${JSON.stringify(t)}\n\n`)
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

    const flushDone = () => {
      clearInterval(hb)
      try { res.write('event: done\n') } catch {}
      try { res.write('data: "[DONE]"\n\n') } catch {}
      res.end()
    }

    if (typeof bodyStream.getReader === 'function') {
      const reader = bodyStream.getReader()
      ;(async () => {
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            handleText(decoder.decode(value, { stream: true }))
          }
          if (buffer.trim()) handleText('\n')
          flushDone()
        } catch {
          clearInterval(hb)
          res.end()
        }
      })()
    } else if (typeof bodyStream.on === 'function') {
      bodyStream.on('data', (chunk) => {
        const text = Buffer.isBuffer(chunk) ? decoder.decode(chunk, { stream: true }) : String(chunk)
        handleText(text)
      })
      bodyStream.on('end', () => { if (buffer.trim()) handleText('\n'); flushDone() })
      bodyStream.on('error', () => { clearInterval(hb); res.end() })
    } else if (bodyStream[Symbol.asyncIterator]) {
      ;(async () => {
        try {
          for await (const chunk of bodyStream) {
            const text = Buffer.isBuffer(chunk) ? decoder.decode(chunk, { stream: true }) : String(chunk)
            handleText(text)
          }
          if (buffer.trim()) handleText('\n')
          flushDone()
        } catch {
          clearInterval(hb)
          res.end()
        }
      })()
    } else {
      return res.status(502).json({ error: 'Unknown upstream body stream type' })
    }
  } catch (e) {
    if (!res.headersSent) return res.status(500).json({ error: e.message || 'Gemini stream failed' })
    try { res.end() } catch {}
  }
}
