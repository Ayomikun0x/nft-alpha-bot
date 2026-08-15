// Tagged wallet watchlist — pulled from a Google Sheet published as CSV.
// Sheet format expected: two columns, "Address" and "Label" (header row required).
//
// To set this up:
//   1. Create a Google Sheet with columns: Address | Label
//   2. File -> Share -> Publish to web -> select the sheet -> CSV -> Publish
//   3. Copy the URL it gives you into TAGGED_WALLETS_SHEET_URL in your .env

const SHEET_URL = process.env.TAGGED_WALLETS_SHEET_URL || null;
const REFRESH_INTERVAL_MS = Number(process.env.TAGGED_WALLETS_REFRESH_MINUTES || 5) * 60 * 1000;

// address (lowercase) -> label
let taggedWallets = new Map();

function log(...args) {
  console.log(new Date().toISOString(), "[wallets]", ...args);
}

// Minimal CSV parser — handles quoted fields with commas inside them.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') inQuotes = true;
      else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        if (field !== "" || row.length > 0) {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        }
      } else {
        field += char;
      }
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function refreshTaggedWallets() {
  if (!SHEET_URL) {
    log("No TAGGED_WALLETS_SHEET_URL set — tagged wallet alerts disabled");
    return;
  }

  try {
    const res = await fetch(SHEET_URL);
    if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
    const csvText = await res.text();
    const rows = parseCsv(csvText);

    if (rows.length === 0) return;

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const addressCol = header.indexOf("address");
    const labelCol = header.indexOf("label");

    if (addressCol === -1) {
      log("Sheet missing an 'Address' column — check your sheet headers");
      return;
    }

    const updated = new Map();
    for (const row of rows.slice(1)) {
      const address = row[addressCol]?.trim().toLowerCase();
      if (!address || !address.startsWith("0x")) continue;
      const label = labelCol !== -1 ? row[labelCol]?.trim() : "";
      updated.set(address, label || "tagged wallet");
    }

    taggedWallets = updated;
    log(`Refreshed tagged wallet list: ${taggedWallets.size} wallet(s) loaded`);
  } catch (err) {
    log("Failed to refresh tagged wallets:", err.message);
  }
}

export function getTaggedWallets() {
  return taggedWallets;
}

export function startTaggedWalletRefresh() {
  refreshTaggedWallets(); // initial load
  setInterval(refreshTaggedWallets, REFRESH_INTERVAL_MS);
}
