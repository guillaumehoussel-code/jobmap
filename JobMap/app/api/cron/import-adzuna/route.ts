import { NextRequest } from 'next/server'
import { createHash } from 'crypto'

type AdzunaResult = any

type JobUpsert = {
  source?: string
  source_id?: string
  title?: string
  company?: string
  city?: string
  salary_min?: number | null
  salary_max?: number | null
  url?: string
  description?: string | null
  posted_at?: string | null
  remote?: boolean | null
  lat?: number | null
  lon?: number | null
  uniq_hash: string
}

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID ?? ''
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY ?? ''
const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE ?? ''
const CRON_SECRET = process.env.CRON_SECRET ?? ''

async function fetchAdzunaPage(page: number, results_per_page = 50): Promise<any> {
  const base = `https://api.adzuna.com/v1/api/jobs/fr/search/${page}`
  const params = new URLSearchParams({
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    results_per_page: String(results_per_page),
    content: 'full'
  })
  const url = `${base}?${params.toString()}`
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) {
    const txt = await r.text()
    throw new Error(`Adzuna fetch failed ${r.status}: ${txt}`)
  }
  return r.json()
}

function mapAdzunaToUpsert(r: AdzunaResult): JobUpsert | null {
  try {
    const title = r.title ?? 'No title'
    const company = r.company?.display_name ?? r.company ?? 'Unknown'
    const city =
      r.location?.display_name ??
      r.location_display_name ??
      (Array.isArray(r.location?.area) ? r.location.area.slice(-1)[0] : undefined) ??
      'Unknown'

    const salary_min = r.salary_min ? Number(r.salary_min) : null
    const salary_max = r.salary_max ? Number(r.salary_max) : null
    const remote = !!(r.contract_type && String(r.contract_type).toLowerCase().includes('remote')) || !!r.remote
    const lat = typeof r.latitude === 'number' ? r.latitude : typeof r.location?.latitude === 'number' ? r.location.latitude : null
    const lon = typeof r.longitude === 'number' ? r.longitude : typeof r.location?.longitude === 'number' ? r.location.longitude : null
    const url = r.redirect_url ?? r.url ?? null
    const description = r.description ? String(r.description).replace(/<[^>]+>/g, '').slice(0, 4000) : null
    const posted_at = r.created ?? r.publication_date ?? null
    const source_id = r.id ?? (r.job_id ? String(r.job_id) : null)

    const hashInput = `${String(title).toLowerCase()}|${String(company)}|${String(city)}|${String(posted_at ?? '')}`
    const uniq_hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 40)

    return {
      source: 'adzuna',
      source_id: source_id ?? null,
      title,
      company,
      city,
      salary_min,
      salary_max,
      url,
      description,
      posted_at,
      remote,
      lat,
      lon,
      uniq_hash
    }
  } catch (err) {
    return null
  }
}

export async function POST(req: NextRequest) {
  try {
    // Secret check
    const secret = req.headers.get('x-cron-secret') ?? ''
    if (!CRON_SECRET || secret !== CRON_SECRET) {
      return new Response(JSON.stringify({ message: 'Unauthorized', hint: 'Invalid or missing x-cron-secret header' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Validate Adzuna creds early
    if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
      return new Response(JSON.stringify({ message: 'Server misconfiguration', hint: 'ADZUNA_APP_ID and ADZUNA_APP_KEY must be set' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return new Response(JSON.stringify({ message: 'Server misconfiguration', hint: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const pagesToFetch = [1, 2, 3]
    const resultsPerPage = 50

    // Fetch pages in sequence to be polite (could be parallel if desired)
    const allResults: AdzunaResult[] = []
    for (const p of pagesToFetch) {
      const json = await fetchAdzunaPage(p, resultsPerPage)
      if (!json || !Array.isArray(json.results)) continue
      allResults.push(...json.results)
    }

    // Map and compute uniq_hash, filter out nulls
    const upserts: JobUpsert[] = []
    for (const r of allResults) {
      const mapped = mapAdzunaToUpsert(r)
      if (mapped) upserts.push(mapped)
    }

    if (upserts.length === 0) {
      return new Response(JSON.stringify({ imported: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Call Supabase REST upsert endpoint
    // Use Prefer: resolution=merge-duplicates and on_conflict=uniq_hash
    const restUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/jobs?on_conflict=uniq_hash`
    const resp = await fetch(restUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: 'resolution=merge-duplicates, return=representation'
      },
      body: JSON.stringify(upserts)
    })

    if (!resp.ok) {
      const text = await resp.text()
      return new Response(JSON.stringify({ message: 'Failed to upsert to Supabase', hint: text }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Parse response to count imported rows (Supabase returns an array of rows by default when return=representation)
    let importedCount = 0
    try {
      const json = await resp.json()
      if (Array.isArray(json)) importedCount = json.length
      else if (typeof json === 'object' && json !== null) importedCount = 1
    } catch {
      // fallback: cannot parse, assume success
      importedCount = upserts.length
    }

    return new Response(JSON.stringify({ imported: importedCount }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ message: 'Import failed', hint: String(err?.message ?? err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

export const runtime = 'nodejs'