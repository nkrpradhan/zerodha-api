const fs = require("fs/promises");
const { KiteConnect, KiteTicker } = require("kiteconnect");

const apiKey = "ar217a1r0m2fd4t0";
const apiSecret = "r9vypnqdqa8ab1dws5w6l7px6j2uxkth";
const requestToken = "iF6jyMYXlt0MCUdJZW8AM9BfzY6YmTbW";
const TOKEN_PATH = "./access_token.json";

const kc = new KiteConnect({ api_key: apiKey });
let ticker;

const handledOrders = new Set();
const activeTrailOrders = new Map();
const instrumentCache = {};
const subscribedTokens = new Set();

// ---------- Auth + Init ----------
async function loadAccessToken() {
  try {
    const data = await fs.readFile(TOKEN_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveAccessToken(access_token) {
  await fs.writeFile(TOKEN_PATH, JSON.stringify({ access_token }), "utf-8");
}

async function init() {
  const tokenData = await loadAccessToken();

  if (!tokenData || !tokenData.access_token) {
    const session = await kc.generateSession(requestToken, apiSecret);
    kc.setAccessToken(session.access_token);
    await saveAccessToken(session.access_token);
    console.log("🔐 New session created.");
  } else {
    kc.setAccessToken(tokenData.access_token);
    console.log("✅ Using saved access token.");
  }

  startTicker();
  startOrderPolling();
}

init();

// ---------- Token Utility ----------
async function getTokenForSymbol(symbol) {
  if (instrumentCache[symbol]) return instrumentCache[symbol];

  const instruments = await kc.getInstruments("NFO");
  const instrument = instruments.find((i) => i.tradingsymbol === symbol);
  if (!instrument) throw new Error(`❌ Token not found for ${symbol}`);

  instrumentCache[symbol] = instrument.instrument_token;
  return instrument.instrument_token;
}

// ---------- Poll for Manual Orders ----------
function startOrderPolling() {
  setInterval(async () => {
    try {
      const orders = await kc.orders();

      for (const order of orders) {
        if (
          order.status === "COMPLETE" &&
          !handledOrders.has(order.order_id) &&
          order.tag !== "auto-sl"
        ) {
          handledOrders.add(order.order_id);
          console.log("🆕 Manual Order:", order.tradingsymbol);

          await setupSLAndTrail(order);
        }
      }
    } catch (e) {
      console.error("📡 Order Polling Error:", e.message);
    }
  }, 5000); // Poll every 5s
}

// ---------- SL + TSL Logic ----------
async function setupSLAndTrail(order) {
  const symbol = order.tradingsymbol;
  const entryPrice = parseFloat(order.average_price);
  const qty = order.quantity;
  const isBuy = order.transaction_type === "BUY";
  const trailBuffer = 10;
  const slBuffer = 2;

  const slTrigger = isBuy ? entryPrice - trailBuffer : entryPrice + trailBuffer;
  const slLimit = isBuy ? slTrigger - slBuffer : slTrigger + slBuffer;

  const slOrder = await kc.placeOrder("regular", {
    exchange: order.exchange,
    tradingsymbol: symbol,
    transaction_type: isBuy ? "SELL" : "BUY",
    quantity: qty,
    order_type: "SL",
    trigger_price: slTrigger,
    price: slLimit,
    product: order.product,
    tag: "auto-sl",
  });

  console.log(`📍 SL placed for ${symbol} → ₹${slTrigger}`);

  const token = await getTokenForSymbol(symbol);
  subscribeToToken(token);

  activeTrailOrders.set(token, {
    symbol,
    entryPrice,
    slOrderId: slOrder.order_id,
    isBuy,
    trailingActive: false,
    bestPrice: entryPrice,
    lastTrailTrigger: entryPrice,
  });
}

// ---------- Ticker WebSocket ----------
function startTicker() {
  ticker = new KiteTicker({
    api_key: kc.api_key,
    access_token: kc.access_token,
  });

  ticker.on("connect", () => {
    console.log("🔌 Ticker connected.");
  });

  ticker.on("ticks", handleTicks);

  ticker.on("error", (err) => {
    console.error("Ticker Error:", err);
  });

  ticker.connect();
}

function subscribeToToken(token) {
  if (subscribedTokens.has(token)) return;
  ticker.subscribe([token]);
  ticker.setMode(ticker.modeLTP, [token]);
  subscribedTokens.add(token);
  console.log("📡 Subscribed to token:", token);
}

async function handleTicks(ticks) {
  for (const tick of ticks) {
    const token = tick.instrument_token;
    const trail = activeTrailOrders.get(token);
    if (!trail) continue;

    const { isBuy, entryPrice, slOrderId } = trail;
    const price = tick.last_price;
    const trailBuffer = 10;
    const slBuffer = 2;

    const risk = Math.abs(
      entryPrice - (isBuy ? entryPrice - trailBuffer : entryPrice + trailBuffer)
    );
    const trailStart = isBuy
      ? entryPrice + 1.5 * risk
      : entryPrice - 1.5 * risk;

    if (!trail.trailingActive) {
      const hit = isBuy ? price >= trailStart : price <= trailStart;
      if (hit) {
        trail.trailingActive = true;
        console.log(`🚀 1.5R hit on ${trail.symbol} at ₹${price}`);
      } else continue;
    }

    const move = Math.abs(price - trail.lastTrailTrigger);
    if (move >= 0.5) {
      trail.lastTrailTrigger = price;

      const newTrigger = isBuy ? price - trailBuffer : price + trailBuffer;
      const newLimit = isBuy ? newTrigger - slBuffer : newTrigger + slBuffer;

      try {
        await kc.modifyOrder("regular", slOrderId, {
          trigger_price: newTrigger,
          price: newLimit,
        });
        console.log(`🔁 SL Updated for ${trail.symbol}: ₹${newTrigger}`);
      } catch (err) {
        console.error(`❌ SL update error (${trail.symbol}):`, err.message);
      }
    }
  }
}

setInterval(async () => {
  try {
    const positions = await kc.getPositions();
    const netPositions = positions.net;

    let totalPnl = 0;
    const openPositions = [];

    for (const pos of netPositions) {
      totalPnl += pos.pnl;

      if (pos.quantity !== 0) {
        openPositions.push(pos);
      }
    }

    console.log(`📊 Total P&L: ₹${totalPnl.toFixed(2)}`);

    if (totalPnl >= PROFIT_TARGET || totalPnl <= LOSS_LIMIT) {
      console.log("🚨 P&L threshold breached. Cancelling SLs and exiting...");

      // Step 1: Cancel ALL SL orders (not just auto-sl)
      const allOrders = await kc.orders();
      const slOrders = allOrders.filter(
        (order) =>
          order.status === "TRIGGER PENDING" && order.order_type === "SL"
      );

      for (const order of slOrders) {
        await kc.cancelOrder("regular", order.order_id);
        console.log(`✂️ Cancelled SL: ${order.tradingsymbol}`);
      }

      // Step 2: Exit open positions
      for (const pos of openPositions) {
        const oppositeSide = pos.quantity > 0 ? "SELL" : "BUY";

        await kc.placeOrder("regular", {
          exchange: pos.exchange,
          tradingsymbol: pos.tradingsymbol,
          transaction_type: oppositeSide,
          quantity: Math.abs(pos.quantity),
          order_type: "MARKET",
          product: pos.product,
          tag: "pnl-exit",
        });

        console.log(`❌ Position squared off: ${pos.tradingsymbol}`);
      }
    }
  } catch (err) {
    console.error("❌ Error during auto square-off:", err.message);
  }
}, 30000); 
