# JobMap — MVP

Minimal Next.js + TypeScript + TailwindCSS scaffold for JobMap:
- Interactive map (React Leaflet) centered on France
- /api/jobs returns mock job data
- / shows map with markers and simple filters (keyword, city, salary range, distance, remote)
- TailwindCSS for styling, responsive and mobile-friendly
- Deployable to Vercel

How to run locally:
1. Install dependencies
   - npm install
2. Run development server
   - npm run dev
3. Open http://localhost:3000

Notes:
- This scaffold uses mock data from `/api/jobs`. Later you'll connect it to Supabase or external job APIs.
- Leaflet requires its CSS; it's imported in `_app.tsx`.