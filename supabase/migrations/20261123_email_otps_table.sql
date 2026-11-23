-- Server-only storage for hashed Email OTPs with TTL and attempt tracking.
-- Protected with strict RLS: only Supabase service_role (backend server.ts) can access.
CREATE TABLE IF NOT EXISTS public.email_otps (
  email TEXT PRIMARY KEY,
  otp_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  phone TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_otps_expires_at
  ON public.email_otps (expires_at);

ALTER TABLE public.email_otps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only access on email_otps" ON public.email_otps;
CREATE POLICY "Service role only access on email_otps"
  ON public.email_otps
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
