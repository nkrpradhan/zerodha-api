const { kc } = require("./connect");

async function fetchPnL() {
  const positions = await kc.getPositions();
  const net = positions.net;
  let total = 0;

  const details = net.map((p) => {
    total += p.pnl;
    return {
      symbol: p.tradingsymbol,
      qty: p.quantity,
      pnl: p.pnl,
      avg: p.average_price,
      ltp: p.last_price,
    };
  });

  return { totalPnl: total, positions: details };
}

module.exports = { fetchPnL };
