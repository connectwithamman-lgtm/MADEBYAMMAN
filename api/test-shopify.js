const API_VERSION = "2026-10";

async function getShopifyToken() {
  const shop = process.env.SHOPIFY_SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error("Missing SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET");
  }

  const response = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Shopify token request failed");
  }
  return data.access_token;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const token = await getShopifyToken();
    const shop = process.env.SHOPIFY_SHOP;
    const response = await fetch(
      `https://${shop}.myshopify.com/admin/api/${API_VERSION}/products.json?limit=10`,
      { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
    );
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data.errors || "Shopify product request failed"
      });
    }

    return res.status(200).json({
      ok: true,
      shop: `${shop}.myshopify.com`,
      products: (data.products || []).map(product => ({
        id: product.id,
        title: product.title,
        variants: (product.variants || []).map(variant => ({
          id: variant.id,
          title: variant.title,
          price: variant.price
        }))
      }))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
