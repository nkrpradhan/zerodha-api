// authServer.js
const express = require("express");
const fs = require("fs/promises");
const { KiteConnect } = require("kiteconnect");

const app = express();
const PORT = 3030;

const API_KEY = "x52bzblcgddkjywj";
const API_SECRET = "0yo6umuloff2pavuk2mzit2g3u12v85p";
const REDIRECT_URI = "http://localhost:3030/auth";
const TOKEN_PATH = "./access_token.json";

const kc = new KiteConnect({ api_key: API_KEY });

app.get("/login", async (req, res) => {
  const loginUrl = kc.getLoginURL();
  const open = (await import("open")).default;
  await open(loginUrl);
  res.send("🔐 Login window opened. Complete login in browser.");
});

app.get("/auth", async (req, res) => {
  const requestToken = req.query.request_token;

  try {
    const session = await kc.generateSession(requestToken, API_SECRET);
    kc.setAccessToken(session.access_token);
    await fs.writeFile(TOKEN_PATH, JSON.stringify({ access_token: session.access_token }), "utf8");
    res.send("✅ Access token saved! You can now run the trading bot.");
  } catch (err) {
    console.error("Auth error:", err.message);
    res.status(500).send("❌ Failed to authenticate.");
  }
});

app.listen(PORT, () => {
  console.log(`⚙️ Auth server running at http://localhost:${PORT}/login`);
});
