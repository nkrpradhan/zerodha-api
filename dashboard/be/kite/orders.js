const { kc } = require("./connect");

async function cancelAllSL() {
  const orders = await kc.getOrders();
  const slOrders = orders.filter(
    (o) => o.status === "TRIGGER PENDING" && o.tag === "auto-sl"
  );

  for (const o of slOrders) {
    try {
      await kc.cancelOrder("regular", o.order_id);
      console.log(`❌ Cancelled SL: ${o.tradingsymbol}`);
    } catch (e) {
      console.error("Cancel error:", e.message);
    }
  }
}

async function squareOffAll() {
  await cancelAllSL();
  const { net } = await kc.getPositions();

  for (const p of net) {
    if (p.quantity === 0) continue;

    const side = p.quantity > 0 ? "SELL" : "BUY";

    try {
      await kc.placeOrder("regular", {
        exchange: p.exchange,
        tradingsymbol: p.tradingsymbol,
        transaction_type: side,
        quantity: Math.abs(p.quantity),
        order_type: "MARKET",
        product: p.product,
      });
      console.log(`✅ Exited: ${p.tradingsymbol}`);
    } catch (e) {
      console.error("Square-off error:", e.message);
    }
  }
}

module.exports = { squareOffAll, cancelAllSL };
