// backend/server.js
const express = require("express");
const { init, kc, loadAccessToken, getTicker } = require("./kite");

//save logs
const fs = require("fs");

const originalLog = console.log;
const originalError = console.error;

const dateStr = new Date().toISOString().split("T")[0];
const logDir = "./logs";
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
const logStream = fs.createWriteStream(`${logDir}/trading-${dateStr}.log`, {
  flags: "a",
});

console.log = (...args) => {
  const message = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  logStream.write(message);
  originalLog(...args);
};

console.error = (...args) => {
  const message = `[${new Date().toISOString()}] ERROR: ${args.join(" ")}\n`;
  logStream.write(message);
  originalError(...args);
};

const app = express();
const PORT = 3000;

const handledOrders = new Set();
const activeTrailOrders = new Map();
const tokenMap = {}; // Will be filled dynamically

const TRAIL_START_MULTIPLIER = 2; // Configurable multiplier
const TRAIL_BUFFER = 10; // Distance from current price to SL trigger
const SL_BUFFER = 2; // Difference between SL trigger and SL limit

const MAX_DAILY_LOSS = -5000;
let lossTriggered = false;

app.listen(PORT, async () => {
  try {
    const halted = await fs.readFile(HALT_PATH, "utf-8");
    if (halted === "halted") {
      console.warn("🚫 Trading is halted for the day. Exiting...");
      return;
    }
  } catch {}
  await init();
  const accessToken = await loadAccessToken();
  if (!accessToken) return;
  console.log("Server running on http://localhost:" + PORT);
  startOrderPolling();
  startTicker(accessToken);
  // monitorPnL();
});

async function fetchInstrumentToken(symbol) {
  const instruments = await kc.getInstruments("NFO");
  return instruments.find((i) => i.tradingsymbol === symbol);
}

function isMarketOpenInIST() {
  const nowUTC = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // IST = UTC + 5:30
  const ist = new Date(nowUTC.getTime() + istOffset);

  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  const totalMinutes = hour * 60 + minute;

  console.log(`🕒 IST Time = ${hour}:${minute} (${totalMinutes} min)`);
  return totalMinutes >= 555 && totalMinutes <= 930; // 9:15 to 15:30 IST
}

async function squareOffAllPositions() {
  try {
    const positions = await kc.getPositions();
    const net = positions.net || [];

    const orders = await kc.getOrders();
    const slOrders = orders.filter(
      (o) => o.order_type === "SL" && o.status === "TRIGGER PENDING"
    );

    for (const order of slOrders) {
      try {
        await kc.cancelOrder("regular", order.order_id);
        console.log(`🚫 Cancelled SL order for ${order.tradingsymbol}`);
      } catch (err) {
        console.error(
          `❌ Failed to cancel SL for ${order.tradingsymbol}:`,
          err.message
        );
      }
    }

    for (const pos of net) {
      if (pos.quantity !== 0) {
        try {
          await kc.placeOrder("regular", {
            exchange: pos.exchange,
            tradingsymbol: pos.tradingsymbol,
            transaction_type: pos.quantity > 0 ? "SELL" : "BUY",
            quantity: Math.abs(pos.quantity),
            order_type: "MARKET",
            product: pos.product,
            tag: "squareoff",
          });
          console.log(`🏁 Squared off ${pos.tradingsymbol}`);
        } catch (err) {
          console.error(
            `❌ Failed to square off ${pos.tradingsymbol}:`,
            err.message
          );
        }
      }
    }
  } catch (err) {
    console.error("❌ Error squaring off:", err.message);
  }
}
async function startOrderPolling() {
  if (!isMarketOpenInIST()) {
    console.warn(`⏳ Market is closed (IST). Skipping polling for now.`);
    return;
  }
  if (lossTriggered) return;
  setInterval(async () => {
    try {
      const orders = await kc.getOrders();
      console.log("start polling --orders check--", JSON.stringify(orders));

      for (const order of orders) {
        if (
          order.status === "COMPLETE" &&
          !handledOrders.has(order.order_id) &&
          order.tag !== "auto-sl"
        ) {
          const positions = await kc.getPositions();
          const netPositions = positions.net || [];
          const hasOpenPosition = netPositions.some(
            (p) => p.tradingsymbol === order.tradingsymbol && p.quantity !== 0
          );
          console.log("hasOpenPosition::", hasOpenPosition);
          if (!hasOpenPosition) {
            console.log(
              `🛑 No open position for ${order.tradingsymbol}. Skipping SL.`
            );
            continue;
          }

          handledOrders.add(order.order_id);

          const entryPrice = parseFloat(order.average_price);
          const symbol = order.tradingsymbol;
          const qty = order.quantity;
          const isBuy = order.transaction_type === "BUY";
          const existingSL = orders.find(
            (o) =>
              o.tradingsymbol === symbol &&
              o.order_type === "SL" &&
              o.tag !== "auto-sl" &&
              o.status !== "REJECTED"
          );
          if (existingSL) {
            console.log(
              `⏩ Manual SL already exists for ${symbol}. Skipping auto SL.`
            );
            continue;
          }

          const instrument = await fetchInstrumentToken(symbol);
          if (!instrument) {
            console.error("❌ No instrument found for", symbol);
            continue;
          }

          tokenMap[symbol] = instrument.instrument_token;
          console.log(
            `🔑 Token set for ${symbol}: ${instrument.instrument_token}`
          );

          const slTrigger = isBuy
            ? entryPrice - TRAIL_BUFFER
            : entryPrice + TRAIL_BUFFER;
          const slLimit = isBuy ? slTrigger - SL_BUFFER : slTrigger + SL_BUFFER;

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

          const initialRisk = Math.abs(entryPrice - slTrigger);

          activeTrailOrders.set(symbol, {
            entryPrice,
            qty,
            slOrderId: slOrder.order_id,
            isBuy,
            trailingActive: false,
            bestPrice: entryPrice,
            lastTrailTrigger: entryPrice,
            initialRisk,
            trailStepCount: 1,
          });

          console.log(
            `📌 SL Order Placed for ${symbol} at ₹${slTrigger} transaction type--${
              isBuy ? "SELL" : "BUY"
            }`
          );
        }
      }
    } catch (err) {
      console.error("Order polling error:", "Error is", err.message);
    }
  }, 10000);
}

function startTicker(access_token) {
  // if (!isMarketOpenInIST()) {
  //   console.warn(`⏳ Market is closed (IST). Skipping ticker.`);
  //   return;
  // }
  const ticker = getTicker(access_token);

  ticker.connect();

  ticker.on("connect", () => {
    console.log("🔗 Ticker connected.");
  });
  // Dynamically subscribe as symbols are added
  const subscribedTokens = new Set();
  console.log("subscribedTokens", subscribedTokens);
  setInterval(() => {
    const newTokens = Object.values(tokenMap).filter(
      (t) => !subscribedTokens.has(t)
    );
    if (newTokens.length > 0) {
      ticker.subscribe(newTokens);
      ticker.setMode(ticker.modeLTP, newTokens);
      newTokens.forEach((t) => subscribedTokens.add(t));
      console.log("📡 Subscribed to new tokens:", newTokens);
    }
  }, 2000);

  ticker.on("ticks", async (ticks) => {
    console.log(`📉 ticks start`);
    console.log(`✅ Received ${ticks.length} tick(s)`);
    console.log(JSON.stringify(ticks, null, 2));
    if (lossTriggered) return;
    try {
      console.log(`📉 Live PnL (tick-based) start`);
      const positions = await kc.getPositions();
      const net = positions.net || [];
      const totalPnl = net.reduce((sum, p) => sum + p.pnl, 0);
      console.log(`📉 Live PnL (tick-based): ₹${totalPnl.toFixed(2)}`);

      if (totalPnl < 0 && Math.abs(totalPnl) >= Math.abs(MAX_DAILY_LOSS)) {
        console.warn(
          "⛔ Max daily loss breached on ticks! Initiating square off--",
          totalPnl
        );
        lossTriggered = true;
        await squareOffAllPositions();
        // Wait for one minute and logout session
        setTimeout(async () => {
          try {
            await kc.logout();
            await fs.writeFile(HALT_PATH, "halted", "utf-8");
            console.log(
              "🔒 Session logged out. No further trading allowed today."
            );
            // Optional: close browser tab/window
            // try {
            //   const { exec } = require("child_process");
            //   exec("pkill -f chrome", (err) => {
            //     if (err) {
            //       console.warn(
            //         "⚠️ Unable to close browser session automatically:",
            //         err.message
            //       );
            //     } else {
            //       console.log("🧹 Browser session closed.");
            //     }
            //   });
            // } catch (browserErr) {
            //   console.warn("⚠️ Browser cleanup skipped:", browserErr.message);
            // }
          } catch (logoutErr) {
            console.error("❌ Error logging out:", logoutErr.message);
          }
        }, 60000);
      }
    } catch (err) {
      console.error("Tick-based PnL error:", err.message);
    }

    for (const tick of ticks) {
      console.log("inside loop for sl trail");
      const token = tick.instrument_token;
      const symbol = Object.keys(tokenMap).find(
        (key) => tokenMap[key] === token
      );
      if (!symbol) continue;

      const trail = activeTrailOrders.get(symbol);
      if (!trail) continue;

      const {
        entryPrice,
        slOrderId,
        isBuy,
        trailingActive,
        initialRisk,
        trailStepCount,
      } = trail;

      const price = tick.last_price;
      const trailStart = isBuy
        ? entryPrice + TRAIL_START_MULTIPLIER * initialRisk
        : entryPrice - TRAIL_START_MULTIPLIER * initialRisk;

      if (!trailingActive) {
        const trigger = isBuy ? price >= trailStart : price <= trailStart;
        if (trigger) {
          trail.trailingActive = true;
          console.log(
            `🚀 ${TRAIL_START_MULTIPLIER}R reached for ${symbol} at ₹${price}. Trailing started.`
          );
        } else {
          continue;
        }
      }

      const currentSL = isBuy
        ? entryPrice - TRAIL_BUFFER + (trailStepCount - 1) * initialRisk
        : entryPrice + TRAIL_BUFFER - (trailStepCount - 1) * initialRisk;

      const nextTrailTrigger = isBuy
        ? currentSL + TRAIL_BUFFER + initialRisk
        : currentSL - TRAIL_BUFFER - initialRisk;

      const shouldTrail = isBuy
        ? price >= nextTrailTrigger
        : price <= nextTrailTrigger;

      if (shouldTrail) {
        trail.trailStepCount += 1;
        trail.lastTrailTrigger = price;

        const newTrigger = isBuy
          ? entryPrice - TRAIL_BUFFER + trail.trailStepCount * initialRisk
          : entryPrice + TRAIL_BUFFER - trail.trailStepCount * initialRisk;

        const newLimit = isBuy
          ? newTrigger - SL_BUFFER
          : newTrigger + SL_BUFFER;

        try {
          await kc.modifyOrder("regular", slOrderId, {
            trigger_price: newTrigger,
            price: newLimit,
          });
          console.log(
            `🔁 SL Updated for ${symbol}: Trigger ₹${newTrigger}, Limit ₹${newLimit}`
          );
        } catch (err) {
          console.error(`❌ SL Update Failed for ${symbol}:`, err.message);
        }
      }
    }
  });

  ticker.on("error", console.error);
}

async function monitorPnL() {
  console.log(`📉 Monitor PnL start`);
  const positions = await kc.getPositions();
  const net = positions.net || [];
  const totalPnl = net.reduce((sum, p) => sum + p.pnl, 0);
  console.log(`📉 PnL polling: ₹${totalPnl.toFixed(2)}`);
}
setInterval(monitorPnL, 10000);

//for frontend code

// const cors = require("cors");
// app.use(cors());

// app.get("/stream", (req, res) => {
//   res.setHeader("Content-Type", "text/event-stream");
//   res.setHeader("Cache-Control", "no-cache");
//   res.setHeader("Connection", "keep-alive");

//   const sendUpdate = () => {
//     const data = [...activeTrailOrders.entries()].map(([symbol, t]) => ({
//       symbol,
//       entryPrice: t.entryPrice,
//       trailStepCount: t.trailStepCount,
//       currentSL:
//         t.entryPrice - TRAIL_BUFFER + (t.trailStepCount - 1) * t.initialRisk,
//       currentPrice: t.lastTrailTrigger,
//     }));
//     res.write(`data: ${JSON.stringify(data)}\n\n`);
//   };

//   const interval = setInterval(sendUpdate, 2000);
//   req.on("close", () => clearInterval(interval));
// });
