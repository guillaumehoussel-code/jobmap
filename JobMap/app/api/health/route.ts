import { NextRequest, NextResponse } from 'next/server'

export async function GET(_: NextRequest) {
  const USE_SUPABASE = process.env.USE_SUPABASE === '1' || process.env.USE_SUPABASE === 'true'
  const hasAdzuna = Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY)

  const mode = USE_SUPABASE ? 'live' : hasAdzuna ? 'live' : 'demo'

  const res = NextResponse.json({ ok: true, mode })
  // Ensure no caching for health check
  res.headers.set('Cache-Control', 'no-store')
  return res
}