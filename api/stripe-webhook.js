const crypto = require("crypto");

const API_VERSION = "2026-10";

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(signatureHeader.split(",").map(part => {
    const index = part.indexOf("=");
    return index === -1 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
  }));
  if (!parts.t || !parts.v1) return false;
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const signedPayload = Buffer.concat([Buffer.from(parts.t + "."), rawBody]);
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(parts.v1, "hex");
  return expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function getShopifyToken() {
  const { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;
  if (!SHOPIFY_SHOP || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) throw new Error("Missing Shopify environment variables");
  const response = await fetch(`https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || "Shopify authentication failed");
  return data.access_token;
}

async function createShopifyOrder(session, eventId) {
  const shop = process.env.SHOPIFY_SHOP;
  const variantId = process.env.SHOPIFY_VARIANT_ID;
  if (!shop || !variantId) throw new Error("Missing SHOPIFY_SHOP or SHOPIFY_VARIANT_ID");
  const token = await getShopifyToken();

  const existingResponse = await fetch(`https://${shop}.myshopify.com/admin/api/${API_VERSION}/orders.json?status=any&limit=250&fields=id,note_attributes`, {
    headers: { "X-Shopify-Access-Token": token }
  });
  if (existingResponse.ok) {
    const existingData = await existingResponse.json();
    const alreadyCreated = (existingData.orders || []).some(order =>
      (order.note_attributes || []).some(attribute => attribute.name === "stripe_event_id" && attribute.value === eventId)
    );
    if (alreadyCreated) return { duplicate: true };
  }

  const customerEmail = session.customer_details?.email || session.customer_email || undefined;
  const address = session.customer_details?.address || session.shipping_details?.address;
  const customerName = session.customer_details?.name || session.shipping_details?.name || "";
  const nameParts = customerName.trim().split(/\\s+/).filter(Boolean);
  if (!Number.isInteger(session.amount_total) || session.amount_total <= 0 || !session.currency) {
    throw new Error("Stripe Checkout session is missing a valid paid amount or currency");
  }
  const paidAmount = (session.amount_total / 100).toFixed(2);

  const order = {
    order: {
      test: true,
      financial_status: "paid",
      email: customerEmail,
      send_receipt: false,
      send_fulfillment_receipt: false,
      line_items: [{ variant_id: Number(variantId), quantity: 1 }],
      transactions: [{
        kind: "sale",
        status: "success",
        amount: paidAmount,
        currency: session.currency.toUpperCase(),
        gateway: "Stripe"
      }],
      note: "Test payment received through Stripe Test mode. Created automatically by Made by Amman.",
      tags: "Stripe, Test Order, Made by Amman",
      note_attributes: [
        { name: "stripe_event_id", value: eventId },
        { name: "stripe_checkout_session_id", value: session.id }
      ],
      ...(address ? {
        shipping_address: {
          first_name: nameParts[0] || customerName || "Customer",
          last_name: nameParts.slice(1).join(" "),
          address1: address.line1 || "",
          address2: address.line2 || "",
          city: address.city || "",
          province: address.state || "",
          country: address.country || "",
          zip: address.postal_code || "",
          phone: session.customer_details?.phone || ""
        }
      } : {})
    }
  };

  const response = await fetch(`https://${shop}.myshopify.com/admin/api/${API_VERSION}/orders.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(order)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data.errors || data));
  return { duplicate: false, orderId: data.order?.id, orderName: data.order?.name };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }
  try {
    const rawBody = await readRawBody(req);
    if (!verifyStripeSignature(rawBody, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
      return res.status(400).send("Invalid Stripe signature");
    }
    const event = JSON.parse(rawBody.toString("utf8"));
    if (event.type !== "checkout.session.completed") return res.status(200).json({ received: true, ignored: true });
    const session = event.data?.object;
    if (event.livemode || session?.livemode) {
      return res.status(200).json({ received: true, ignored: true, reason: "Test payments only" });
    }
    if (session?.payment_status !== "paid") return res.status(200).json({ received: true, unpaid: true });
    const result = await createShopifyOrder(session, event.id);
    return res.status(200).json({ received: true, ...result });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return res.status(500).json({ received: false, error: error.message });
  }
};

module.exports.config = { api: { bodyParser: false } };
