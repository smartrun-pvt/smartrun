import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  parseProductColorVariants,
  resolveServerUnitPrice,
  resolveAuthoritativeOrderItems,
  verifyRazorpayOrderPaymentStatus,
  verifyRazorpayWebhookSignature,
  timingSafeStringEqual,
  parseAdminEmailsEnv,
  resolveEmailOtpSecret,
  computeEmailOtpHash,
  verifyEmailOtpHash,
  getAllowedUserIds,
  validateLatLng,
  mergeDeliveryPartnerLocation,
  parseOptionalRefundAmount,
  isTestRefundPayment,
  isSimulatedRefundAllowed,
  validateNonAdminRefundRequest,
  normalizeCartItemsForPricing,
  verifyFetchedRazorpayOrder,
  sanitizeRazorpayOrderNotes,
  evaluateRazorpayWebhookOrderUpdate,
  decideEmailOtpVerificationOutcome,
} from "./orderSecurity";

test("resolveAuthoritativeOrderItems ignores tampered client prices and uses DB product price", () => {
  const dbMap = new Map<string, Record<string, any>>([
    [
      "prod-wire-1",
      {
        id: "prod-wire-1",
        name: "Polycab 1.5 sq.mm FR Wire",
        brand: "Polycab",
        unit: "90m Coil",
        price: 1650,
        delivery_charge: 25,
        handling_charge: 10,
      },
    ],
  ]);

  const result = resolveAuthoritativeOrderItems(
    [
      {
        quantity: 2,
        product: {
          id: "prod-wire-1",
          name: "Tampered Name",
          price: 1, // Client tried to spoof ₹1
          deliveryCharge: 0,
          handlingCharge: 0,
        },
      },
    ],
    dbMap,
    new Map()
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.itemTotal, 3300);
  assert.equal(result.items[0].unitPrice, 1650);
  assert.equal(result.items[0].pricingItem.product.price, 1650);
  assert.equal(result.items[0].pricingItem.product.deliveryCharge, 25);
  assert.equal(result.items[0].pricingItem.product.handlingCharge, 10);
  assert.equal(result.items[0].formattedItem.product.price, 1650);
  assert.equal(result.items[0].formattedItem.product.name, "Polycab 1.5 sq.mm FR Wire");
  assert.equal((result.items[0].formattedItem.product as any).deliveryCharge, undefined);
});

test("resolveServerUnitPrice honors matching color_variants price (array & JSON string) and falls back to base price", () => {
  const productWithArrayVariants = {
    id: "prod-wire-2",
    price: 1500,
    color_variants: [
      { color: "Red", price: 1650, mrp: 2100 },
      { color: "Black", price: 1600, mrp: 2050 },
      { color: "Green" }, // No variant price -> should fall back to base price
    ],
  };

  assert.equal(resolveServerUnitPrice(productWithArrayVariants, "red"), 1650);
  assert.equal(resolveServerUnitPrice(productWithArrayVariants, "Black"), 1600);
  assert.equal(resolveServerUnitPrice(productWithArrayVariants, "Green"), 1500);
  assert.equal(resolveServerUnitPrice(productWithArrayVariants, "Blue"), 1500);
  assert.equal(resolveServerUnitPrice(productWithArrayVariants, undefined), 1500);

  const productWithJsonStringVariants = {
    id: "prod-wire-3",
    price: 1400,
    color_variants: JSON.stringify([{ colour: "Yellow", price: 1525 }]),
  };

  assert.equal(parseProductColorVariants(productWithJsonStringVariants).length, 1);
  assert.equal(resolveServerUnitPrice(productWithJsonStringVariants, "YELLOW"), 1525);
});

test("resolveAuthoritativeOrderItems falls back to server product cache when DB lacks the item, but prioritizes DB", () => {
  const dbMap = new Map<string, Record<string, any>>([
    ["p1", { id: "p1", name: "DB Item", price: 500 }],
  ]);
  const cacheMap = new Map<string, Record<string, any>>([
    ["p1", { id: "p1", name: "Stale Cache Item", price: 400 }],
    ["p2", { id: "p2", name: "Cached Switch", price: 120 }],
  ]);

  const result = resolveAuthoritativeOrderItems(
    [
      { quantity: 1, product: { id: "p1", price: 1 } },
      { quantity: 3, product: { id: "p2", price: 1 } },
    ],
    dbMap,
    cacheMap
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.items[0].unitPrice, 500);
  assert.equal(result.items[1].unitPrice, 120);
  assert.equal(result.itemTotal, 860);
});

test("resolveAuthoritativeOrderItems rejects missing products or invalid server prices", () => {
  const dbMap = new Map<string, Record<string, any>>([
    ["p-valid", { id: "p-valid", name: "Valid Item", price: 200 }],
    ["p-broken", { id: "p-broken", name: "Corrupt Item", price: -50 }],
  ]);

  const missingResult = resolveAuthoritativeOrderItems(
    [
      { quantity: 1, product: { id: "p-valid", price: 200 } },
      { quantity: 1, product: { id: "p-ghost", price: 1 } },
    ],
    dbMap,
    new Map()
  );

  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) {
    assert.equal(missingResult.missingProductId, "p-ghost");
  }

  const corruptPriceResult = resolveAuthoritativeOrderItems(
    [{ quantity: 1, product: { id: "p-broken", price: 100 } }],
    dbMap,
    new Map()
  );

  assert.equal(corruptPriceResult.ok, false);
});

test("verifyRazorpayOrderPaymentStatus returns 'paid' ONLY for verified upi/card HMAC-SHA256 signatures", () => {
  const secret = "rzp_test_super_secret_key_12345";
  const orderId = "order_Q1a2B3c4D5";
  const paymentId = "pay_Z9y8X7w6V5";
  const validSig = crypto
    .createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  // Valid UPI & Card
  assert.equal(
    verifyRazorpayOrderPaymentStatus({
      paymentMethod: "upi",
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: validSig,
      keySecret: secret,
    }),
    "paid"
  );

  assert.equal(
    verifyRazorpayOrderPaymentStatus({
      paymentMethod: "card",
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: validSig.toUpperCase(),
      keySecret: secret,
    }),
    "paid"
  );

  // COD must NEVER be marked paid even with valid Razorpay fields
  assert.equal(
    verifyRazorpayOrderPaymentStatus({
      paymentMethod: "cod",
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: validSig,
      keySecret: secret,
    }),
    "pending"
  );

  // Tampered signature (single hex char altered)
  const tamperedSig = (validSig[0] === "a" ? "b" : "a") + validSig.slice(1);
  assert.equal(
    verifyRazorpayOrderPaymentStatus({
      paymentMethod: "upi",
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: tamperedSig,
      keySecret: secret,
    }),
    "pending"
  );

  // Wrong length / non-hex / missing inputs / missing secret
  assert.equal(
    verifyRazorpayOrderPaymentStatus({
      paymentMethod: "upi",
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: "not-a-valid-hex-signature",
      keySecret: secret,
    }),
    "pending"
  );

  assert.equal(
    verifyRazorpayOrderPaymentStatus({
      paymentMethod: "upi",
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: validSig,
      keySecret: "",
    }),
    "pending"
  );

  assert.equal(
    verifyRazorpayOrderPaymentStatus({
      paymentMethod: "card",
      razorpayOrderId: null,
      razorpayPaymentId: paymentId,
      razorpaySignature: validSig,
      keySecret: secret,
    }),
    "pending"
  );
});

test("verifyRazorpayWebhookSignature verifies exact rawBody bytes using HMAC-SHA256 and rejects missing/tampered inputs", () => {
  const webhookSecret = "whsec_live_test_secret_987654";
  // Pretty-printed JSON with extra spaces & key ordering that JSON.stringify(req.body) would alter
  const rawPayloadStr = '{\n  "event": "payment.captured",\n  "payload": { "payment": { "entity": { "id": "pay_123", "order_id": "order_456" } } }\n}';
  const rawBody = Buffer.from(rawPayloadStr, "utf8");
  const validSig = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  // Matches exact rawBody buffer (even when JSON.stringify would produce different bytes)
  const reserializedSig = crypto
    .createHmac("sha256", webhookSecret)
    .update(JSON.stringify(JSON.parse(rawPayloadStr)))
    .digest("hex");
  assert.notEqual(validSig, reserializedSig);

  assert.equal(
    verifyRazorpayWebhookSignature({
      rawBody,
      signature: validSig,
      webhookSecret,
    }),
    true
  );

  // Uppercase hex signature still validates cleanly
  assert.equal(
    verifyRazorpayWebhookSignature({
      rawBody,
      signature: validSig.toUpperCase(),
      webhookSecret,
    }),
    true
  );

  // Signature computed over JSON.stringify(parsed) MUST fail against rawBody
  assert.equal(
    verifyRazorpayWebhookSignature({
      rawBody,
      signature: reserializedSig,
      webhookSecret,
    }),
    false
  );

  // Tampered single char fails
  const tamperedSig = (validSig[0] === "0" ? "1" : "0") + validSig.slice(1);
  assert.equal(
    verifyRazorpayWebhookSignature({
      rawBody,
      signature: tamperedSig,
      webhookSecret,
    }),
    false
  );

  // Missing secret, missing signature, array header, wrong length, or empty rawBody all fail
  assert.equal(
    verifyRazorpayWebhookSignature({ rawBody, signature: validSig, webhookSecret: "" }),
    false
  );
  assert.equal(
    verifyRazorpayWebhookSignature({ rawBody, signature: undefined, webhookSecret }),
    false
  );
  assert.equal(
    verifyRazorpayWebhookSignature({ rawBody, signature: [validSig], webhookSecret }),
    false
  );
  assert.equal(
    verifyRazorpayWebhookSignature({ rawBody, signature: "shorthex", webhookSecret }),
    false
  );
  assert.equal(
    verifyRazorpayWebhookSignature({ rawBody: Buffer.alloc(0), signature: validSig, webhookSecret }),
    false
  );
});

test("timingSafeStringEqual compares secrets in constant time with length and type guards", () => {
  assert.equal(timingSafeStringEqual("my-super-secret", "my-super-secret"), true);
  assert.equal(timingSafeStringEqual("my-super-secre1", "my-super-secret"), false);
  assert.equal(timingSafeStringEqual("short", "my-super-secret"), false);
  assert.equal(timingSafeStringEqual("", ""), false);
  assert.equal(timingSafeStringEqual(["my-super-secret"], "my-super-secret"), false);
  assert.equal(timingSafeStringEqual(undefined, "my-super-secret"), false);
});

test("parseAdminEmailsEnv parses comma-separated env emails with zero hardcoded defaults", () => {
  assert.deepEqual(parseAdminEmailsEnv(undefined), []);
  assert.deepEqual(parseAdminEmailsEnv(""), []);
  assert.deepEqual(
    parseAdminEmailsEnv(" Ops@SmartRun.in , alerts@smartrun.in, ops@smartrun.in, not-an-email "),
    ["ops@smartrun.in", "alerts@smartrun.in"]
  );
});

test("resolveEmailOtpSecret requires API_SECRET_KEY or SESSION_SECRET with no hardcoded fallback", () => {
  assert.equal(resolveEmailOtpSecret({}), null);
  assert.equal(resolveEmailOtpSecret({ API_SECRET_KEY: "   ", SESSION_SECRET: "" }), null);
  assert.equal(resolveEmailOtpSecret({ SESSION_SECRET: "sess_123" }), "sess_123");
  assert.equal(
    resolveEmailOtpSecret({ API_SECRET_KEY: "api_999", SESSION_SECRET: "sess_123" }),
    "api_999"
  );
});

test("computeEmailOtpHash and verifyEmailOtpHash verify server-side OTP hashes safely", () => {
  const secret = "server_only_hmac_secret_2026";
  const hash = computeEmailOtpHash("User@Example.com", "482913", secret);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes("482913"), false);

  assert.equal(verifyEmailOtpHash("user@example.com", "482913", hash, secret), true);
  assert.equal(verifyEmailOtpHash("user@example.com", "482914", hash, secret), false);
  assert.equal(verifyEmailOtpHash("other@example.com", "482913", hash, secret), false);
  assert.equal(verifyEmailOtpHash("user@example.com", "482913", hash, "wrong_secret"), false);
  assert.equal(verifyEmailOtpHash("user@example.com", "482913", "not-hex", secret), false);
});

test("getAllowedUserIds collects id, master_user_id, and linked_user_id deduplicated", () => {
  assert.deepEqual(getAllowedUserIds(null), []);
  assert.deepEqual(
    getAllowedUserIds({
      id: "uid-primary",
      user_metadata: {
        master_user_id: "uid-master",
        linked_user_id: "uid-primary",
      },
    }),
    ["uid-primary", "uid-master"]
  );
});

test("validateLatLng accepts valid Earth coordinates and rejects out-of-range or non-numeric values", () => {
  assert.deepEqual(validateLatLng(22.5179, 88.3834), { valid: true, lat: 22.5179, lng: 88.3834 });
  assert.deepEqual(validateLatLng("-90", "180"), { valid: true, lat: -90, lng: 180 });
  assert.equal(validateLatLng(91, 88.38).valid, false);
  assert.equal(validateLatLng(-90.1, 88.38).valid, false);
  assert.equal(validateLatLng(22.5, 181).valid, false);
  assert.equal(validateLatLng(22.5, -180.5).valid, false);
  assert.equal(validateLatLng(NaN, 88.38).valid, false);
  assert.equal(validateLatLng(Infinity, 88.38).valid, false);
  assert.equal(validateLatLng("", 88.38).valid, false);
  assert.equal(validateLatLng(true, 88.38).valid, false);
});

test("mergeDeliveryPartnerLocation preserves phone, vehicleNumber, and existing rider metadata", () => {
  const existing = {
    name: "Ramesh Das",
    phone: "+91 98300 11223",
    vehicleNumber: "WB 02 AR 4491",
    rating: 4.9,
    currentHub: "Kasba Warehouse",
  };
  const gpsRecord = {
    orderId: "ord-1",
    lat: 22.52,
    lng: 88.39,
    riderName: "Delivery Partner",
    updatedAt: "2026-11-23T12:00:00.000Z",
  };

  const merged = mergeDeliveryPartnerLocation(existing, gpsRecord);
  assert.equal(merged.name, "Ramesh Das");
  assert.equal(merged.phone, "+91 98300 11223");
  assert.equal(merged.vehicleNumber, "WB 02 AR 4491");
  assert.equal(merged.rating, 4.9);
  assert.equal(merged.currentHub, "Kasba Warehouse");
  assert.equal(merged.lat, 22.52);
  assert.equal(merged.lng, 88.39);
  assert.deepEqual(merged.current_location, gpsRecord);

  // Explicit non-generic riderName updates name while keeping phone & vehicleNumber
  const mergedNamed = mergeDeliveryPartnerLocation(existing, {
    ...gpsRecord,
    riderName: "Suman Roy",
  });
  assert.equal(mergedNamed.name, "Suman Roy");
  assert.equal(mergedNamed.phone, "+91 98300 11223");
  assert.equal(mergedNamed.vehicleNumber, "WB 02 AR 4491");
});

test("parseOptionalRefundAmount validates optional positive refund amounts strictly", () => {
  assert.deepEqual(parseOptionalRefundAmount(undefined), { ok: true, amount: undefined });
  assert.deepEqual(parseOptionalRefundAmount(""), { ok: true, amount: undefined });
  assert.deepEqual(parseOptionalRefundAmount(499.5), { ok: true, amount: 499.5 });
  assert.deepEqual(parseOptionalRefundAmount("1200"), { ok: true, amount: 1200 });

  assert.equal(parseOptionalRefundAmount(0).ok, false);
  assert.equal(parseOptionalRefundAmount(-50).ok, false);
  assert.equal(parseOptionalRefundAmount(NaN).ok, false);
  assert.equal(parseOptionalRefundAmount(Infinity).ok, false);
  assert.equal(parseOptionalRefundAmount(true).ok, false);
  assert.equal(parseOptionalRefundAmount("abc").ok, false);
});

test("isTestRefundPayment and isSimulatedRefundAllowed block simulations in production and for real payment IDs", () => {
  assert.equal(isTestRefundPayment("pay_test_123", "ord_1"), true);
  assert.equal(isTestRefundPayment("test_abc", "ord_1"), true);
  assert.equal(isTestRefundPayment("", "order_test_99"), true);
  // Real-looking payment ID must NEVER be classified as a test payment even with order_test_ prefix
  assert.equal(isTestRefundPayment("pay_RealLive987654", "order_test_99"), false);
  assert.equal(isTestRefundPayment("pay_RealLive987654", "ord_1"), false);

  // Production ALWAYS blocks simulated refunds
  assert.equal(
    isSimulatedRefundAllowed({ nodeEnv: "production", isTestPayment: true, razorpayKeyId: "rzp_test_123" }),
    false
  );
  assert.equal(
    isSimulatedRefundAllowed({ nodeEnv: "production", isTestPayment: false, razorpayKeyId: "" }),
    false
  );
  // Live Razorpay key blocks simulated refunds even outside production
  assert.equal(
    isSimulatedRefundAllowed({ nodeEnv: "development", isTestPayment: true, razorpayKeyId: "rzp_live_abc" }),
    false
  );
  // Development with real-looking payment ID blocks simulated refunds
  assert.equal(
    isSimulatedRefundAllowed({ nodeEnv: "development", isTestPayment: false, razorpayKeyId: "" }),
    false
  );
  // Development with explicit test payment and non-live key allows simulation
  assert.equal(
    isSimulatedRefundAllowed({ nodeEnv: "development", isTestPayment: true, razorpayKeyId: "rzp_test_123" }),
    true
  );
});

test("validateNonAdminRefundRequest enforces order existence, ownership, payment_id match, and total_amount cap", () => {
  const authUser = {
    id: "user-1",
    user_metadata: { master_user_id: "user-master-1" },
  };
  const baseOrder = {
    id: "ord-uuid-1",
    user_id: "user-1",
    payment_id: "pay_LiveAbc123",
    total_amount: 1650,
  };

  // Missing order -> 404
  const missing = validateNonAdminRefundRequest({
    order: null,
    authUser,
    paymentId: "pay_LiveAbc123",
    requestedAmount: 1650,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 404);

  // Different owner -> 403
  const wrongOwner = validateNonAdminRefundRequest({
    order: { ...baseOrder, user_id: "other-user" },
    authUser,
    paymentId: "pay_LiveAbc123",
    requestedAmount: 1650,
  });
  assert.equal(wrongOwner.ok, false);
  if (!wrongOwner.ok) assert.equal(wrongOwner.status, 403);

  // Mismatched payment_id -> 403
  const wrongPayment = validateNonAdminRefundRequest({
    order: baseOrder,
    authUser,
    paymentId: "pay_Different999",
    requestedAmount: 1650,
  });
  assert.equal(wrongPayment.ok, false);
  if (!wrongPayment.ok) assert.equal(wrongPayment.status, 403);

  // Amount greater than order total -> 400
  const overRefund = validateNonAdminRefundRequest({
    order: baseOrder,
    authUser,
    paymentId: "pay_LiveAbc123",
    requestedAmount: 1650.01,
  });
  assert.equal(overRefund.ok, false);
  if (!overRefund.ok) assert.equal(overRefund.status, 400);

  // Valid partial refund for primary user -> ok
  const validPartial = validateNonAdminRefundRequest({
    order: baseOrder,
    authUser,
    paymentId: "pay_LiveAbc123",
    requestedAmount: 500,
  });
  assert.equal(validPartial.ok, true);
  if (validPartial.ok) {
    assert.equal(validPartial.effectiveAmount, 500);
    assert.equal(validPartial.orderTotal, 1650);
  }

  // Valid full refund (omitted amount defaults to orderTotal) for linked master_user_id -> ok
  const validMaster = validateNonAdminRefundRequest({
    order: { ...baseOrder, user_id: "user-master-1", payment_id: null, razorpay_payment_id: "pay_LiveAbc123" },
    authUser,
    paymentId: "pay_LiveAbc123",
  });
  assert.equal(validMaster.ok, true);
  if (validMaster.ok) {
    assert.equal(validMaster.effectiveAmount, 1650);
  }
});

test("verifyFetchedRazorpayOrder rejects amount mismatch, non-INR currency, and underpaid orders", () => {
  // Exact match: 1675 INR = 167500 paise, INR, amount_paid >= amount -> ok
  assert.deepEqual(
    verifyFetchedRazorpayOrder({
      fetchedOrder: {
        id: "order_RzpValid123",
        amount: 167500,
        amount_paid: 167500,
        currency: "INR",
        status: "paid",
      },
      expectedAmountInPaise: 167500,
    }),
    { ok: true }
  );

  // Amount mismatch (attacker created ₹1 Razorpay order for ₹1675 cart) -> rejected
  const amountMismatch = verifyFetchedRazorpayOrder({
    fetchedOrder: {
      id: "order_RzpCheap1",
      amount: 100,
      amount_paid: 100,
      currency: "INR",
      status: "paid",
    },
    expectedAmountInPaise: 167500,
  });
  assert.equal(amountMismatch.ok, false);
  if (!amountMismatch.ok) {
    assert.match(amountMismatch.reason, /amount mismatch/i);
  }

  // Off-by-one paise mismatch -> rejected
  const offByOne = verifyFetchedRazorpayOrder({
    fetchedOrder: {
      amount: 167499,
      amount_paid: 167499,
      currency: "INR",
    },
    expectedAmountInPaise: 167500,
  });
  assert.equal(offByOne.ok, false);

  // Wrong currency (USD instead of INR) -> rejected
  const wrongCurrency = verifyFetchedRazorpayOrder({
    fetchedOrder: {
      amount: 167500,
      amount_paid: 167500,
      currency: "USD",
    },
    expectedAmountInPaise: 167500,
  });
  assert.equal(wrongCurrency.ok, false);
  if (!wrongCurrency.ok) {
    assert.match(wrongCurrency.reason, /currency mismatch/i);
  }

  // Unpaid / partially paid order (amount_paid < amount) -> rejected
  const underpaid = verifyFetchedRazorpayOrder({
    fetchedOrder: {
      amount: 167500,
      amount_paid: 50000,
      currency: "INR",
    },
    expectedAmountInPaise: 167500,
  });
  assert.equal(underpaid.ok, false);
  if (!underpaid.ok) {
    assert.match(underpaid.reason, /amount_paid/i);
  }

  // Null / missing fetched order -> rejected
  assert.equal(
    verifyFetchedRazorpayOrder({
      fetchedOrder: null,
      expectedAmountInPaise: 167500,
    }).ok,
    false
  );
});

test("normalizeCartItemsForPricing strips client prices and supports nested and flat item shapes", () => {
  const normalized = normalizeCartItemsForPricing([
    {
      quantity: 2,
      selectedColor: "Red",
      product: { id: "prod-1", price: 1, deliveryCharge: 0 },
    },
    {
      productId: "prod-2",
      quantity: 1,
      color: "Black",
      price: 1,
    },
  ]);

  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized[0], {
    quantity: 2,
    selectedColor: "Red",
    product: { id: "prod-1", selectedColor: "Red" },
  });
  assert.deepEqual(normalized[1], {
    quantity: 1,
    selectedColor: "Black",
    product: { id: "prod-2", selectedColor: "Black" },
  });
  assert.equal((normalized[0].product as any).price, undefined);

  // Invalid quantity or missing id rejects the whole list
  assert.deepEqual(normalizeCartItemsForPricing([{ quantity: 0, product: { id: "prod-1" } }]), []);
  assert.deepEqual(normalizeCartItemsForPricing([{ quantity: 1, product: { id: "" } }]), []);
  assert.deepEqual(normalizeCartItemsForPricing([]), []);
});

test("sanitizeRazorpayOrderNotes always enforces authenticated userId and prevents spoofing", () => {
  const notes = sanitizeRazorpayOrderNotes(
    {
      userId: "attacker-spoofed-id",
      user_id: "attacker-spoofed-id",
      cartType: "electrical",
      nested: { ignored: true },
    },
    "real-auth-user-42"
  );

  assert.equal(notes.userId, "real-auth-user-42");
  assert.equal(notes.user_id, "real-auth-user-42");
  assert.equal(notes.cartType, "electrical");
  assert.equal((notes as any).nested, undefined);
});

test("evaluateRazorpayWebhookOrderUpdate guards pending payment_status, preserves terminal orders, and enforces amount match", () => {
  // Pending payment + pending status + exact amount -> update and set status = accepted
  assert.deepEqual(
    evaluateRazorpayWebhookOrderUpdate({
      existingOrder: { status: "pending", payment_status: "pending", total_amount: 1675 },
      paymentAmountPaise: 167500,
    }),
    { action: "update", setStatusAccepted: true, requirePendingStatus: true }
  );

  // Pending payment + already packed/accepted status + exact amount -> update payment_status only (keep status)
  assert.deepEqual(
    evaluateRazorpayWebhookOrderUpdate({
      existingOrder: { status: "packed", payment_status: "pending", total_amount: 1675 },
      paymentAmountPaise: 167500,
    }),
    { action: "update", setStatusAccepted: false, requirePendingStatus: false }
  );

  // Cancelled order must NEVER be changed
  const cancelled = evaluateRazorpayWebhookOrderUpdate({
    existingOrder: { status: "cancelled", payment_status: "pending", total_amount: 1675 },
    paymentAmountPaise: 167500,
  });
  assert.equal(cancelled.action, "skip");

  // Delivered order must NEVER be changed
  const delivered = evaluateRazorpayWebhookOrderUpdate({
    existingOrder: { status: "delivered", payment_status: "pending", total_amount: 1675 },
    paymentAmountPaise: 167500,
  });
  assert.equal(delivered.action, "skip");

  // Already paid order -> skip
  const alreadyPaid = evaluateRazorpayWebhookOrderUpdate({
    existingOrder: { status: "pending", payment_status: "paid", total_amount: 1675 },
    paymentAmountPaise: 167500,
  });
  assert.equal(alreadyPaid.action, "skip");

  // Payment amount mismatch (₹1 vs ₹1675) -> skip
  const amountDiffers = evaluateRazorpayWebhookOrderUpdate({
    existingOrder: { status: "pending", payment_status: "pending", total_amount: 1675 },
    paymentAmountPaise: 100,
  });
  assert.equal(amountDiffers.action, "skip");
  if (amountDiffers.action === "skip") {
    assert.match(amountDiffers.reason, /amount mismatch/i);
  }
});

test("decideEmailOtpVerificationOutcome enforces atomic attempt ceiling strictly", () => {
  // Missing / expired record -> 400
  assert.equal(
    decideEmailOtpVerificationOutcome({
      found: false,
      limitReached: false,
      attemptsAfterIncrement: 0,
      maxAttempts: 5,
      isHashValid: false,
    }).status,
    400
  );

  // Valid hash on attempt 5 (within ceiling) -> 200 & clearOtp
  const fifthValid = decideEmailOtpVerificationOutcome({
    found: true,
    limitReached: false,
    attemptsAfterIncrement: 5,
    maxAttempts: 5,
    isHashValid: true,
  });
  assert.equal(fifthValid.status, 200);
  assert.equal(fifthValid.verified, true);
  assert.equal(fifthValid.clearOtp, true);

  // Invalid hash on attempt 4 (< 5) -> 400 & do NOT clear yet
  const fourthInvalid = decideEmailOtpVerificationOutcome({
    found: true,
    limitReached: false,
    attemptsAfterIncrement: 4,
    maxAttempts: 5,
    isHashValid: false,
  });
  assert.equal(fourthInvalid.status, 400);
  assert.equal(fourthInvalid.clearOtp, false);

  // Invalid hash on attempt 5 (== 5) -> 429 & clearOtp
  const fifthInvalid = decideEmailOtpVerificationOutcome({
    found: true,
    limitReached: false,
    attemptsAfterIncrement: 5,
    maxAttempts: 5,
    isHashValid: false,
  });
  assert.equal(fifthInvalid.status, 429);
  assert.equal(fifthInvalid.clearOtp, true);

  // Atomic RPC returned limit_reached = true (6th+ concurrent attempt) -> 429 even if hash were valid
  const overLimit = decideEmailOtpVerificationOutcome({
    found: true,
    limitReached: true,
    attemptsAfterIncrement: 5,
    maxAttempts: 5,
    isHashValid: true,
  });
  assert.equal(overLimit.status, 429);
  assert.equal(overLimit.verified, false);
  assert.equal(overLimit.clearOtp, true);
});



