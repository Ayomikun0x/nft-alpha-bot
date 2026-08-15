// Writes a running log of every alert to a Google Sheet via an Apps Script
// Web App endpoint — no Google Cloud Console or service account needed.
// Setup is documented in README.md under "Track D: Alert logging".

const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL || null;

let warnedOnce = false;

function log(...args) {
  console.log(new Date().toISOString(), "[sheetLog]", ...args);
}

// type: "Free Mint" | "Risk Check" | "Tagged Wallet"
export async function logEvent(type, { contract = "", wallet = "", details = "" } = {}) {
  if (!LOG_WEBHOOK_URL) {
    if (!warnedOnce) {
      log("LOG_WEBHOOK_URL not set — sheet logging disabled");
      warnedOnce = true;
    }
    return; // logging not configured, silently skip — never block alerts on this
  }

  try {
    await fetch(LOG_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        type,
        contract,
        wallet,
        details,
      }),
      redirect: "follow",
    });
  } catch (err) {
    log("Failed to log event:", err.message);
  }
}
