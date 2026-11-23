-- Atomically increment Email OTP verification attempts only while attempts < p_max_attempts
-- and the OTP has not expired. Eliminates read-then-update race conditions under concurrent requests.

CREATE OR REPLACE FUNCTION public.increment_email_otp_attempts(
  p_email TEXT,
  p_max_attempts INTEGER DEFAULT 5
)
RETURNS TABLE (
  otp_hash TEXT,
  expires_at TIMESTAMPTZ,
  attempts INTEGER,
  limit_reached BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clean_email TEXT := LOWER(TRIM(COALESCE(p_email, '')));
  v_row public.email_otps%ROWTYPE;
BEGIN
  -- Single atomic UPDATE: increments attempts only while attempts < p_max_attempts and unexpired
  UPDATE public.email_otps
  SET
    attempts = public.email_otps.attempts + 1,
    updated_at = NOW()
  WHERE public.email_otps.email = v_clean_email
    AND public.email_otps.attempts < p_max_attempts
    AND public.email_otps.expires_at > NOW()
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN QUERY SELECT v_row.otp_hash, v_row.expires_at, v_row.attempts, FALSE;
    RETURN;
  END IF;

  -- Check if row exists and has already exhausted attempts
  SELECT * INTO v_row
  FROM public.email_otps
  WHERE public.email_otps.email = v_clean_email;

  IF FOUND AND v_row.expires_at > NOW() AND v_row.attempts >= p_max_attempts THEN
    DELETE FROM public.email_otps WHERE public.email_otps.email = v_clean_email;
    RETURN QUERY SELECT NULL::TEXT, v_row.expires_at, v_row.attempts, TRUE;
    RETURN;
  END IF;

  -- Clean up expired row if present
  IF FOUND AND v_row.expires_at <= NOW() THEN
    DELETE FROM public.email_otps WHERE public.email_otps.email = v_clean_email;
  END IF;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_email_otp_attempts(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_email_otp_attempts(TEXT, INTEGER) TO service_role;
