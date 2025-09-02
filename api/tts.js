// Serverless handler for TTS endpoints
// Routes this single function by subpath of /api/tts...
//   POST /api/tts
//   POST /api/tts/ 
//   POST /api/tts/warm

export default async function handler(req, res) {
    // CORS for serverless (Vercel)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', '86400')
    if (req.method === 'OPTIONS') return res.status(204).end()

    const url = new URL(req.url, `http://${req.headers.host}`)
    const subpath = url.pathname.replace(/^\/api\/tts\/?/, '') // '', 'stream', 'warm'
  
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return res.status(405).json({ error: 'Method Not Allowed' })
    }
  
    const apiKey = process.env.OPENAI_TTS_API_KEY
    if (!apiKey) {
      console.error('[TTS] Missing OPENAI_TTS_API_KEY')
      return res.status(500).json({ error: 'Server misconfigured: missing OPENAI_TTS_API_KEY' })
    }
  
    // Warm-up (best-effort, always 204)
    if (subpath === 'warm') {
      try {
        await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: 'ok', format: 'mp3' }),
        })
      } catch {}
      return res.status(204).end()
    }
  
    const { text, voice = 'alloy', format = 'mp3', model = 'gpt-4o-mini-tts' } = req.body || {}
    if (!text) return res.status(400).json({ error: 'No text provided' })
  
    // Streaming
    if (subpath === 'stream') {
      try {
        const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, voice, input: text, format }),
        })
  
        if (!upstream.ok) {
          let detail = ''
          try { const json = await upstream.json(); detail = json?.error?.message || JSON.stringify(json) } catch { try { detail = await upstream.text() } catch {} }
          console.error(`[TTS] OpenAI stream error ${upstream.status} ${upstream.statusText}: ${detail}`)
          return res.status(upstream.status).json({ error: detail || 'OpenAI TTS request failed' })
        }
  
        res.setHeader('Content-Type', `audio/${format}`)
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('Access-Control-Allow-Origin', '*')
  
        const body = upstream.body
        if (!body) return res.status(502).json({ error: 'No upstream body' })
  
        if (typeof body.pipe === 'function') {
          body.pipe(res)
          body.on('error', () => { try { res.end() } catch {} })
          body.on('end', () => { try { res.end() } catch {} })
        } else if (typeof body.getReader === 'function') {
          const reader = body.getReader()
          try {
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              if (value) res.write(Buffer.from(value))
            }
          } finally {
            try { res.end() } catch {}
          }
        } else if (body[Symbol.asyncIterator]) {
          try {
            for await (const chunk of body) {
              res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
            }
          } finally {
            try { res.end() } catch {}
          }
        } else {
          return res.status(502).json({ error: 'Unknown upstream stream type' })
        }
      } catch (e) {
        if (!res.headersSent) return res.status(500).json({ error: e.message || 'TTS stream failed' })
        try { res.end() } catch {}
      }
      return
    }
  
    // Non-streaming synth
    try {
      const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, voice, input: text, format }),
      })
  
      if (!upstream.ok) {
        let detail = ''
        try { const json = await upstream.json(); detail = json?.error?.message || JSON.stringify(json) } catch { try { detail = await upstream.text() } catch {} }
        console.error(`[TTS] OpenAI error ${upstream.status} ${upstream.statusText}: ${detail}`)
        return res.status(upstream.status).json({ error: detail || 'OpenAI TTS request failed' })
      }
  
      const arrayBuffer = await upstream.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      res.set({
        'Content-Type': `audio/${format}`,
        'Content-Length': buffer.length,
      })
      return res.send(buffer)
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }