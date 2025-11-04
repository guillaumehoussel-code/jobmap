import React, { Suspense } from 'react'
import dynamic from 'next/dynamic'

// Lightweight skeleton placeholder used while the map bundle loads.
// Keeps initial render fast and avoids loading Leaflet on server.
export default function MapLoader(props: any) {
  const MapClient = React.useMemo(
    () =>
      dynamic(() => import('./Map'), {
        ssr: false,
      }),
    []
  )

  return (
    <Suspense fallback={
      <div className="w-full h-full bg-white flex items-center justify-center">
        <div className="animate-pulse text-sm text-slate-500">Loading map…</div>
      </div>
    }>
      <MapClient {...props} />
    </Suspense>
  )
}