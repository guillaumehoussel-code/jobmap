```typescript
import type { NextApiRequest, NextApiResponse } from 'next'
import { z } from 'zod'
import pThrottle from 'p-throttle'
import qs from 'qs'
import { fetchGeocodeIfNeeded, prepareGeocodeCacheForProduction } from '../../utils/geocode'

// Zod schemas
const JobZ = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string(),
  city: z.string(),
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
  remote: z.boolean().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  posted_at: z.string().optional(),
  source: z.string().optional()
})
const JobsResponseZ = z.object({
  data: z.array(JobZ),
  count: z.number().optional()
})

// Simple in-memory rate limiter per IP (demo use)
// Limit to 60 requests per minute per IP
const rateLimitWindowMs = 60_000
const rateLimitMax = 60
const ipStore = new Map<string, { ts: number; count: number }>()

function checkRateLimit(ip: string) {
  const now = Date.now()
  const rec = ipStore.get(ip)
  if (!rec || now - rec.ts > rateLimitWindowMs) {
    ipStore.set(ip, { ts: now, count: 1 })
    return { ok: true }
  }
  if (rec.count >= rateLimitMax) {
    return { ok: false, retryAfterMs: rateLimitWindowMs - (now - rec.ts) }
  }
  rec.count += 1
  return { ok: true }
}

// Minimal helpers
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || ''
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY || ''
const USE_SUPABASE = process.env.USE_SUPABASE === '1' || process.env.USE_SUPABASE === 'true'

const requiredInProd = process.env.NODE_ENV === 'production'
if (requiredInProd && (!ADZUNA_APP_ID || !ADZUNA_APP_KEY)) {
  // crash early in production to avoid silent failures
  console.error('ADZUNA_APP_ID and ADZUNA_APP_KEY are required in production')
  // Note: Do not throw during dev to keep local iteration easy.
}

// Throttle Adzuna calls to be polite
const throttle = pThrottle({
  limit: 5,
  interval: 1000
})

// Map Adzuna result to our Job shape
function mapAdzunaToJob(r: any) {
  try {
    const id = String(r.id || r.job_id || `${r.title}-${r.company?.display_name}-${r.location?.display_name}`)
    const title = r.title || 'No title'
    const company = r.company?.display_name || r.company || 'Unknown'
    const city = r.location?.display_name || r.location_display_name || r.location?.area?.slice(-1)?.[0] || 'Unknown'
    const salary_min = r.salary_min ? Number(r.salary_min) : undefined
    const salary_max = r.salary_max ? Number(r.salary_max) : undefined
    const remote = !!(r.contract_type && String(r.contract_type).toLowerCase().includes('remote')) || !!r.remote
    const lat = typeof r.latitude === 'number' ? r.latitude : typeof r.location?.latitude === 'number' ? r.location.latitude : undefined
    const lon = typeof r.longitude === 'number' ? r.longitude : typeof r.location?.longitude === 'number' ? r.location.longitude : undefined
    const url = r.redirect_url || r.url || r.source_url
    const description = (r.description || r.summary || '').replace(/<[^>]+>/g, '').slice(0, 2000)
    const posted_at = r.created || r.publication_date || undefined

    return { id, title, company, city, salary_min, salary_max, remote, lat, lon, url, description, posted_at, source: 'adzuna' }
  } catch (err) {
    return null
  }
}

// Build Adzuna URL
function buildAdzunaUrl(query: any, page = 1, results_per_page = 50) {
  const base = `https://api.adzuna.com/v1/api/jobs/fr/search/${page}`
  const params: any = {
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    results_per_page,
    content: 'full'
  }
  if (query.keyword) params.what = query.keyword
  if (query.city) params.where = query.city
  if (query.minSalary) params.salary_min = query.minSalary
  if (query.maxSalary) params.salary_max = query.maxSalary
  // Adzuna supports distance/search around a location in some ways; for now we rely on 'where' or client-side filtering
  return `${base}?${qs.stringify(params)}`
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Rate limit by IP
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] ?? req.socket.remoteAddress ?? 'unknown'
  const rl = checkRateLimit(ip)
  if (!rl.ok) {
    res.setHeader('Retry-After', String(Math.ceil((rl.retryAfterMs ?? 1000) / 1000)))
    return res.status(429).json({ message: 'Too many requests', hint: 'Rate limit hit. Try again later.' })
  }

  // parse query params
  const {
    keyword,
    city,
    minSalary,
    maxSalary,
    results_per_page = '20',
    page = '1',
    bbox,
    center_lat,
    center_lon,
    radius_km,
    sort
  } = req.query

  // Basic validation
  const resultsPerPage = Math.min(100, Math.max(1, Number(results_per_page)))
  const pageNum = Math.max(1, Number(page))

  try {
    // If USE_SUPABASE, call Supabase branch (not implemented fully inside this file)
    if (USE_SUPABASE) {
      // Placeholder: implement Supabase fetch here using SUPABASE_URL and SUPABASE_KEY
      // Return consistent JSON shape { data: Job[], count?: number }
      // For now fallback to Adzuna below if Supabase path not implemented
      console.warn('USE_SUPABASE enabled but Supabase path not implemented in this demo. Falling back to Adzuna.')
    }

    // Validate ADZUNA credentials in prod
    if (requiredInProd && (!ADZUNA_APP_ID || !ADZUNA_APP_KEY)) {
      return res.status(500).json({ message: 'Server misconfiguration', hint: 'ADZUNA_APP_ID and ADZUNA_APP_KEY must be set in production' })
    }

    // Build adzuna URL and fetch (throttled)
    const url = buildAdzunaUrl({ keyword, city, minSalary, maxSalary }, pageNum, resultsPerPage)
    const fetchThrottled = throttle(async (u: string) => {
      const r = await fetch(u, { headers: { Accept: 'application/json' } })
      if (!r.ok) {
        const text = await r.text()
        throw new Error(`Adzuna error ${r.status}: ${text}`)
      }
      return r.json()
    })
    const json = await fetchThrottled(url)

    const rawResults: any[] = Array.isArray(json.results) ? json.results : []
    // Map & ensure we have coordinates. If missing, geocode on demand (careful).
    const mapped = rawResults.map(mapAdzunaToJob)

    // Geocode missing points as necessary (respect rate limits)
    // We only geocode if the frontend asked to restrict by bbox/radius or we need map markers
    const jobsWithCoords = []
    for (const j of mapped) {
      if (!j) continue
      if (typeof j.lat === 'number' && typeof j.lon === 'number') {
        jobsWithCoords.push(j)
        continue
      }
      // Only geocode when job lacks coords
      const fallback = await fetchGeocodeIfNeeded({ company: j.company, city: j.city })
      if (fallback) {
        j.lat = fallback.lat
        j.lon = fallback.lon
        jobsWithCoords.push(j)
      } else {
        // If geocode failed, we skip (map needs coords)
      }
    }

    // If bbox provided from front-end, use it; otherwise if center + radius provided, filter client-side
    let filtered = jobsWithCoords
    if (typeof bbox === 'string' && bbox.length > 0) {
      // bbox should be "minLon,minLat,maxLon,maxLat" (common format) or "minLat,minLon,maxLat,maxLon"
      // We'll try to parse both: prefer minLon,minLat,maxLon,maxLat
      const parts = bbox.split(',').map(Number).filter((n) => !Number.isNaN(n))
      if (parts.length === 4) {
        const [a, b, c, d] = parts
        // Determine whether first is lon or lat by range
        // lat range is -90..90, lon -180..180. We'll assume a is lon if abs(a)>90 or abs(c)>90 or (abs(b)<=90 && abs(d)<=90 && abs(a)>abs(b))
        let minLon = Math.min(a, c)
        let maxLon = Math.max(a, c)
        let minLat = Math.min(b, d)
        let maxLat = Math.max(b, d)
        // If parsing seems wrong, swap:
        if (Math.abs(a) <= 90 && Math.abs(c) <= 90 && Math.abs(b) <= 180 && Math.abs(d) <= 180) {
          // looks like minLat,minLon,maxLat,maxLon -> swap
          minLat = Math.min(a, c)
          maxLat = Math.max(a, c)
          minLon = Math.min(b, d)
          maxLon = Math.max(b, d)
        }
        filtered = filtered.filter((j) => j.lat! >= minLat && j.lat! <= maxLat && j.lon! >= minLon && j.lon! <= maxLon)
      }
    } else if (center_lat && center_lon && radius_km) {
      const centerLat = Number(center_lat)
      const centerLon = Number(center_lon)
      const radius = Number(radius_km)
      // Haversine
      const toRad = (deg: number) => (deg * Math.PI) / 180
      const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
        const R = 6371 // km
        const dLat = toRad(lat2 - lat1)
        const dLon = toRad(lon2 - lon1)
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2)
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
        return R * c
      }
      filtered = filtered.filter((j) => haversine(centerLat, centerLon, j.lat!, j.lon!) <= radius)
    }

    // Sorting
    if (sort === 'salary_desc') {
      filtered.sort((a, b) => (b.salary_max ?? 0) - (a.salary_max ?? 0))
    } else if (sort === 'salary_asc') {
      filtered.sort((a, b) => (a.salary_min ?? 0) - (b.salary_min ?? 0))
    } else if (sort === 'date_desc') {
      filtered.sort((a, b) => {
        const da = a.posted_at ? Date.parse(a.posted_at) : 0
        const db = b.posted_at ? Date.parse(b.posted_at) : 0
        return db - da
      })
    }

    // Validate response shape with zod before returning
    const out = { data: filtered, count: filtered.length }
    const parsed = JobsResponseZ.safeParse(out)
    if (!parsed.success) {
      console.warn('Validation failed', parsed.error.format())
      return res.status(500).json({ message: 'Invalid data shape', hint: 'The API returned unexpected data' })
    }
    return res.status(200).json(out)
  } catch (err: any) {
    console.error('Error in /api/jobs', err)
    return res.status(500).json({ message: 'Failed to fetch jobs', hint: err?.message ?? 'Unknown error' })
  }
}
```