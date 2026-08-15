import { ethers } from "ethers";

// Common view function names collections use for current/max supply.
// We try each in order since there's no single standard for this.
const SUPPLY_ABI = [
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function maxTotalSupply() view returns (uint256)",
  "function MAX_ELEMENTS() view returns (uint256)",
  "function TOTAL_SUPPLY() view returns (uint256)",
];

const MAX_SUPPLY_FN_NAMES = [
  "maxSupply",
  "MAX_SUPPLY",
  "maxTotalSupply",
  "MAX_ELEMENTS",
  "TOTAL_SUPPLY",
];

function log(...args) {
  console.log(new Date().toISOString(), "[mintStats]", ...args);
}

// Reads current minted count and (if available) max supply from a contract.
// Returns { totalSupply: bigint|null, maxSupply: bigint|null }
export async function getMintStats(provider, address) {
  const contract = new ethers.Contract(address, SUPPLY_ABI, provider);

  let totalSupply = null;
  try {
    totalSupply = await contract.totalSupply();
  } catch {
    // ERC-1155 collections often don't implement totalSupply() at all — that's fine
  }

  let maxSupply = null;
  for (const fnName of MAX_SUPPLY_FN_NAMES) {
    try {
      maxSupply = await contract[fnName]();
      break; // first one that works wins
    } catch {
      // try next candidate name
    }
  }

  return { totalSupply, maxSupply };
}

// Formats mint stats as a short "4/555" or "4 minted" style string.
// Returns null if no supply data could be read at all.
export function formatMintProgress({ totalSupply, maxSupply }) {
  if (totalSupply !== null && maxSupply !== null && maxSupply > 0n) {
    return `${totalSupply.toString()}/${maxSupply.toString()} minted`;
  }
  if (totalSupply !== null) {
    return `${totalSupply.toString()} minted so far`;
  }
  return null;
}

// Polls mint progress periodically for a limited window after detection,
// calling onUpdate(progressString, stats) whenever the count changes.
// Stops early if the collection appears sold out.
export function startMintProgressTracker(provider, address, onUpdate, options = {}) {
  const pollIntervalMs = (options.pollSeconds ?? 45) * 1000;
  const durationMs = (options.durationMinutes ?? 10) * 60 * 1000;
  const startedAt = Date.now();

  let lastSeenTotal = null;

  const intervalId = setInterval(async () => {
    if (Date.now() - startedAt > durationMs) {
      clearInterval(intervalId);
      return;
    }

    try {
      const stats = await getMintStats(provider, address);
      if (stats.totalSupply === null) return; // nothing to compare, skip this round

      if (lastSeenTotal === null || stats.totalSupply !== lastSeenTotal) {
        lastSeenTotal = stats.totalSupply;
        const progress = formatMintProgress(stats);
        if (progress) onUpdate(progress, stats);
      }

      // Stop early once sold out — nothing left to track
      if (stats.maxSupply !== null && stats.totalSupply >= stats.maxSupply) {
        log(`${address} appears sold out (${stats.totalSupply}/${stats.maxSupply}), stopping tracker`);
        clearInterval(intervalId);
      }
    } catch (err) {
      log(`Progress poll failed for ${address}:`, err.message);
    }
  }, pollIntervalMs);

  return intervalId; // caller can clearInterval() manually if needed
}
