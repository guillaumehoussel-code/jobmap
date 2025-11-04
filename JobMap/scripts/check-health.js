#!/usr/bin/env node
const fetch = require('node-fetch')

const SITE = process.env.SITE_URL || 'http://localhost:3000'
const URL = `${SITE.replace(/\/$/, '')}/api/health`
const TIMEOUT_MS = 60_000
const RETRIES = 10
const RETRY_DELAY_MS = 1000

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
}

async function tryFetch(attempt = 1) {
  try {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await fetch(URL, { signal: controller.signal })
    clearTimeout(id)
    if (res.status !== 200) throw new Error(`Status ${res.status}`)
    const json = await res.json()
    if (json && json.ok) {
      console.log(`Health OK (${json.mode})`)
      process.exit(0)
    } else {
      throw new Error('Health check returned invalid body')
    }
  } catch (err) {
    if (attempt >= RETRIES) {
      console.error(`Health check failed after ${attempt} attempts:`, String(err))
      process.exit(1)
    } else {
      console.log(`Health attempt ${attempt} failed: ${err.message}. Retrying in ${RETRY_DELAY_MS}ms...`)
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      return tryFetch(attempt + 1)
    }
  }
}

tryFetch()