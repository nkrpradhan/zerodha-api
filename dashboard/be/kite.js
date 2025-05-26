// backend/kite.js
//request token url - https://kite.zerodha.com/connect/login?v=3&api_key=x52bzblcgddkjywj
const fs = require("fs/promises");
const { KiteConnect, KiteTicker } = require("kiteconnect");

const API_KEY = "dd";
const API_SECRET = "ddd";
const REQUEST_TOKEN = "dddd"; // <-- Only needed once
const TOKEN_PATH = "./access_token.json";

const kc = new KiteConnect({ api_key: API_KEY });

async function init() {
  try {
    const tokenData = await loadAccessToken();

    if (!tokenData) {
      // Only needed once to get access_token
      const session = await kc.generateSession(REQUEST_TOKEN, API_SECRET);
      kc.setAccessToken(session.access_token);
      await saveAccessToken(session.access_token);
      console.log("✅ New session created and token saved.");
    } else {
      kc.setAccessToken(tokenData);
      console.log("✅ Reusing saved access token.");
    }
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

async function loadAccessToken() {
  try {
    const data = await fs.readFile(TOKEN_PATH, "utf-8");
    const { access_token } = JSON.parse(data);
    kc.setAccessToken(access_token);
    return access_token;
  } catch (e) {
    console.warn(
      "⚠️ Token file not found. You must login to get a fresh token."
    );
    return null;
  }
}

async function saveAccessToken(access_token) {
  await fs.writeFile(TOKEN_PATH, JSON.stringify({ access_token }), "utf-8");
  kc.setAccessToken(access_token);
}

function getKiteClient() {
  return kc;
}

function getTicker(access_token) {
  return new KiteTicker({ api_key: API_KEY, access_token });
}

module.exports = {
  init,
  kc,
  getKiteClient,
  loadAccessToken,
  saveAccessToken,
  getTicker,
};
