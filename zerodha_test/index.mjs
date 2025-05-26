import { KiteConnect } from "kiteconnect";
import fs from "fs/promises";

const apiKey = "ar217a1r0m2fd4t0";
const apiSecret = "r9vypnqdqa8ab1dws5w6l7px6j2uxkth";
const requestToken = "iF6jyMYXlt0MCUdJZW8AM9BfzY6YmTbW"; // only needed the first time

const kc = new KiteConnect({ api_key: apiKey });
const TOKEN_PATH = "./access_token.json";

async function init() {
  try {
    const tokenData = await loadAccessToken();

    if (!tokenData || !tokenData.access_token) {
      // Only once: generate session and save token
      const session = await kc.generateSession(requestToken, apiSecret);
      kc.setAccessToken(session.access_token);
      await saveAccessToken(session.access_token);
      console.log("New session created and token saved.");
    } else {
      kc.setAccessToken(tokenData.access_token);
      console.log("Reusing saved access token.");
    }

    // await getProfile();
    // await getPositions();
    setInterval(getPositions, 3000);
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

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

async function getProfile() {
  try {
    const profile = await kc.getProfile();
    console.log("Profile:", profile);
  } catch (err) {
    console.error("Error getting profile:", err);
  }
}

async function getPositions() {
  try {
    const positions = await kc.getPositions();
    console.log("Positions:", positions);
  } catch (err) {
    console.error("Error getting positions:", err);
  }
}

// Run the initialization
init();

