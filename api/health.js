module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    service: "madebyamman-stripe-shopify"
  });
};
