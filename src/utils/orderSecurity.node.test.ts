import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  parseProductColorVariants,
  resolveServerUnitPrice,
  resolveAuthoritativeOrderItems,
  verifyRazorpayOrderPaymentStatus,
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
