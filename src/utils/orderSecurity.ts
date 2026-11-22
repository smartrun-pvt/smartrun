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
