// Serverless handler for Gemini endpoints
// Routes this single function by subpath of /api/gemini...
//   GET    /api/gemini/limit
//   POST   /api/gemini
//   POST   /api/gemini/silent
//   POST   /api/gemini/stream
//   POST   /api/gemini/stream/silent

// Self-contained helpers (no import from old server/gemini.js)
function getGeminiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    ''
  )
}

const INPUT_TOKEN_LIMIT = 50_000
const APPROX_CHARS_PER_TOKEN = 4

async function generateContent(prompt, opts = {}) {
  const apiKey = getGeminiKey()
  if (!apiKey) {
    throw new Error('Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY in environment')
  }
  const model = opts.model || 'gemini-1.5-flash'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const s = String(prompt || '')
  const maxChars = Math.max(0, Math.floor(INPUT_TOKEN_LIMIT * APPROX_CHARS_PER_TOKEN))
  if (s.length > maxChars) throw new Error('Input too long, 50k tokens max')

  const body = {
    contents: [{ parts: [{ text: s }] }],
    generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = ''
    try { const json = await res.json(); detail = json?.error?.message || JSON.stringify(json) } catch { try { detail = await res.text() } catch {} }
    throw new Error(`Gemini API error ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
  }
  const data = await res.json()
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

async function streamGenerateContent(prompt, opts = {}) {
  const apiKey = getGeminiKey()
  if (!apiKey) {
    throw new Error('Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY in environment')
  }
  const model = opts.model || 'gemini-1.5-flash'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

  const s = String(prompt || '')
  const maxChars = Math.max(0, Math.floor(INPUT_TOKEN_LIMIT * APPROX_CHARS_PER_TOKEN))
  if (s.length > maxChars) throw new Error('Input too long, 50k tokens max')

  const body = {
    contents: [{ parts: [{ text: s }] }],
    generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    let detail = ''
    try { const json = await res.json(); detail = json?.error?.message || JSON.stringify(json) } catch { try { detail = await res.text() } catch {} }
    throw new Error(`Gemini streaming error ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
  }
  return res
}

// Simple in-memory limiter (per function instance)
const WINDOW_MS = 60_000
const MAX_REQ = 10
let requestTimes = []
let limitReached = false

function geminiRateLimiter() {
  const now = Date.now()
  requestTimes = requestTimes.filter(t => now - t < WINDOW_MS)
  limitReached = requestTimes.length >= MAX_REQ
  if (limitReached) return false
  requestTimes.push(now)
  return true
}

export default async function handler(req, res) {
  // CORS for serverless (Vercel)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') return res.status(204).end()

  const url = new URL(req.url, `http://${req.headers.host}`)
  try { console.log('[Gemini][server] incoming', req.method, url.pathname) } catch {}
  // Normalize subpath: support both '/api/gemini' (Vercel) and '/gemini' (local dev)
  // and make matching case-insensitive
  const subpath = url.pathname
    .replace(/^\/(?:api\/)?gemini\/?/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase() // '', 'silent', 'stream', 'stream/silent', 'limit'

  // Dedicated limit endpoint
  if (req.method === 'GET' && subpath === 'limit') {
    const now = Date.now()
    requestTimes = requestTimes.filter(t => now - t < WINDOW_MS)
    const reached = requestTimes.length >= MAX_REQ
    limitReached = reached
    const remaining = Math.max(0, MAX_REQ - requestTimes.length)
    let msRemaining = 0
    if (reached && requestTimes.length) {
      msRemaining = Math.max(0, WINDOW_MS - (now - requestTimes[0]))
    }
    const secondsRemaining = Math.ceil(msRemaining / 1000)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({
      limit: reached ? 1 : 0,
      remaining,
      windowMs: WINDOW_MS,
      secondsRemaining,
    })
  }

  // POST routes below (all rate-limited)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }
  if (!geminiRateLimiter()) {
    return res.status(429).end()
  }

  const { prompt, model } = req.body || {}

  // /api/gemini -> text completion
  if (subpath === '') {
    try {
      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Missing prompt' })
      }
      const text = await generateContent(prompt, { model })
      return res.status(200).json({ text })
    } catch (e) {
      const status = (typeof e?.message === 'string' && e.message.includes('tokens max')) ? 400 : 500
      return res.status(status).json({ error: e.message || 'Gemini request failed' })
    }
  }

  // /api/gemini/silent -> no content, logs server-side
  if (subpath === 'silent') {
    try {
      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).end()
      }
      const text = await generateContent(prompt, { model })
      console.log('[Gemini] Response:', text)
      return res.status(204).end()
    } catch (e) {
      const status = (typeof e?.message === 'string' && e.message.includes('tokens max')) ? 400 : 500
      return res.status(status).end()
    }
  }

  // /api/gemini/stream -> SSE stream of text chunks
  if (subpath === 'stream') {
    try {
      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Missing prompt' })
      }

      // SSE headers
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.flushHeaders?.()

      const hb = setInterval(() => {
        try { res.write(': ping\n\n') } catch {}
      }, 15000)

      const upstream = await streamGenerateContent(prompt, { model })
      const bodyStream = upstream.body
      if (!bodyStream) throw new Error('No upstream body')

      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      const flushDone = () => {
        clearInterval(hb)
        try { res.write('event: done\n') } catch {}
        try { res.write('data: "[DONE]"\n\n') } catch {}
        res.end()
      }

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
        // SSE frames
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
        // NDJSON fallback
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

      // Node/Web stream handling
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
          } catch (err) {
            clearInterval(hb)
            try { res.write(`event: error\ndata: ${JSON.stringify(err?.message || 'stream error')}\n\n`) } catch {}
            res.end()
          }
        })()
      } else if (typeof bodyStream.on === 'function') {
        bodyStream.on('data', (chunk) => {
          const text = Buffer.isBuffer(chunk) ? decoder.decode(chunk, { stream: true }) : String(chunk)
          handleText(text)
        })
        bodyStream.on('end', () => {
          if (buffer.trim()) handleText('\n')
          flushDone()
        })
        bodyStream.on('error', (err) => {
          clearInterval(hb)
          try { res.write(`event: error\ndata: ${JSON.stringify(err?.message || 'stream error')}\n\n`) } catch {}
          res.end()
        })
      } else if (bodyStream[Symbol.asyncIterator]) {
        ;(async () => {
          try {
            for await (const chunk of bodyStream) {
              const text = Buffer.isBuffer(chunk) ? decoder.decode(chunk, { stream: true }) : String(chunk)
              handleText(text)
            }
            if (buffer.trim()) handleText('\n')
            flushDone()
          } catch (err) {
            clearInterval(hb)
            try { res.write(`event: error\ndata: ${JSON.stringify(err?.message || 'stream error')}\n\n`) } catch {}
            res.end()
          }
        })()
      } else {
        throw new Error('Unknown upstream body stream type')
      }
    } catch (e) {
      if (!res.headersSent) {
        return res.status(500).json({ error: e.message || 'Gemini stream failed' })
      } else {
        try { res.write(`event: error\ndata: ${JSON.stringify(e?.message || 'stream error')}\n\n`) } catch {}
        res.end()
      }
    }
    return
  }

  // /api/gemini/stream/silent -> consumes, logs, 204
  if (subpath === 'stream/silent') {
    try {
      if (!prompt || typeof prompt !== 'string') return res.status(400).end()
      const upstream = await streamGenerateContent(prompt, { model })
      const bodyStream = upstream.body
      if (!bodyStream) throw new Error('No upstream body')

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
          handleText(new TextDecoder('utf-8').decode(value, { stream: true }))
        }
        if (buffer.trim()) handleText('\n')
        return res.status(204).end()
      } else if (typeof bodyStream.on === 'function') {
        await new Promise((resolve) => {
          bodyStream.on('data', (chunk) => {
            const text = Buffer.isBuffer(chunk) ? new TextDecoder('utf-8').decode(chunk, { stream: true }) : String(chunk)
            handleText(text)
          })
          bodyStream.on('end', resolve)
          bodyStream.on('error', resolve)
        })
        if (buffer.trim()) handleText('\n')
        return res.status(204).end()
      } else if (bodyStream[Symbol.asyncIterator]) {
        for await (const chunk of bodyStream) {
          const text = Buffer.isBuffer(chunk) ? new TextDecoder('utf-8').decode(chunk, { stream: true }) : String(chunk)
          handleText(text)
        }
        if (buffer.trim()) handleText('\n')
        return res.status(204).end()
      } else {
        return res.status(502).json({ error: 'Unknown upstream body stream type' })
      }
    } catch (e) {
      return res.status(500).end()
    }
  }

  return res.status(404).json({ error: 'Unknown Gemini route' })
}