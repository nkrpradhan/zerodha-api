const { fetchPnL } = require("../kite/pnl");
const { squareOffAll } = require("../kite/orders");
const { thresholds } = require("../config");

function socketHandler(io) {
  io.on("connection", (socket) => {
    console.log("🟢 Frontend connected");

    const interval = setInterval(async () => {
      try {
        const { totalPnl, positions } = await fetchPnL();
        socket.emit("pnlUpdate", { totalPnl, positions });

        // Risk Management
        if (
          totalPnl <= thresholds.maxLoss ||
          totalPnl >= thresholds.maxProfit
        ) {
          console.log(`🔔 Threshold hit: ₹${totalPnl}. Exiting...`);
          await squareOffAll();
        }
      } catch (err) {
        console.error("PnL Fetch Error:", err.message);
      }
    }, 5000);

    socket.on("squareOffAll", async () => {
      console.log("🔘 Manual square-off triggered.");
      await squareOffAll();
    });

    socket.on("disconnect", () => {
      clearInterval(interval);
      console.log("🔴 Frontend disconnected");
    });
  });
}

module.exports = socketHandler;
