import { useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import JobMap from '../components/Map'
import qs from 'qs'
import { useMediaQuery } from 'react-responsive'
import clsx from 'clsx'

type Job = {
  id: string
  title: string
  company: string
  city: string
  salary_min?: number
  salary_max?: number
  remote?: boolean
  lat: number
  lon: number
  url?: string
  description?: string
  posted_at?: string
}

function useDebouncedFetch() {
  const controllerRef = useRef<AbortController | null>(null)
  const timerRef = useRef<number | null>(null)

  async function fetchWithCancel(url: string, opts: { delay?: number } = {}) {
    if (controllerRef.current) controllerRef.current.abort()
    controllerRef.current = new AbortController()
    const signal = controllerRef.current.signal
    if (timerRef.current) window.clearTimeout(timerRef.current)
    if (opts.delay && opts.delay > 0) {
      await new Promise((resolve) => { timerRef.current = window.setTimeout(resolve, opts.delay) })
    }
    const res = await fetch(url, { signal })
    const json = await res.json()
    return json
  }
  function cancel() {
    if (controllerRef.current) controllerRef.current.abort()
    if (timerRef.current) window.clearTimeout(timerRef.current)
  }
  return { fetchWithCancel, cancel }
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Controlled filters with persistence
  const defaultFilters = {
    keyword: '',
    city: '',
    minSalary: '',
    maxSalary: '',
    remoteOnly: false,
    resultsPerPage: 10,
    page: 1,
    sort: 'date_desc'
  }
  const [filters, setFilters] = useState(() => {
    if (typeof window === 'undefined') return defaultFilters
    try {
      const fromUrl = qs.parse(location.search.replace(/^\?/, ''))
      if (Object.keys(fromUrl).length) {
        return { ...defaultFilters, ...fromUrl }
      }
      const stored = localStorage.getItem('jobmap_filters')
      if (stored) return JSON.parse(stored)
    } catch (err) {
      return defaultFilters
    }
    return defaultFilters
  })

  // Sync filters to URL & localStorage
  useEffect(() => {
    const qsStr = qs.stringify(filters, { addQueryPrefix: true, skipNulls: true })
    const url = `${location.pathname}${qsStr}`
    window.history.replaceState({}, '', url)
    try { localStorage.setItem('jobmap_filters', JSON.stringify(filters)) } catch {}
  }, [filters])

  const [page, setPage] = useState(Number(filters.page) || 1)
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [searchInArea, setSearchInArea] = useState(false)
  const [bboxParams, setBboxParams] = useState<{ bbox?: string; center_lat?: number; center_lon?: number; radius_km?: number } | null>(null)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const [mapBusy, setMapBusy] = useState(false)

  const isMobile = useMediaQuery({ maxWidth: 768 })

  const { fetchWithCancel, cancel } = useDebouncedFetch()

  // Build query
  function buildQuery(params: { page?: number } = {}) {
    const p = {
      keyword: filters.keyword || undefined,
      city: filters.city || undefined,
      minSalary: filters.minSalary || undefined,
      maxSalary: filters.maxSalary || undefined,
      results_per_page: filters.resultsPerPage,
      page: params.page ?? page,
      sort: filters.sort,
      ...bboxParams
    }
    return qs.stringify(p, { addQueryPrefix: true, skipNulls: true })
  }

  // Fetch jobs
  async function loadJobs(opts: { page?: number; delay?: number } = {}) {
    setLoading(true)
    setError(null)
    setMapBusy(true)
    try {
      const q = buildQuery(opts)
      const json = await fetchWithCancel(`/api/jobs${q}`, { delay: opts.delay ?? 400 })
      if (json.message) {
        setError(json.message)
        setJobs([])
      } else {
        setJobs(Array.isArray(json.data) ? json.data : [])
        setTotalCount(typeof json.count === 'number' ? json.count : null)
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // canceled - ignore
        return
      }
      console.error(err)
      setError('Failed to fetch jobs')
      setJobs([])
    } finally {
      setLoading(false)
      // Let spinner fade but keep interactions available
      setTimeout(() => setMapBusy(false), 200)
    }
  }

  // initial load
  useEffect(() => {
    loadJobs({ page: Number(filters.page) || 1, delay: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounce filter changes: 400ms
  useEffect(() => {
    const t = window.setTimeout(() => {
      setPage(1)
      setFilters((f) => ({ ...f, page: 1 }))
      loadJobs({ page: 1, delay: 0 })
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.keyword, filters.city, filters.minSalary, filters.maxSalary, filters.remoteOnly, filters.resultsPerPage, filters.sort, bboxParams])

  // pagination handlers
  const handleNext = () => {
    const next = page + 1
    setPage(next)
    setFilters((f) => ({ ...f, page: next }))
    loadJobs({ page: next })
  }
  const handlePrev = () => {
    if (page <= 1) return
    const prev = page - 1
    setPage(prev)
    setFilters((f) => ({ ...f, page: prev }))
    loadJobs({ page: prev })
  }

  // bounds callback from Map
  function handleBoundsChange(bbox: string, centerLat?: number, centerLon?: number, radiusKm?: number) {
    setBboxParams({ bbox: bbox || undefined, center_lat: centerLat || undefined, center_lon: centerLon || undefined, radius_km: radiusKm || undefined })
  }

  // highlight handlers from list hover/tap
  function handleListHover(jobId?: string) {
    setHighlightedId(jobId || null)
  }
  function handleMarkerClick(job: Job) {
    // open detail or navigate; here we just highlight
    setHighlightedId(job.id)
  }

  // UI drawer and bottom sheet handling for mobile
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(!isMobile ? true : false)

  // render
  return (
    <>
      <Head>
        <title>JobMap — MVP</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
      </Head>

      <main className="min-h-screen bg-slate-50">
        <header className="bg-white border-b sticky top-0 z-30">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button className="text-lg font-semibold">JobMap</button>
              <span className="text-sm text-slate-500 hidden sm:inline">Find jobs on the map across France</span>
            </div>

            <div className="flex items-center gap-2">
              <div className="hidden sm:flex items-center gap-2 text-sm text-slate-600">
                <div>{loading ? 'Loading…' : `${jobs.length} jobs`}</div>
              </div>

              <button className="p-2 rounded-md hover:bg-slate-100 sm:hidden" onClick={() => setFiltersOpen(true)} aria-label="Open filters">
                <svg className="w-5 h-5 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M6 12h12M10 18h4"/></svg>
              </button>

              <div className="hidden sm:block">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={searchInArea} onChange={(e) => setSearchInArea(e.target.checked)} />
                  Search in this area
                </label>
              </div>
            </div>
          </div>
        </header>

        <section className="max-w-6xl mx-auto px-2 sm:px-4 py-4">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* Sidebar filters - desktop */}
            <aside className="hidden lg:block lg:col-span-1 bg-white p-4 rounded-md shadow-sm h-fit">
              <h3 className="font-medium mb-2">Filters</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-600">Keyword</label>
                  <input value={filters.keyword} onChange={(e) => setFilters(f => ({ ...f, keyword: e.target.value }))} className="mt-1 w-full border rounded px-2 py-1 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-slate-600">City</label>
                  <input value={filters.city} onChange={(e) => setFilters(f => ({ ...f, city: e.target.value }))} className="mt-1 w-full border rounded px-2 py-1 text-sm" />
                </div>

                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-xs text-slate-600">Min salary</label>
                    <input type="number" value={filters.minSalary as any} onChange={(e) => setFilters(f => ({ ...f, minSalary: e.target.value }))} className="mt-1 w-full border rounded px-2 py-1 text-sm" />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-slate-600">Max salary</label>
                    <input type="number" value={filters.maxSalary as any} onChange={(e) => setFilters(f => ({ ...f, maxSalary: e.target.value }))} className="mt-1 w-full border rounded px-2 py-1 text-sm" />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-slate-600">Sort</label>
                  <select value={filters.sort} onChange={(e) => setFilters(f => ({ ...f, sort: e.target.value }))} className="mt-1 w-full border rounded px-2 py-1 text-sm">
                    <option value="date_desc">Newest</option>
                    <option value="salary_desc">Salary high → low</option>
                    <option value="salary_asc">Salary low → high</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={filters.remoteOnly as any} onChange={(e) => setFilters(f => ({ ...f, remoteOnly: e.target.checked }))} />
                  <div className="text-sm">Remote only</div>
                </div>

                <div className="flex items-center gap-2">
                  <button onClick={() => {
                    setFilters(defaultFilters as any)
                    setPage(1)
                    loadJobs({ page: 1 })
                  }} className="px-3 py-1 rounded border text-sm">Reset</button>
                </div>
              </div>
            </aside>

            {/* Map + list column */}
            <div className="lg:col-span-3 flex flex-col gap-3">
              {/* Map */}
              <div className={clsx("relative", isMobile ? "h-[72vh]" : "h-[72vh]")}>
                {/* Map spinner overlay */}
                {mapBusy && (
                  <div className="absolute z-40 top-3 right-3 p-2 bg-white rounded shadow flex items-center gap-2">
                    <svg className="w-4 h-4 animate-spin text-slate-600" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none"/></svg>
                    <div className="text-xs text-slate-700">Fetching…</div>
                  </div>
                )}

                <JobMap
                  jobs={jobs}
                  onBoundsChange={(bbox, lat, lon, radius) => {
                    if (searchInArea) {
                      setBboxParams({ bbox, center_lat: lat, center_lon: lon, radius_km: radius })
                    } else {
                      setBboxParams(null)
                    }
                  }}
                  highlightedId={highlightedId}
                  onMarkerClick={(job) => { setHighlightedId(job.id) }}
                />
              </div>

              {/* List / bottom sheet */}
              <div className={clsx("bg-transparent", isMobile ? "fixed left-0 right-0 bottom-0 z-50" : "")}>
                <div className={clsx("max-w-6xl mx-auto", isMobile ? "px-4" : "px-0")}>
                  <div className={clsx("bg-white rounded-t-xl shadow-lg", isMobile ? "pt-2 pb-6" : "p-4")}>
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-slate-600">{totalCount !== null ? `${totalCount} results` : `${jobs.length} results`}</div>
                      <div className="flex items-center gap-2">
                        <button onClick={handlePrev} disabled={page <= 1 || loading} className="px-3 py-1 rounded border text-sm disabled:opacity-50">Prev</button>
                        <button onClick={handleNext} disabled={loading || (totalCount !== null && page * Number(filters.resultsPerPage) >= totalCount)} className="px-3 py-1 rounded bg-blue-600 text-white text-sm disabled:opacity-50">Next</button>
                      </div>
                    </div>

                    {/* skeleton / empty / list */}
                    {loading ? (
                      <div className="mt-3 space-y-2">
                        {[...Array(5)].map((_, i) => (
                          <div key={i} className="animate-pulse bg-slate-100 h-16 rounded" />
                        ))}
                      </div>
                    ) : jobs.length === 0 ? (
                      <div className="mt-3 text-center text-sm text-slate-500">No jobs found. Try widening your filters or turning off "Search in this area".</div>
                    ) : (
                      <div className="mt-3 space-y-2 max-h-[40vh] overflow-auto">
                        {jobs.map((j) => (
                          <div
                            key={j.id}
                            onMouseEnter={() => handleListHover(j.id)}
                            onMouseLeave={() => handleListHover(undefined)}
                            onClick={() => { setHighlightedId(j.id) }}
                            className={clsx("p-3 rounded-md shadow-sm flex justify-between items-start cursor-pointer", highlightedId === j.id ? "border border-blue-200 bg-blue-50" : "bg-white")}
                          >
                            <div>
                              <div className="font-semibold text-sm">{j.title}</div>
                              <div className="text-xs text-slate-600">{j.company} — {j.city}</div>
                              <div className="text-xs text-slate-500">{j.salary_min ? `${j.salary_min?.toLocaleString()}€ - ${j.salary_max?.toLocaleString()}€` : 'Salary not specified'}</div>
                            </div>
                            <div className="text-sm">
                              {j.url && <a className="text-blue-600" href={j.url} target="_blank" rel="noreferrer">View</a>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

            </div>
          </div>
        </section>

        <footer className="border-t">
          <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-slate-500">
            Built with Next.js, React Leaflet and TailwindCSS — MVP
          </div>
        </footer>

        {/* Mobile filter drawer */}
        {filtersOpen && (
          <div className="fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/30" onClick={() => setFiltersOpen(false)} />
            <div className="absolute right-0 top-0 bottom-0 w-3/4 bg-white p-4 overflow-auto">
              <h3 className="font-medium mb-2">Filters</h3>
              <div className="space-y-3">
                <input value={filters.keyword} onChange={(e) => setFilters(f => ({ ...f, keyword: e.target.value }))} placeholder="Keyword" className="w-full border rounded px-2 py-1" />
                <input value={filters.city} onChange={(e) => setFilters(f => ({ ...f, city: e.target.value }))} placeholder="City" className="w-full border rounded px-2 py-1" />
                <div className="flex gap-2">
                  <input type="number" value={filters.minSalary as any} onChange={(e) => setFilters(f => ({ ...f, minSalary: e.target.value }))} placeholder="Min" className="w-1/2 border rounded px-2 py-1" />
                  <input type="number" value={filters.maxSalary as any} onChange={(e) => setFilters(f => ({ ...f, maxSalary: e.target.value }))} placeholder="Max" className="w-1/2 border rounded px-2 py-1" />
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={filters.remoteOnly as any} onChange={(e) => setFilters(f => ({ ...f, remoteOnly: e.target.checked }))} />
                  <div>Remote only</div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => { setFilters(defaultFilters as any); setFiltersOpen(false); loadJobs({ page: 1 }) }} className="px-3 py-1 rounded border">Reset</button>
                  <button onClick={() => { setFiltersOpen(false); loadJobs({ page: 1 }) }} className="px-3 py-1 rounded bg-blue-600 text-white">Apply</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  )
}