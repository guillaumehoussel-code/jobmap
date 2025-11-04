// utils/geocode.ts
// Geocoding fallback logic: Mapbox if MAPBOX_TOKEN present, otherwise Nominatim with polite throttling.
// In-memory cache during dev; instructions & prepared SQL for production Supabase cache.

import pThrottle from 'p-throttle'

type Geo = { lat: number; lon: number } | null

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || ''
const USE_MAPBOX = !!MAPBOX_TOKEN

// In-memory cache: key -> { lat, lon }
const cache = new Map<string, Geo>()

// Throttle Nominatim to 1 request per second (polite)
const nominatimThrottle = pThrottle({
  limit: 1,
  interval: 1000
})

async function geocodeMapbox(query: string): Promise<Geo> {
  if (!USE_MAPBOX) return null
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_TOKEN}&country=fr&limit=1`
  const r = await fetch(url)
  if (!r.ok) return null
  const j = await r.json()
  const c = j?.features?.[0]
  if (!c) return null
  return { lat: c.center[1], lon: c.center[0] }
}

const geocodeNominatimThrottled = nominatimThrottle(async (query: string) => {
  // polite Nominatim query
  // provide a custom user agent via header if allowed by deployment
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=fr&limit=1`
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'JobMap/1.0 (+https://yourdomain.example) - contact: youremail@example.com'
    }
  })
  if (!r.ok) return null
  const j = await r.json()
  const item = j?.[0]
  if (!item) return null
  return { lat: Number(item.lat), lon: Number(item.lon) }
})

export async function fetchGeocodeIfNeeded({ company, city }: { company?: string; city?: string }): Promise<Geo> {
  const key = `${(company || '').trim().toLowerCase()}|${(city || '').trim().toLowerCase()}`
  if (!company && !city) return null
  if (cache.has(key)) return cache.get(key) || null

  // Check production cache in Supabase if you want (not implemented here) -- prepare SQL below
  // For dev we do in-memory caching, obeying provider usage
  try {
    let res: Geo = null
    if (USE_MAPBOX) {
      res = await geocodeMapbox(`${company ? company + ' ' : ''}${city ?? ''}`)
    }
    if (!res) {
      // Nominatim throttled call
      res = await geocodeNominatimThrottled(`${company ? company + ' ' : ''}${city ?? ''}`)
    }
    // Save in memory cache
    cache.set(key, res)
    return res
  } catch (err) {
    console.warn('Geocode failed', err)
    cache.set(key, null)
    return null
  }
}

// Production SQL to create geocode_cache table (run in Supabase):
/*
create table public.geocode_cache (
  id uuid default gen_random_uuid() primary key,
  key text unique not null,
  geom geography(Point, 4326),
  lat double precision,
  lon double precision,
  created_at timestamptz default now()
);
*/

// Usage: insert into geocode_cache (key, geom, lat, lon) values ('company|city', ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography, lat, lon);

/*
RPC example for jobs import will be provided elsewhere; geocode cache can be used by server-side importer.
*/

export function prepareGeocodeCacheForProduction() {
  // helper placeholder to remind the developer about the SQL - not executed
  return
}