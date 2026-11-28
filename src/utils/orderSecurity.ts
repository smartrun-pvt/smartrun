import crypto from "crypto";

export interface AuthoritativeItemResolutionInput {
  quantity: number;
  selectedColor?: string;
  product: {
    id: string;
    name?: string;
    price?: number;
    brand?: string;
    unit?: string;
    image?: string;
    selectedColor?: string;
    [key: string]: any;
  };
}

export interface ResolvedServerOrderItem {
  pricingItem: {
    quantity: number;
    product: {
      id: string;
      name: string;
      price: number;
      deliveryCharge: number;
      handlingCharge: number;
    };
  };
  formattedItem: {
    quantity: number;
    selectedColor?: string;
    color?: string;
    product: Record<string, any>;
  };
  unitPrice: number;
  lineTotal: number;
}

export type ResolveOrderItemsResult =
  | {
      ok: true;
      items: ResolvedServerOrderItem[];
      itemTotal: number;
    }
  | {
      ok: false;
      missingProductId: string;
      reason: string;
    };

/**
 * Safely parses `color_variants` (or fallback variant fields) from an authoritative
 * database/cached product record into an array of variant objects.
 */
export function parseProductColorVariants(dbProduct: Record<string, any> | null | undefined): any[] {
  if (!dbProduct || typeof dbProduct !== "object") return [];

  const rawCandidates = [
    dbProduct.color_variants,
    dbProduct.colorVariants,
    dbProduct.color_options,
    dbProduct.colorOptions,
  ];

  for (const candidate of rawCandidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim()) {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch {
        // Ignore malformed JSON string
      }
    }
  }

  return [];
}

function parseFiniteNonNegativePrice(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Resolves the authoritative unit price for a product from the database/cache record,
 * honoring a matching `color_variants` variant price when `selectedColor` is provided.
 * Never reads or trusts any client-supplied price.
 */
export function resolveServerUnitPrice(
  dbProduct: Record<string, any> | null | undefined,
  selectedColor?: string
): number | null {
  if (!dbProduct || typeof dbProduct !== "object") return null;

  const normalizedColor = String(selectedColor || "").trim().toLowerCase();
  if (normalizedColor) {
    const variants = parseProductColorVariants(dbProduct);
    for (const variant of variants) {
      if (!variant || typeof variant !== "object") continue;
      const variantKeys = [variant.color, variant.colour, variant.name, variant.label, variant.hex]
        .filter((v) => typeof v === "string" && v.trim().length > 0)
        .map((v) => String(v).trim().toLowerCase());

      if (variantKeys.includes(normalizedColor)) {
        const variantPrice = parseFiniteNonNegativePrice(variant.price);
        if (variantPrice !== null) {
          return variantPrice;
        }
      }
    }
  }

  return parseFiniteNonNegativePrice(dbProduct.price);
}

/**
 * Resolves all order items strictly against server-authoritative product records
 * (Supabase `products` table first, falling back to the server product cache).
 * Rejects the entire order if any product ID is missing or has no valid server price.
 */
export function resolveAuthoritativeOrderItems(
  clientItems: AuthoritativeItemResolutionInput[],
  dbProductsById: Map<string, Record<string, any>>,
  cachedProductsById: Map<string, Record<string, any>>
): ResolveOrderItemsResult {
  if (!Array.isArray(clientItems) || clientItems.length === 0) {
    return {
      ok: false,
      missingProductId: "",
      reason: "Order must contain at least 1 valid item.",
    };
  }

  const resolvedItems: ResolvedServerOrderItem[] = [];
  let itemTotal = 0;

  for (const item of clientItems) {
    const productId = String(item?.product?.id || "").trim();
    const quantity = Number(item?.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity <= 0 || quantity > 1000) {
      return {
        ok: false,
        missingProductId: productId,
        reason: `Invalid product or quantity for product ID "${productId || "unknown"}".`,
      };
    }

    const dbProduct = dbProductsById.get(productId) || cachedProductsById.get(productId);
    if (!dbProduct) {
      return {
        ok: false,
        missingProductId: productId,
        reason: `Product "${productId}" was not found in the catalog.`,
      };
    }

    const selectedColor = String(item.selectedColor || item.product?.selectedColor || "").trim() || undefined;
    const unitPrice = resolveServerUnitPrice(dbProduct, selectedColor);
    if (unitPrice === null) {
      return {
        ok: false,
        missingProductId: productId,
        reason: `Product "${productId}" does not have a valid server price.`,
      };
    }

    const baseName = String(dbProduct.name || item.product?.name || "Electrical Item").trim();
    const colorSuffix = selectedColor ? `(${selectedColor} Color)` : "";
    const displayName =
      selectedColor && !baseName.toLowerCase().includes(colorSuffix.toLowerCase())
        ? `${baseName} ${colorSuffix}`
        : baseName;
    const serverDeliveryCharge = parseFiniteNonNegativePrice(dbProduct.delivery_charge ?? dbProduct.deliveryCharge) ?? 0;
    const serverHandlingCharge = parseFiniteNonNegativePrice(dbProduct.handling_charge ?? dbProduct.handlingCharge) ?? 0;
    const lineTotal = unitPrice * quantity;
    itemTotal += lineTotal;

    const safeClientProduct: Record<string, any> =
      item.product && typeof item.product === "object" ? { ...item.product } : {};
    // Strip any client-supplied charge/price overrides before attaching server values
    delete safeClientProduct.deliveryCharge;
    delete safeClientProduct.delivery_charge;
    delete safeClientProduct.handlingCharge;
    delete safeClientProduct.handling_charge;

    resolvedItems.push({
      pricingItem: {
        quantity,
        product: {
          id: String(dbProduct.id),
          name: baseName,
          price: unitPrice,
          deliveryCharge: serverDeliveryCharge,
          handlingCharge: serverHandlingCharge,
        },
      },
      formattedItem: {
        quantity,
        selectedColor,
        color: selectedColor,
        product: {
          ...safeClientProduct,
          id: String(dbProduct.id),
          name: displayName,
          price: unitPrice,
          brand: dbProduct.brand ?? safeClientProduct.brand,
          unit: dbProduct.unit ?? safeClientProduct.unit,
          selectedColor,
        },
      },
      unitPrice,
      lineTotal,
    });
  }

  return {
    ok: true,
    items: resolvedItems,
    itemTotal,
  };
}

/**
 * Verifies Razorpay checkout signature using HMAC-SHA256 and constant-time comparison
 * (`crypto.timingSafeEqual`). Returns "paid" ONLY when paymentMethod is "upi" or "card"
 * AND razorpay_order_id, razorpay_payment_id, razorpay_signature, and RAZORPAY_KEY_SECRET
 * are present and cryptographically verified. Otherwise returns "pending".
 */
export function verifyRazorpayOrderPaymentStatus(params: {
  paymentMethod: string;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  razorpaySignature?: string | null;
  keySecret?: string | null;
}): "paid" | "pending" {
  const method = String(params.paymentMethod || "").trim().toLowerCase();
  if (method !== "upi" && method !== "card") {
    return "pending";
  }

  const orderId = String(params.razorpayOrderId || "").trim();
  const paymentId = String(params.razorpayPaymentId || "").trim();
  const signature = String(params.razorpaySignature || "").trim().toLowerCase();
  const secret = String(params.keySecret || "").trim();

  if (!orderId || !paymentId || !signature || !secret) {
    return "pending";
  }

  // SHA-256 hex digest is strictly 64 hex chars (32 bytes)
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    return "pending";
  }

  try {
    const expectedHex = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const expectedBuf = Buffer.from(expectedHex, "hex");
    const providedBuf = Buffer.from(signature, "hex");

    if (expectedBuf.length !== providedBuf.length) {
      return "pending";
    }

    return crypto.timingSafeEqual(expectedBuf, providedBuf) ? "paid" : "pending";
  } catch {
    return "pending";
  }
}

/**
 * Verifies Razorpay server-to-server webhook signature by computing HMAC-SHA256
 * over the exact raw request body Buffer (never JSON.stringify) using
 * RAZORPAY_WEBHOOK_SECRET and comparing digests with crypto.timingSafeEqual
 * after verifying equal buffer lengths.
 */
export function verifyRazorpayWebhookSignature(params: {
  rawBody: Buffer | string | null | undefined;
  signature: string | string[] | null | undefined;
  webhookSecret: string | null | undefined;
}): boolean {
  const secret = String(params.webhookSecret || "").trim();
  if (!secret) {
    return false;
  }

  if (typeof params.signature !== "string") {
    return false;
  }

  const providedSignature = params.signature.trim().toLowerCase();
  if (!providedSignature || !/^[a-f0-9]{64}$/.test(providedSignature)) {
    return false;
  }

  const rawBuf = Buffer.isBuffer(params.rawBody)
    ? params.rawBody
    : typeof params.rawBody === "string"
      ? Buffer.from(params.rawBody, "utf8")
      : null;

  if (!rawBuf || rawBuf.length === 0) {
    return false;
  }

  try {
    const expectedHex = crypto
      .createHmac("sha256", secret)
      .update(rawBuf)
      .digest("hex");

    const expectedBuf = Buffer.from(expectedHex, "hex");
    const providedBuf = Buffer.from(providedSignature, "hex");

    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

/**
 * Constant-time UTF-8 string comparison using crypto.timingSafeEqual
 * with an explicit equal-byte-length guard.
 */
export function timingSafeStringEqual(
  provided: string | string[] | null | undefined,
  expected: string | null | undefined
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") {
    return false;
  }
  const a = provided.trim();
  const b = expected.trim();
  if (!a || !b) {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Parses comma-separated ADMIN_EMAILS purely from environment configuration.
 * Never returns hardcoded personal emails.
 */
export function parseAdminEmailsEnv(rawValue: string | null | undefined): string[] {
  if (!rawValue || typeof rawValue !== "string") {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of rawValue.split(",")) {
    const clean = part.trim().toLowerCase();
    if (clean && clean.includes("@") && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

/**
 * Resolves the server-only HMAC secret for Email OTP hashing strictly from
 * API_SECRET_KEY or SESSION_SECRET. Returns null if neither is configured
 * (never falls back to any hardcoded secret).
 */
export function resolveEmailOtpSecret(env: Record<string, string | undefined>): string | null {
  const apiSecret = String(env.API_SECRET_KEY || "").trim().replace(/^['"]|['"]$/g, "");
  if (apiSecret) return apiSecret;
  const sessionSecret = String(env.SESSION_SECRET || "").trim().replace(/^['"]|['"]$/g, "");
  if (sessionSecret) return sessionSecret;
  return null;
}

/**
 * Computes a 64-char hex HMAC-SHA256 hash of an email OTP for server-side storage.
 */
export function computeEmailOtpHash(email: string, otp: string, secret: string): string {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanOtp = String(otp || "").trim();
  return crypto
    .createHmac("sha256", secret)
    .update(`email-otp:${cleanEmail}:${cleanOtp}`)
    .digest("hex");
}

/**
 * Constant-time verification of a user-submitted Email OTP against a server-stored HMAC hash.
 */
export function verifyEmailOtpHash(
  email: string,
  otp: string,
  storedHashHex: string | null | undefined,
  secret: string
): boolean {
  const providedHash = String(storedHashHex || "").trim().toLowerCase();
  if (!secret || !/^[a-f0-9]{64}$/.test(providedHash)) {
    return false;
  }
  const computedHex = computeEmailOtpHash(email, otp, secret);
  const expectedBuf = Buffer.from(computedHex, "hex");
  const storedBuf = Buffer.from(providedHash, "hex");
  if (expectedBuf.length !== storedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, storedBuf);
}

/**
 * Extracts all canonical user IDs belonging to an authenticated user
 * (primary authUser.id plus optional master_user_id and linked_user_id metadata).
 */
export function getAllowedUserIds(authUser: Record<string, any> | null | undefined): string[] {
  if (!authUser || typeof authUser !== "object") {
    return [];
  }
  const candidates = [
    authUser.id,
    authUser.user_metadata?.master_user_id,
    authUser.user_metadata?.linked_user_id,
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const val of candidates) {
    if (typeof val === "string" || typeof val === "number") {
      const clean = String(val).trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        result.push(clean);
      }
    }
  }
  return result;
}

/**
 * Validates numeric GPS coordinates strictly within Earth bounds
 * (latitude -90..90, longitude -180..180), rejecting booleans, empty strings, NaN, and Infinity.
 */
export function validateLatLng(
  lat: unknown,
  lng: unknown
): { valid: true; lat: number; lng: number } | { valid: false; message: string } {
  const isAcceptableScalar = (v: unknown) =>
    typeof v === "number" || (typeof v === "string" && v.trim() !== "");

  if (!isAcceptableScalar(lat) || !isAcceptableScalar(lng)) {
    return {
      valid: false,
      message: "Valid numeric latitude (-90 to 90) and longitude (-180 to 180) are required.",
    };
  }

  const numLat = Number(lat);
  const numLng = Number(lng);
  if (
    !Number.isFinite(numLat) ||
    !Number.isFinite(numLng) ||
    numLat < -90 ||
    numLat > 90 ||
    numLng < -180 ||
    numLng > 180
  ) {
    return {
      valid: false,
      message: "Valid numeric latitude (-90 to 90) and longitude (-180 to 180) are required.",
    };
  }

  return { valid: true, lat: numLat, lng: numLng };
}

/**
 * Safely merges a live GPS location update into an existing `delivery_partner`
 * JSON object so fields like `phone`, `vehicleNumber`, `rating`, and `currentHub`
 * are never overwritten or lost.
 */
export function mergeDeliveryPartnerLocation(
  existingPartner: unknown,
  locationRecord: {
    lat: number;
    lng: number;
    riderName?: string;
    partnerId?: string;
    heading?: number;
    speed?: number;
    updatedAt?: string;
    [key: string]: any;
  }
): Record<string, any> {
  const base: Record<string, any> =
    existingPartner && typeof existingPartner === "object" && !Array.isArray(existingPartner)
      ? { ...(existingPartner as Record<string, any>) }
      : {};

  const incomingName = typeof locationRecord.riderName === "string" ? locationRecord.riderName.trim() : "";
  const mergedName =
    (incomingName && incomingName !== "Delivery Partner" ? incomingName : base.name) ||
    incomingName ||
    "Delivery Partner";

  return {
    ...base,
    name: mergedName,
    lat: locationRecord.lat,
    lng: locationRecord.lng,
    current_location: locationRecord,
  };
}

/**
 * Parses an optional refund amount. Rejects booleans, non-numeric strings,
 * NaN, Infinity, zero, and negative numbers.
 */
export function parseOptionalRefundAmount(
  raw: unknown
): { ok: true; amount: number | undefined } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, amount: undefined };
  }
  if (typeof raw !== "number" && typeof raw !== "string") {
    return { ok: false, message: "Refund amount must be a valid positive number." };
  }
  if (typeof raw === "string" && raw.trim() === "") {
    return { ok: true, amount: undefined };
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, message: "Refund amount must be a valid positive number." };
  }
  return { ok: true, amount: num };
}

/**
 * Classifies whether a payment/order pair is explicitly a sandbox test payment.
 * If a real-looking paymentId is present (i.e. does NOT start with pay_test_ or test_),
 * it is NEVER classified as a test payment even if orderId starts with order_test_.
 */
export function isTestRefundPayment(
  paymentId?: string | null,
  orderId?: string | null
): boolean {
  const cleanPaymentId = typeof paymentId === "string" ? paymentId.trim() : "";
  const cleanOrderId = typeof orderId === "string" ? orderId.trim() : "";

  if (cleanPaymentId) {
    return cleanPaymentId.startsWith("pay_test_") || cleanPaymentId.startsWith("test_");
  }
  return cleanOrderId.startsWith("order_test_");
}

/**
 * Determines whether a simulated refund is permitted.
 * Simulated refunds are strictly forbidden in production (NODE_ENV === "production")
 * and when live Razorpay keys (rzp_live_*) are active, or for real-looking payment IDs.
 */
export function isSimulatedRefundAllowed(params: {
  nodeEnv?: string | null;
  isTestPayment: boolean;
  razorpayKeyId?: string | null;
}): boolean {
  const env = String(params.nodeEnv || "").trim().toLowerCase();
  if (env === "production") {
    return false;
  }
  const keyId = String(params.razorpayKeyId || "").trim();
  if (keyId.startsWith("rzp_live_")) {
    return false;
  }
  return Boolean(params.isTestPayment);
}

/**
 * Validates a non-admin refund request against the authoritative Supabase order row:
 * - Order must exist (404)
 * - Order user_id must match authUser.id (or master_user_id / linked_user_id) (403)
 * - Order payment_id (or razorpay_payment_id fallback if payment_id is unset) must match paymentId (403)
 * - Requested amount (if provided) must not exceed order.total_amount (400)
 */
export function validateNonAdminRefundRequest(params: {
  order: Record<string, any> | null | undefined;
  authUser: Record<string, any> | null | undefined;
  paymentId: string;
  requestedAmount?: number;
}):
  | { ok: true; effectiveAmount: number; orderTotal: number }
  | { ok: false; status: number; message: string } {
  if (!params.order || typeof params.order !== "object") {
    return { ok: false, status: 404, message: "Order not found." };
  }

  const allowedUserIds = getAllowedUserIds(params.authUser);
  const orderOwnerId =
    params.order.user_id !== undefined && params.order.user_id !== null
      ? String(params.order.user_id).trim()
      : "";

  if (!orderOwnerId || !allowedUserIds.includes(orderOwnerId)) {
    return {
      ok: false,
      status: 403,
      message: "Forbidden: You do not own this order.",
    };
  }

  const cleanRequestedPaymentId = String(params.paymentId || "").trim();
  const primaryStoredPaymentId =
    params.order.payment_id !== undefined && params.order.payment_id !== null
      ? String(params.order.payment_id).trim()
      : "";
  const fallbackStoredPaymentId =
    params.order.razorpay_payment_id !== undefined && params.order.razorpay_payment_id !== null
      ? String(params.order.razorpay_payment_id).trim()
      : "";
  const authoritativePaymentId = primaryStoredPaymentId || fallbackStoredPaymentId;

  if (!cleanRequestedPaymentId || !authoritativePaymentId || authoritativePaymentId !== cleanRequestedPaymentId) {
    return {
      ok: false,
      status: 403,
      message: "Payment ID does not match the recorded payment for this order.",
    };
  }

  const orderTotal = Number(params.order.total_amount);
  if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
    return {
      ok: false,
      status: 400,
      message: "Order total is invalid for refund processing.",
    };
  }

  if (params.requestedAmount !== undefined) {
    if (!Number.isFinite(params.requestedAmount) || params.requestedAmount <= 0) {
      return {
        ok: false,
        status: 400,
        message: "Refund amount must be a positive number.",
      };
    }
    if (
      params.requestedAmount > orderTotal ||
      Math.round(params.requestedAmount * 100) > Math.round(orderTotal * 100)
    ) {
      return {
        ok: false,
        status: 400,
        message: "Refund amount cannot exceed the order total.",
      };
    }
    return { ok: true, effectiveAmount: params.requestedAmount, orderTotal };
  }

  return { ok: true, effectiveAmount: orderTotal, orderTotal };
}

/**
 * Normalizes cart items from request bodies (supporting both nested `{ product: { id }, quantity, selectedColor }`
 * and flat `{ productId / id, quantity, selectedColor }` shapes) for authoritative server pricing.
 * Strips client price/fee fields so pricing always comes from the server catalog.
 */
export function normalizeCartItemsForPricing(rawItems: unknown): AuthoritativeItemResolutionInput[] {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const normalized: AuthoritativeItemResolutionInput[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const item = entry as Record<string, any>;
    const nestedProduct =
      item.product && typeof item.product === "object" && !Array.isArray(item.product)
        ? (item.product as Record<string, any>)
        : null;

    const productId = String(nestedProduct?.id ?? item.productId ?? item.id ?? "").trim();
    const quantity = Number(item.quantity);
    const selectedColorRaw =
      item.selectedColor ?? item.color ?? nestedProduct?.selectedColor ?? nestedProduct?.color;
    const selectedColor =
      typeof selectedColorRaw === "string" && selectedColorRaw.trim()
        ? selectedColorRaw.trim()
        : undefined;

    if (!productId || !Number.isInteger(quantity) || quantity <= 0 || quantity > 1000) {
      return [];
    }

    normalized.push({
      quantity,
      selectedColor,
      product: {
        id: productId,
        selectedColor,
      },
    });
  }

  return normalized;
}

/**
 * Verifies a Razorpay order object returned by `razorpay.orders.fetch(razorpayOrderId)`
 * against the server-computed grand total in paise:
 * - `order.amount === expectedAmountInPaise`
 * - `order.currency === "INR"`
 * - `order.amount_paid >= order.amount`
 */
export function verifyFetchedRazorpayOrder(params: {
  fetchedOrder: Record<string, any> | null | undefined;
  expectedAmountInPaise: number;
}): { ok: true } | { ok: false; reason: string } {
  const { fetchedOrder, expectedAmountInPaise } = params;

  if (!Number.isInteger(expectedAmountInPaise) || expectedAmountInPaise <= 0) {
    return {
      ok: false,
      reason: "Invalid server-computed order amount for payment verification.",
    };
  }

  if (!fetchedOrder || typeof fetchedOrder !== "object") {
    return {
      ok: false,
      reason: "Unable to retrieve Razorpay order details for payment verification.",
    };
  }

  const orderAmount = Number(fetchedOrder.amount);
  const amountPaid = Number(fetchedOrder.amount_paid);
  const currency = String(fetchedOrder.currency || "").trim().toUpperCase();

  if (!Number.isFinite(orderAmount) || orderAmount !== expectedAmountInPaise) {
    return {
      ok: false,
      reason: `Payment amount mismatch: Razorpay order amount (${Number.isFinite(orderAmount) ? orderAmount : "invalid"} paise) does not match server order total (${expectedAmountInPaise} paise).`,
    };
  }

  if (currency !== "INR") {
    return {
      ok: false,
      reason: `Payment currency mismatch: expected INR, received "${currency || "unknown"}".`,
    };
  }

  if (!Number.isFinite(amountPaid) || amountPaid < orderAmount) {
    return {
      ok: false,
      reason: `Payment incomplete: Razorpay order amount_paid (${Number.isFinite(amountPaid) ? amountPaid : 0} paise) is less than required amount (${orderAmount} paise).`,
    };
  }

  return { ok: true };
}

/**
 * Sanitizes optional Razorpay order notes from client input and unconditionally
 * attaches the authenticated user ID so callers cannot spoof ownership in notes.
 */
export function sanitizeRazorpayOrderNotes(
  rawNotes: unknown,
  authenticatedUserId: string
): Record<string, string> {
  const safeNotes: Record<string, string> = {};
  if (rawNotes && typeof rawNotes === "object" && !Array.isArray(rawNotes)) {
    let count = 0;
    for (const [k, v] of Object.entries(rawNotes as Record<string, unknown>)) {
      if (count >= 10) break;
      const key = String(k || "").trim().slice(0, 64);
      if (!key || key === "userId" || key === "user_id") continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        safeNotes[key] = String(v).trim().slice(0, 256);
        count++;
      }
    }
  }
  const cleanUserId = String(authenticatedUserId || "").trim();
  safeNotes.userId = cleanUserId;
  safeNotes.user_id = cleanUserId;
  return safeNotes;
}

export type WebhookOrderUpdateDecision =
  | {
      action: "update";
      setStatusAccepted: boolean;
      requirePendingStatus: boolean;
    }
  | {
      action: "skip";
      reason: string;
    };

/**
 * Evaluates whether a verified Razorpay `payment.captured` / `order.paid` webhook
 * should update a local Supabase order row:
 * - Compares `paymentEntity.amount` (paise) against `Math.round(order.total_amount * 100)`; skips on mismatch.
 * - Requires `order.payment_status === "pending"`; skips if already paid/refunded/etc.
 * - Never modifies `cancelled` or `delivered` orders.
 * - Only sets `status = "accepted"` when current `order.status === "pending"`.
 */
export function evaluateRazorpayWebhookOrderUpdate(params: {
  existingOrder: {
    status?: string | null;
    payment_status?: string | null;
    total_amount?: number | string | null;
  } | null | undefined;
  paymentAmountPaise: unknown;
}): WebhookOrderUpdateDecision {
  const { existingOrder, paymentAmountPaise } = params;
  if (!existingOrder || typeof existingOrder !== "object") {
    return { action: "skip", reason: "Order not found for razorpay_order_id." };
  }

  const orderTotalRupees = Number(existingOrder.total_amount);
  const expectedPaise = Number.isFinite(orderTotalRupees) ? Math.round(orderTotalRupees * 100) : NaN;
  const actualPaise =
    typeof paymentAmountPaise === "number" ||
    (typeof paymentAmountPaise === "string" && paymentAmountPaise.trim() !== "")
      ? Number(paymentAmountPaise)
      : NaN;

  if (!Number.isFinite(expectedPaise) || expectedPaise <= 0 || !Number.isFinite(actualPaise)) {
    return {
      action: "skip",
      reason: `Invalid webhook or order amount (paymentEntity.amount=${String(paymentAmountPaise)}, total_amount=${String(existingOrder.total_amount)}).`,
    };
  }

  if (actualPaise !== expectedPaise) {
    return {
      action: "skip",
      reason: `Webhook payment amount mismatch: paymentEntity.amount (${actualPaise} paise) does not match order total_amount * 100 (${expectedPaise} paise).`,
    };
  }

  const currentPaymentStatus = String(existingOrder.payment_status || "").trim().toLowerCase();
  if (currentPaymentStatus !== "pending") {
    return {
      action: "skip",
      reason: `Order payment_status is "${currentPaymentStatus || "unknown"}" (not "pending"); skipping update.`,
    };
  }

  const currentStatus = String(existingOrder.status || "").trim().toLowerCase();
  if (currentStatus === "cancelled" || currentStatus === "delivered") {
    return {
      action: "skip",
      reason: `Order status is "${currentStatus}"; terminal orders must never be modified by payment webhooks.`,
    };
  }

  const isPendingStatus = currentStatus === "pending";
  return {
    action: "update",
    setStatusAccepted: isPendingStatus,
    requirePendingStatus: isPendingStatus,
  };
}

export type AtomicOtpVerifyOutcome =
  | { status: 200; verified: true; clearOtp: true; message: string }
  | { status: 400; verified: false; clearOtp: boolean; error: string }
  | { status: 429; verified: false; clearOtp: true; error: string };

/**
 * Decides the HTTP outcome for `/api/auth/verify-email-otp` strictly from the
 * result of the atomic attempt increment (`attempts` returned by the DB RPC or
 * synchronous in-memory fallback) and the constant-time hash verification result.
 */
export function decideEmailOtpVerificationOutcome(params: {
  found: boolean;
  limitReached: boolean;
  attemptsAfterIncrement: number;
  maxAttempts: number;
  isHashValid: boolean;
}): AtomicOtpVerifyOutcome {
  if (!params.found) {
    return {
      status: 400,
      verified: false,
      clearOtp: false,
      error: "No active verification code found or code expired. Please request a new OTP.",
    };
  }

  if (params.limitReached || params.attemptsAfterIncrement > params.maxAttempts) {
    return {
      status: 429,
      verified: false,
      clearOtp: true,
      error: "Too many invalid attempts. Please request a new OTP code.",
    };
  }

  if (params.isHashValid) {
    return {
      status: 200,
      verified: true,
      clearOtp: true,
      message: "Email verification code verified successfully.",
    };
  }

  if (params.attemptsAfterIncrement >= params.maxAttempts) {
    return {
      status: 429,
      verified: false,
      clearOtp: true,
      error: "Too many invalid attempts. Please request a new OTP code.",
    };
  }

  return {
    status: 400,
    verified: false,
    clearOtp: false,
    error: "Incorrect verification code. Please check the code sent to your email.",
  };
}

/**
 * Extracts the trusted client IP from Express `req.ip` (computed by Express using
 * `app.set("trust proxy", 1)`). Never reads the spoofable first `x-forwarded-for` entry.
 */
export function resolveTrustedClientIp(req: {
  ip?: string | null;
  socket?: { remoteAddress?: string | null } | null;
}): string {
  const expressIp = typeof req?.ip === "string" ? req.ip.trim() : "";
  if (expressIp) {
    return expressIp;
  }
  const socketIp =
    typeof req?.socket?.remoteAddress === "string" ? req.socket.remoteAddress.trim() : "";
  return socketIp || "127.0.0.1";
}

/**
 * Resolves `SERVER_AUTH_SECRET` from `SESSION_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, or
 * `JWT_SECRET`. Fails fast at startup in production when all three are unset so every
 * Cloud Run instance shares the exact same signing key instead of ephemeral random bytes.
 */
export function resolveServerAuthSecret(
  env: Record<string, string | undefined> = process.env
): string {
  const configured =
    String(env.SESSION_SECRET || "").trim() ||
    String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim() ||
    String(env.JWT_SECRET || "").trim();

  if (configured) {
    return configured;
  }

  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  if (nodeEnv === "production" || nodeEnv === "prod") {
    throw new Error(
      "[Security Startup Error] SERVER_AUTH_SECRET cannot start in production without SESSION_SECRET, SUPABASE_SERVICE_ROLE_KEY, or JWT_SECRET configured."
    );
  }

  return crypto.randomBytes(32).toString("hex");
}




