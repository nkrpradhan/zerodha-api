const { KiteConnect } = require("kiteconnect");
const fs = require("fs/promises");
const { kite: config } = require("../config");

const kc = new KiteConnect({ api_key: config.apiKey });
const TOKEN_PATH = "./access_token.json";

async function initKite() {
  try {
    const tokenData = await fs.readFile(TOKEN_PATH, "utf-8");
    kc.setAccessToken(JSON.parse(tokenData).access_token);
  } catch {
    const session = await kc.generateSession(
      config.requestToken,
      config.apiSecret
    );
    kc.setAccessToken(session.access_token);
    await fs.writeFile(
      TOKEN_PATH,
      JSON.stringify({ access_token: session.access_token }),
      "utf-8"
    );
  }
}

module.exports = { kc, initKite };
