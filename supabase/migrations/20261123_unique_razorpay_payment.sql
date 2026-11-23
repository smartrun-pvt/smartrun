-- Prevent Razorpay payment replay attacks across different orders.
-- Enforces uniqueness on non-null razorpay_payment_id values in public.orders.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique_razorpay_payment_id
  ON public.orders (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;
