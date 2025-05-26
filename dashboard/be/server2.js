// backend/server.js - refactored code

const express = require("express");
const fs = require("fs").promises; // Use promise-based fs for async operations
const path = require("path");

const { init, kc, loadAccessToken, getTicker } = require("./kite");

// --- Configuration Constants ---
const PORT = 3000;
const LOG_DIR = path.join(__dirname, "logs");
const HALT_PATH = path.join(__dirname, "HALT_TRADING.txt"); // Consistent file path

const TRAIL_START_MULTIPLIER = 2; // Configurable multiplier (e.g., 2R)
const TRAIL_BUFFER = 10; // Distance from current price to SL trigger
const SL_BUFFER = 2; // Difference between SL trigger and SL limit

const MAX_DAILY_LOSS = -5000; // Maximum daily loss threshold
const SESSION_LOGOUT_DELAY = 60 * 1000; // 1 minute delay before logout

const MARKET_OPEN_TIME_MINUTES = 9 * 60 + 15; // 09:00 IST in minutes from midnight
const MARKET_CLOSE_TIME_MINUTES = 15 * 60 + 30; // 15:15 IST in minutes from midnight

const ORDER_POLLING_INTERVAL = 10 * 1000; // Poll orders every 10 seconds
const TICKER_SUBSCRIPTION_INTERVAL = 2 * 1000; // Check for new tokens every 2 seconds

// --- Global State ---
let lossTriggered = false;
const activeTrailOrders = new Map(); // Stores active trailing stop-loss orders
const instrumentTokenMap = new Map(); // Maps trading symbol to instrument token
const subscribedTokens = new Set(); // Stores tokens already subscribed to the ticker
const handledOrderIds = new Set(); // To prevent processing the same order multiple times

// --- Logging Setup ---
let logStream;

async function setupLogging() {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const dateStr = new Date().toISOString().split("T")[0];
    const logFilePath = path.join(LOG_DIR, `trading-${dateStr}.log`);
    logStream = fs.createWriteStream(logFilePath, { flags: "a" });

    const originalLog = console.log;
    const originalError = console.error;

    console.log = (...args) => {
      const message = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
      logStream.write(message);
      originalLog(...args);
    };

    console.error = (...args) => {
      const message = `[${new Date().toISOString()}] ERROR: ${args.join(
        " "
      )}\n`;
      logStream.write(message);
      originalError(...args);
    };
  } catch (err) {
    console.error("Failed to set up logging:", err.message);
    // Fallback to original console methods if logging setup fails
  }
}

// --- Utility Functions ---

/**
 * Checks if the market is open based on IST.
 * @returns {boolean} True if market is open, false otherwise.
 */
function isMarketOpenInIST() {
  const nowUTC = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // IST = UTC + 5:30
  const ist = new Date(nowUTC.getTime() + istOffset);

  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  const totalMinutes = hour * 60 + minute;

  console.log(`🕒 IST Time = ${hour}:${minute} (${totalMinutes} min)`);
  return (
    totalMinutes >= MARKET_OPEN_TIME_MINUTES &&
    totalMinutes <= MARKET_CLOSE_TIME_MINUTES
  ); // 9:15 to 15:30 IST
}

/**
 * Fetches the instrument token for a given trading symbol.
 * @param {string} symbol - The trading symbol (e.g., "BANKNIFTY24MAY48000CE").
 * @returns {object|undefined} The instrument object or undefined if not found.
 */
async function fetchInstrumentToken(symbol) {
  try {
    const instruments = await kc.getInstruments("NFO"); // Assuming NFO for futures/options
    const instrument = instruments.find((i) => i.tradingsymbol === symbol);
    if (instrument) {
      instrumentTokenMap.set(symbol, instrument.instrument_token);
      return instrument;
    }
    console.warn(`⚠️ Instrument not found for symbol: ${symbol}`);
    return undefined;
  } catch (err) {
    console.error(`❌ Error fetching instrument for ${symbol}:`, err.message);
    return undefined;
  }
}

/**
 * Squares off all open positions and cancels pending SL orders.
 */
async function squareOffAllPositions() {
  console.log("Initiating square off for all positions...");
  try {
    const positions = await kc.getPositions();
    const netPositions = positions.net || [];
    const orders = await kc.getOrders();

    // Cancel all pending SL orders
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

    // Square off all net open positions
    for (const pos of netPositions) {
      if (pos.quantity !== 0) {
        try {
          await kc.placeOrder("regular", {
            exchange: pos.exchange,
            tradingsymbol: pos.tradingsymbol,
            transaction_type: pos.quantity > 0 ? "SELL" : "BUY", // Opposite transaction
            quantity: Math.abs(pos.quantity),
            order_type: "MARKET",
            product: pos.product,
            tag: "squareoff",
          });
          console.log(`🏁 Squared off ${pos.tradingsymbol} (${pos.quantity})`);
        } catch (err) {
          console.error(
            `❌ Failed to square off ${pos.tradingsymbol}:`,
            err.message
          );
        }
      }
    }
    console.log("✅ All positions squared off.");
  } catch (err) {
    console.error("❌ Error in squareOffAllPositions:", err.message);
  }
}

/**
 * Reconstructs open legs from order history for a given symbol and position.
 * This is crucial for handling partial exits or multiple entries.
 * @param {Array} symbolOrders - All complete orders for the symbol.
 * @param {object} position - The current net position for the symbol.
 * @returns {Array} An array of objects: [{ qty: number, price: number }] representing open legs.
 */
function reconstructOpenLegs(symbolOrders, position) {
  const queue = [];
  const isBuyPosition = position.quantity > 0;

  const sortedOrders = symbolOrders.sort(
    (a, b) => new Date(a.order_timestamp) - new Date(b.order_timestamp)
  );

  for (const o of sortedOrders) {
    const side = o.transaction_type;
    let qty = o.quantity;

    if (isBuyPosition && side === "BUY") {
      queue.push({ qty, price: o.average_price });
    } else if (isBuyPosition && side === "SELL") {
      // Match sell orders against buy queue
      while (qty > 0 && queue.length) {
        const first = queue[0];
        const matchQty = Math.min(first.qty, qty);
        first.qty -= matchQty;
        qty -= matchQty;
        if (first.qty === 0) queue.shift();
      }
    } else if (!isBuyPosition && side === "SELL") {
      queue.push({ qty, price: o.average_price });
    } else if (!isBuyPosition && side === "BUY") {
      // Match buy orders against sell queue
      while (qty > 0 && queue.length) {
        const first = queue[0];
        const matchQty = Math.min(first.qty, qty);
        first.qty -= matchQty;
        qty -= matchQty;
        if (first.qty === 0) queue.shift();
      }
    }
  }
  return queue.filter((leg) => leg.qty > 0);
}

/**
 * Places a stop-loss order for a specific open leg.
 * @param {object} leg - An object containing { qty, price } for the open leg.
 * @param {object} position - The current position object from Kite.
 * @returns {string|null} The order ID of the placed SL order, or null if failed.
 */
async function placeStopLossForLeg(leg, position) {
  const symbol = position.tradingsymbol;
  const isBuy = position.quantity > 0;
  const legEntry = parseFloat(leg.price);
  const legQty = leg.qty;

  // Calculate SL trigger and limit prices
  const slTrigger = isBuy
    ? Math.round(legEntry - TRAIL_BUFFER)
    : Math.round(legEntry + TRAIL_BUFFER);
  const slLimit = isBuy
    ? Math.round(slTrigger - SL_BUFFER)
    : Math.round(slTrigger + SL_BUFFER);

  try {
    const slOrder = await kc.placeOrder("regular", {
      exchange: position.exchange,
      tradingsymbol: symbol,
      transaction_type: isBuy ? "SELL" : "BUY", // Opposite of entry
      quantity: legQty,
      order_type: "SL",
      trigger_price: slTrigger,
      price: slLimit,
      product: position.product,
      tag: "auto-sl", // Custom tag for auto-placed SLs
    });

    const initialRisk = Math.abs(legEntry - slTrigger);

    activeTrailOrders.set(`${symbol}_${slOrder.order_id}`, {
      // Unique key for each SL order
      entryPrice: legEntry,
      qty: legQty,
      slOrderId: slOrder.order_id,
      isBuy,
      trailingActive: false, // Trailing not active initially
      bestPrice: legEntry, // Keep track of the best price reached
      lastTrailTrigger: legEntry, // Last price at which SL was trailed
      initialRisk,
      trailStepCount: 1, // Number of times SL has been trailed
    });

    console.log(
      `📌 SL Order Placed for ${symbol} (Qty: ${legQty}) at ₹${slTrigger} (Limit: ₹${slLimit})`
    );
    return slOrder.order_id;
  } catch (err) {
    console.error(
      `❌ Failed to place SL for ${symbol} (Qty: ${legQty}):`,
      err.message
    );
    return null;
  }
}

/**
 * Main function for polling orders and managing SLs.
 */
async function startOrderPolling() {
  setInterval(async () => {
    if (!isMarketOpenInIST()) {
      console.warn("⏳ Market is closed (IST). Skipping order polling.");
      return;
    }
    if (lossTriggered) {
      console.log("🛑 Daily loss triggered. Skipping order polling.");
      return;
    }

    try {
      const allOrders = await kc.getOrders();
      const positions = await kc.getPositions();
      const netPositions = positions.net || [];

      for (const pos of netPositions) {
        if (pos.quantity === 0) {
          // If position is squared off, remove its SL from active tracking
          // Note: If multiple legs, this needs more granular removal
          for (const key of activeTrailOrders.keys()) {
            if (key.startsWith(pos.tradingsymbol)) {
              activeTrailOrders.delete(key);
              console.log(
                `🧹 Removed SL tracking for ${key} (position squared off).`
              );
            }
          }
          continue;
        }

        const symbol = pos.tradingsymbol;
        const symbolCompletedOrders = allOrders.filter(
          (o) => o.tradingsymbol === symbol && o.status === "COMPLETE"
        );

        // Reconstruct open legs from order history
        const openLegs = reconstructOpenLegs(symbolCompletedOrders, pos);

        if (openLegs.length === 0) {
          console.warn(
            `⚠️ No unmatched open entry found for ${symbol}. Skipping SL placement.`
          );
          continue;
        }

        // Get existing SL orders for this symbol
        const existingSLOrders = allOrders.filter(
          (o) =>
            o.tradingsymbol === symbol &&
            o.order_type === "SL" &&
            o.status === "TRIGGER PENDING" &&
            o.tag === "auto-sl"
        );

        // Map existing SL orders to their quantities
        const existingSLQtyMap = new Map();
        for (const slOrder of existingSLOrders) {
          existingSLQtyMap.set(slOrder.order_id, slOrder.quantity);
        }

        // Place SL for each unmatched open leg if not already covered by an existing SL
        for (const leg of openLegs) {
          const isLegCovered = Array.from(activeTrailOrders.values()).some(
            (trail) =>
              trail.entryPrice === leg.price &&
              trail.qty === leg.qty &&
              trail.slOrderId // Ensure an SL order ID exists
          );

          if (isLegCovered) {
            // console.log(`⏩ SL for leg (Qty: ${leg.qty}, Price: ${leg.price}) already exists. Skipping.`);
            continue;
          }

          // If no existing SL covers this specific leg, place a new one
          placeStopLossForLeg(leg, pos);
          // Ensure instrument token is mapped for ticker subscription
          if (!instrumentTokenMap.has(symbol)) {
            await fetchInstrumentToken(symbol);
          }
        }
      }
    } catch (err) {
      console.error("❌ Order polling error:", err.message);
    }
  }, ORDER_POLLING_INTERVAL);
}

/**
 * Initializes and manages the Kite Connect ticker for live price updates.
 * @param {string} accessToken - The access token for Kite Connect.
 */
function startTicker(accessToken) {
  if (!isMarketOpenInIST()) {
    console.warn("⏳ Market is closed (IST). Skipping ticker.");
    return;
  }
  const ticker = getTicker(accessToken);

  ticker.connect();

  ticker.on("connect", () => {
    console.log("🔗 Ticker connected.");

    // Periodically subscribe to new instrument tokens
    setInterval(() => {
      const newTokens = Array.from(instrumentTokenMap.values()).filter(
        (t) => !subscribedTokens.has(t)
      );
      if (newTokens.length > 0) {
        ticker.subscribe(newTokens);
        ticker.setMode(ticker.modeLTP, newTokens);
        newTokens.forEach((t) => subscribedTokens.add(t));
        console.log("📡 Subscribed to new tokens:", newTokens);
      }
    }, TICKER_SUBSCRIPTION_INTERVAL);
  });
  ticker.on("ticks", async (ticks) => {
    console.log("ticks start check lossTriggered::", lossTriggered);
    if (lossTriggered) return;

    // --- PnL Monitoring ---
    try {
      console.log("=======ticks pnl monitoring start======");
      const positions = await kc.getPositions();
      const net = positions.net || [];
      const totalPnl = net.reduce((sum, p) => sum + p.pnl, 0);
      console.log(`📉 Live PnL: ₹${totalPnl.toFixed(2)}`);

      if (totalPnl < 0 && Math.abs(totalPnl) >= Math.abs(MAX_DAILY_LOSS)) {
        console.warn(
          `⛔ Max daily loss breached on ticks! (PnL: ₹${totalPnl.toFixed(
            2
          )}). Initiating square off.`
        );
        lossTriggered = true;
        await squareOffAllPositions();
        setTimeout(async () => {
          try {
            await kc.logout();
            await fs.writeFile(HALT_PATH, "halted", "utf-8");
            console.log(
              "🔒 Session logged out. Trading halted for the day. Restart application to trade again."
            );
            process.exit(0); // Exit the process after halting
          } catch (logoutErr) {
            console.error(
              "❌ Error logging out or halting:",
              logoutErr.message
            );
          }
        }, SESSION_LOGOUT_DELAY);
      }
    } catch (err) {
      console.error("Tick-based PnL error:", err.message);
    }

    // --- Trailing Stop-Loss Logic ---
    for (const tick of ticks) {
      console.log("inside trailing sl logic::", tick);
      const token = tick.instrument_token;
      const symbol = Array.from(instrumentTokenMap.keys()).find(
        (key) => instrumentTokenMap.get(key) === token
      );
      if (!symbol) continue;

      // Iterate through all active trailing orders for this symbol
      for (const [key, trail] of activeTrailOrders.entries()) {
        console.log("inside activeTrailOrders loop::", key, trail);
        if (!key.startsWith(symbol)) continue; // Only process relevant trails

        const {
          entryPrice,
          slOrderId,
          isBuy,
          trailingActive,
          initialRisk,
          trailStepCount,
          qty,
        } = trail;

        const currentPrice = tick.last_price;

        // Update best price if current price is more favorable
        if (isBuy && currentPrice > trail.bestPrice) {
          trail.bestPrice = currentPrice;
        } else if (!isBuy && currentPrice < trail.bestPrice) {
          trail.bestPrice = currentPrice;
        }

        // Check if trailing should be activated
        if (!trailingActive) {
          const trailStartPrice = isBuy
            ? entryPrice + TRAIL_START_MULTIPLIER * initialRisk
            : entryPrice - TRAIL_START_MULTIPLIER * initialRisk;

          const activateTrailing = isBuy
            ? currentPrice >= trailStartPrice
            : currentPrice <= trailStartPrice;

          if (activateTrailing) {
            trail.trailingActive = true;
            console.log(
              `🚀 ${TRAIL_START_MULTIPLIER}R profit reached for ${symbol} (Qty: ${qty}) at ₹${currentPrice}. Trailing activated.`
            );
          } else {
            continue; // Don't trail if not activated yet
          }
        }

        // Calculate current SL and next trail trigger
        const currentSLTrigger = isBuy
          ? entryPrice - TRAIL_BUFFER + (trailStepCount - 1) * initialRisk
          : entryPrice + TRAIL_BUFFER - (trailStepCount - 1) * initialRisk;

        const nextTrailPriceTarget = isBuy
          ? currentSLTrigger + initialRisk
          : currentSLTrigger - initialRisk;

        const shouldTrail = isBuy
          ? currentPrice >= nextTrailPriceTarget
          : currentPrice <= nextTrailPriceTarget;

        if (shouldTrail) {
          trail.trailStepCount += 1;
          trail.lastTrailTrigger = currentPrice; // Record the price at which it trailed

          const newTrigger = isBuy
            ? entryPrice -
              TRAIL_BUFFER +
              trail.trailStepCount * initialRisk +
              trail.trailStepCount * initialRisk
            : entryPrice + TRAIL_BUFFER - trail.trailStepCount * initialRisk;
          const newLimit = isBuy
            ? newTrigger - SL_BUFFER
            : newTrigger + SL_BUFFER;

          try {
            await kc.modifyOrder("regular", slOrderId, {
              trigger_price: newTrigger,
              price: newLimit,
              quantity: qty, // Ensure quantity is passed
            });
            console.log(
              `🔁 SL Updated for ${symbol} (Qty: ${qty}): Trigger ₹${newTrigger.toFixed(
                2
              )}, Limit ₹${newLimit.toFixed(2)}`
            );
          } catch (err) {
            // Check if the order is already executed/cancelled before trying to modify
            if (err.message.includes("not in state to be modified")) {
              console.log(
                `ℹ️ SL order for ${symbol} (ID: ${slOrderId}) already executed or cancelled. Removing from active trails.`
              );
              activeTrailOrders.delete(key);
            } else {
              console.error(
                `❌ SL Update Failed for ${symbol} (ID: ${slOrderId}):`,
                err.message
              );
            }
          }
        }
      }
    }
  });

  ticker.on("error", (err) => console.error("📡 Ticker error:", err.message));
  ticker.on("close", () => console.log("Ticker disconnected."));
  ticker.on("reconnect", () => console.log("Ticker reconnected."));
}

// --- Express App Setup ---
const app = express();
app.use(express.json()); // For parsing JSON request bodies

// Optional: CORS setup for frontend
// const cors = require("cors");
// app.use(cors());

// Optional: SSE Endpoint for frontend
// app.get("/stream", (req, res) => {
//   res.setHeader("Content-Type", "text/event-stream");
//   res.setHeader("Cache-Control", "no-cache");
//   res.setHeader("Connection", "keep-alive");
//   res.flushHeaders(); // Flush headers to client

//   const sendUpdate = () => {
//     const data = [...activeTrailOrders.entries()].map(([key, t]) => {
//       const [symbol, orderId] = key.split('_'); // Extract symbol and orderId
//       return {
//         symbol,
//         slOrderId: t.slOrderId,
//         entryPrice: t.entryPrice,
//         qty: t.qty,
//         isBuy: t.isBuy,
//         trailingActive: t.trailingActive,
//         currentSLTrigger: t.isBuy
//           ? t.entryPrice - TRAIL_BUFFER + (t.trailStepCount - 1) * t.initialRisk
//           : t.entryPrice + TRAIL_BUFFER - (t.trailStepCount - 1) * t.initialRisk,
//         lastTrailTriggerPrice: t.lastTrailTrigger,
//         initialRisk: t.initialRisk,
//         trailStepCount: t.trailStepCount,
//       };
//     });
//     res.write(`data: ${JSON.stringify(data)}\n\n`);
//   };

//   const interval = setInterval(sendUpdate, 2000); // Send updates every 2 seconds
//   req.on("close", () => {
//     clearInterval(interval);
//     console.log("Frontend SSE connection closed.");
//   });
// });

// --- Server Initialization ---
app.listen(PORT, async () => {
  await setupLogging(); // Setup logging first

  console.log(`Starting server on http://localhost:${PORT}`);

  try {
    const haltedStatus = await fs.readFile(HALT_PATH, "utf-8");
    if (haltedStatus.trim() === "halted") {
      console.warn(
        "🚫 Trading is halted for the day as per HALT_TRADING.txt. Exiting..."
      );
      process.exit(0); // Exit if trading is halted
    }
  } catch (err) {
    // File might not exist, which is fine, means not halted
    if (err.code === "ENOENT") {
      console.log("HALT_TRADING.txt not found, proceeding with trading.");
    } else {
      console.error("Error checking halt file:", err.message);
    }
  }

  try {
    await init(); // Initialize Kite Connect
    const accessToken = await loadAccessToken();
    if (!accessToken) {
      console.error("❌ No access token found. Cannot start trading services.");
      return; // Exit if no access token
    }
    console.log("Kite Connect initialized and authenticated.");

    startOrderPolling();
    startTicker(accessToken);
    console.log("Trading services started: Order Polling and Ticker.");
  } catch (err) {
    console.error("❌ Failed to initialize trading services:", err.message);
    process.exit(1); // Exit with error code if initialization fails
  }
});
