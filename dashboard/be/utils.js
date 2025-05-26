// backend/utils.js
let dynamicTokenMap = {};

async function buildDynamicTokenMap(kc) {
  try {
    const instruments = await kc.getInstruments("NFO");
    const niftyOptions = instruments.filter(
      (i) => i.name === "NIFTY" && i.instrument_type === "OPT"
    );

    dynamicTokenMap = {};
    for (const i of niftyOptions) {
      dynamicTokenMap[i.tradingsymbol] = i.instrument_token;
    }

    console.log("✅ Dynamic token map built with", Object.keys(dynamicTokenMap).length, "Nifty options.");
  } catch (err) {
    console.error("❌ Failed to build token map:", err.message);
  }
}

function getSymbolFromToken(token) {
  return Object.entries(dynamicTokenMap).find(([_, val]) => val === token)?.[0] || null;
}

function getTokenFromSymbol(symbol) {
  return dynamicTokenMap[symbol] || null;
}

module.exports = {
  buildDynamicTokenMap,
  getSymbolFromToken,
  getTokenFromSymbol,
};
