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

