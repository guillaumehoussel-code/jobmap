-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- 1) Create public.jobs table
CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source text,
  source_id text,
  title text,
  company text,
  city text,
  salary_min int,
  salary_max int,
  url text,
  description text,
  posted_at timestamptz,
  remote boolean DEFAULT false,
  lat double precision,
  lon double precision,
  geom geography(Point,4326),
  uniq_hash text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2) Trigger function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON public.jobs;
CREATE TRIGGER trg_jobs_updated_at
BEFORE UPDATE ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- 3) Trigger function to set geom from lat/lon on insert/update
CREATE OR REPLACE FUNCTION public.set_geom_from_latlon()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- If lat and lon are present, set geom; if not, leave geom NULL
  IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
  ELSE
    NEW.geom := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_set_geom ON public.jobs;
CREATE TRIGGER trg_jobs_set_geom
BEFORE INSERT OR UPDATE ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.set_geom_from_latlon();

-- 4) Optional trigger to populate uniq_hash if empty (ensures uniqueness)
CREATE OR REPLACE FUNCTION public.ensure_uniq_hash()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.uniq_hash IS NULL OR length(trim(NEW.uniq_hash)) = 0 THEN
    -- uniq by title|company|city|posted_at (use lower + md5)
    NEW.uniq_hash := md5(lower(coalesce(NEW.title, '') || '|' || coalesce(NEW.company, '') || '|' || coalesce(NEW.city, '') || '|' || coalesce(NEW.posted_at::text, '')));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_ensure_uniq_hash ON public.jobs;
CREATE TRIGGER trg_jobs_ensure_uniq_hash
BEFORE INSERT ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION public.ensure_uniq_hash();

-- 5) GiST index on geom for fast spatial queries
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'idx_jobs_geom_gist' AND n.nspname = 'public'
  ) THEN
    CREATE INDEX idx_jobs_geom_gist ON public.jobs USING GIST (geom);
  END IF;
END
$$;

-- 6) Create public.geocode_cache table
CREATE TABLE IF NOT EXISTS public.geocode_cache (
  key text PRIMARY KEY,
  lat double precision,
  lon double precision,
  geom geography(Point,4326),
  created_at timestamptz DEFAULT now()
);

-- Trigger to set geom in geocode_cache from lat/lon
CREATE OR REPLACE FUNCTION public.set_geocode_geom()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lon IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326)::geography;
  ELSE
    NEW.geom := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_geocode_set_geom ON public.geocode_cache;
CREATE TRIGGER trg_geocode_set_geom
BEFORE INSERT OR UPDATE ON public.geocode_cache
FOR EACH ROW
EXECUTE FUNCTION public.set_geocode_geom();

-- GiST index on geocode_cache.geom
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'idx_geocode_geom_gist' AND n.nspname = 'public'
  ) THEN
    CREATE INDEX idx_geocode_geom_gist ON public.geocode_cache USING GIST (geom);
  END IF;
END
$$;

-- 7) RPC function jobs_within_km(lat, lon, km, q text default NULL, city_q text default NULL)
-- Returns rows from public.jobs that have geom set and are within km kilometers of the provided point.
-- Uses ST_DWithin for fast spatial search and orders by distance then posted_at desc.
CREATE OR REPLACE FUNCTION public.jobs_within_km(
  in_lat double precision,
  in_lon double precision,
  in_km double precision,
  q text DEFAULT NULL,
  city_q text DEFAULT NULL,
  limit_rows integer DEFAULT 100
)
RETURNS TABLE (
  id uuid,
  source text,
  source_id text,
  title text,
  company text,
  city text,
  salary_min int,
  salary_max int,
  url text,
  description text,
  posted_at timestamptz,
  remote boolean,
  lat double precision,
  lon double precision,
  geom geography,
  uniq_hash text,
  created_at timestamptz,
  updated_at timestamptz,
  distance_m double precision
)
LANGUAGE plpgsql AS
$$
BEGIN
  RETURN QUERY
  SELECT
    j.id,
    j.source,
    j.source_id,
    j.title,
    j.company,
    j.city,
    j.salary_min,
    j.salary_max,
    j.url,
    j.description,
    j.posted_at,
    j.remote,
    j.lat,
    j.lon,
    j.geom,
    j.uniq_hash,
    j.created_at,
    j.updated_at,
    ST_Distance(j.geom, ST_SetSRID(ST_MakePoint(in_lon, in_lat), 4326)::geography) AS distance_m
  FROM public.jobs j
  WHERE j.geom IS NOT NULL
    AND ST_DWithin(j.geom, ST_SetSRID(ST_MakePoint(in_lon, in_lat), 4326)::geography, in_km * 1000)
    AND (
      q IS NULL OR (
        (j.title ILIKE ('%' || q || '%')) OR
        (j.company ILIKE ('%' || q || '%')) OR
        (j.description ILIKE ('%' || q || '%'))
      )
    )
    AND (
      city_q IS NULL OR j.city ILIKE ('%' || city_q || '%')
    )
  ORDER BY distance_m ASC, COALESCE(j.posted_at, j.created_at) DESC
  LIMIT LEAST(GREATEST(limit_rows, 1), 1000);
END;
$$;

-- Grant execute on RPC to authenticated/anon as needed (uncomment and adjust roles)
-- GRANT EXECUTE ON FUNCTION public.jobs_within_km(double precision, double precision, double precision, text, text, integer) TO postgres;
-- GRANT SELECT ON public.jobs TO anon;
-- GRANT SELECT ON public.geocode_cache TO anon;

-- Helpful note: ensure uniqueness on uniq_hash before bulk inserts:
-- You can insert with ON CONFLICT (uniq_hash) DO NOTHING to avoid duplicates.