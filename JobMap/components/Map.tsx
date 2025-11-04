import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import supercluster from 'supercluster'
import clsx from 'clsx'

// We're implementing clustering using a lightweight client-side approach
// to remain performant on mobile (supercluster). We render cluster markers manually.
// This avoids depending on an external react cluster library and gives more control.

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
}

const markerIcon = new L.Icon({
  iconUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  iconRetinaUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  shadowUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41]
})

const highlightIcon = new L.DivIcon({
  className: 'jobmap-highlight-marker',
  html: `<div class="rounded-full bg-blue-600 w-5 h-5 border-2 border-white" />`,
  iconSize: [18, 18],
  iconAnchor: [9, 9]
})

function useMapBoundsRef(setBbox: (bbox: string, centerLat?: number, centerLon?: number, radiusKm?: number) => void, searchInAreaEnabled: boolean) {
  // returns a component registering moveend and zoomend
  return function MapEvents() {
    const map = useMap()
    useEffect(() => {
      const onEnd = () => {
        const bounds = map.getBounds()
        const sw = bounds.getSouthWest()
        const ne = bounds.getNorthEast()
        const bbox = `${sw.lng},${sw.lat},${ne.lng},${ne.lat}` // minLon,minLat,maxLon,maxLat
        if (searchInAreaEnabled) {
          // compute radius from center to NE corner
          const center = map.getCenter()
          const R = 6371
          const toRad = (d:number) => d * Math.PI / 180
          const hav = (lat1:number, lon1:number, lat2:number, lon2:number) => {
            const dLat = toRad(lat2 - lat1)
            const dLon = toRad(lon2 - lon1)
            const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2
            return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
          }
          const radiusKm = hav(center.lat, center.lng, ne.lat, ne.lng)
          setBbox(bbox, center.lat, center.lng, Math.ceil(radiusKm))
        } else {
          setBbox('', map.getCenter().lat, map.getCenter().lng, undefined)
        }
      }
      map.on('moveend zoomend', onEnd)
      // call once
      onEnd()
      return () => {
        map.off('moveend zoomend', onEnd)
      }
    }, [map])
    return null
  }
}

export default function JobMap({
  jobs,
  onBoundsChange,
  highlightedId,
  onMarkerClick
}: {
  jobs: Job[]
  onBoundsChange: (bbox: string, centerLat?: number, centerLon?: number, radiusKm?: number) => void
  highlightedId?: string | null
  onMarkerClick?: (job: Job) => void
}) {
  // Default center France (approx)
  const center = useMemo(() => [46.7, 2.2] as [number, number], [])
  const mapRef = useRef<L.Map | null>(null)
  const mapEventsComp = useMemo(() => useMapBoundsRef(onBoundsChange, true), [onBoundsChange])

  // clustering via supercluster
  const index = useMemo(() => {
    const idx = new supercluster({
      radius: 60,
      maxZoom: 17
    })
    const points = jobs.map((j) => ({
      type: 'Feature' as const,
      properties: { cluster: false, jobId: j.id, title: j.title },
      geometry: { type: 'Point' as const, coordinates: [j.lon, j.lat] }
    }))
    idx.load(points)
    return idx
  }, [jobs])

  const [clusters, setClusters] = useState<any[]>([])
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const bounds = map.getBounds()
    const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] as [number, number, number, number]
    const zoom = map.getZoom()
    const cl = index.getClusters(bbox, Math.round(zoom))
    setClusters(cl)
  }, [index])

  // update clusters on map move/zoom
  function handleMapCreated(m: L.Map) {
    mapRef.current = m
    m.on('moveend zoomend', () => {
      const bounds = m.getBounds()
      const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] as [number, number, number, number]
      const zoom = Math.round(m.getZoom())
      const cl = index.getClusters(bbox, zoom)
      setClusters(cl)
    })
  }

  // programmatically pan to highlighted marker
  useEffect(() => {
    if (!highlightedId || !mapRef.current) return
    const j = jobs.find((x) => x.id === highlightedId)
    if (!j) return
    mapRef.current.panTo([j.lat, j.lon], { animate: true })
  }, [highlightedId, jobs])

  // Marker cluster icon creation
  const createClusterIcon = (count: number) => {
    const size = Math.min(60, 30 + Math.round(Math.log(count + 1) * 6))
    const html = `<div class="jobmap-cluster-marker" style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(59,130,246,0.9);color:white;font-weight:600;border:3px solid white;font-size:${Math.max(12, Math.round(size/3))}px">${count}</div>`
    return L.divIcon({
      html,
      className: '',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    })
  }

  return (
    <div className="w-full h-[60vh] sm:h-[72vh] md:h-[78vh] lg:h-[72vh] rounded-md overflow-hidden shadow relative">
      <MapContainer center={center} zoom={6} scrollWheelZoom style={{ height: '100%', width: '100%' }} whenCreated={handleMapCreated}>
        <TileLayer
          attribution='© OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {/* Clusters and markers */}
        {clusters.map((c) => {
          const [lon, lat] = c.geometry.coordinates
          if (c.properties.cluster) {
            const count = c.properties.point_count
            const leaves = index.getLeaves(c.id, Infinity)
            return (
              <Marker
                key={`cluster-${c.id}`}
                position={[lat, lon]}
                icon={createClusterIcon(count)}
                eventHandlers={{
                  click: () => {
                    // zoom to cluster bounds
                    const map = mapRef.current
                    if (!map) return
                    const expansionZoom = Math.min(index.getClusterExpansionZoom(c.id), 18)
                    map.setView([lat, lon], expansionZoom, { animate: true })
                  }
                }}
              />
            )
          } else {
            const jobId = c.properties.jobId
            const job = jobs.find((j) => j.id === jobId)
            if (!job) return null
            const isHighlighted = highlightedId === job.id
            const icon = isHighlighted ? highlightIcon : markerIcon
            return (
              <Marker key={job.id} position={[job.lat, job.lon]} icon={icon} eventHandlers={{
                click: () => { onMarkerClick?.(job) }
              }}>
                <Popup>
                  <div className="text-left max-w-xs">
                    <h3 className="font-semibold">{job.title}</h3>
                    <p className="text-sm text-slate-600">{job.company} — {job.city}</p>
                    <p className="text-sm mt-1">{job.salary_min ? `${job.salary_min.toLocaleString()}€ - ${job.salary_max?.toLocaleString()}€` : 'Salary not specified'}</p>
                    <p className="text-sm text-slate-500 mt-1">{job.remote ? 'Remote possible' : 'On-site'}</p>
                    {job.url && <a className="text-sm text-blue-600 break-all" href={job.url} target="_blank" rel="noreferrer">View</a>}
                  </div>
                </Popup>
              </Marker>
            )
          }
        })}
        <mapEventsComp />
      </MapContainer>

      {/* spinner overlay (non-blocking) */}
      <div id="map-loader" className="pointer-events-none absolute top-3 right-3 z-20">
        {/* show a subtle spinner via CSS when needed from parent */}
      </div>

      <style jsx>{`
        .jobmap-cluster-marker { box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .jobmap-highlight-marker { animation: pulse 1.5s infinite; }
        @keyframes pulse {
          0% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.25); opacity: 0.7; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  )
}