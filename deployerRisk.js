// Track B: deployer wallet risk check.
// Called after a free mint is detected (Track A) to add context on whether
// the deployer looks like a repeat/serial rugger or a fresh, unproven wallet.
//
// Uses Blockscout's Etherscan-compatible API (no API key needed, free) to
// pull an address's full transaction history.

const BLOCKSCOUT_API_BASE =
  process.env.BLOCKSCOUT_API_BASE || "https://robinhoodchain.blockscout.com/api";

const DORMANT_DAYS_THRESHOLD = 30; // no activity in this many days = "dormant"
const FRESH_FUNDER_TX_THRESHOLD = 5; // funder wallet with fewer txs than this = "fresh/unproven"

function log(...args) {
  console.log(new Date().toISOString(), "[risk]", ...args);
}

async function blockscoutTxList(address) {
  const url = `${BLOCKSCOUT_API_BASE}?module=account&action=txlist&address=${address}&sort=asc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Blockscout API error: ${res.status}`);
  const data = await res.json();
  // Etherscan-compatible APIs return { status, message, result: [...] }
  if (!Array.isArray(data.result)) return [];
  return data.result;
}

// Find contracts this address has deployed (txs with a non-empty contractAddress field)
function extractDeployedContracts(txList, deployerAddress) {
  return txList.filter(
    (tx) =>
      tx.from?.toLowerCase() === deployerAddress.toLowerCase() &&
      tx.contractAddress &&
      tx.contractAddress !== ""
  );
}

// Check whether a given contract address has any recent activity
async function checkContractLiveness(contractAddress) {
  try {
    const txs = await blockscoutTxList(contractAddress);
    if (txs.length === 0) return { alive: false, lastActivity: null };
    const lastTx = txs[txs.length - 1]; // ascending order, so last = most recent
    const lastTimestamp = Number(lastTx.timeStamp) * 1000;
    const daysSinceActivity = (Date.now() - lastTimestamp) / (1000 * 60 * 60 * 24);
    return {
      alive: daysSinceActivity < DORMANT_DAYS_THRESHOLD,
      lastActivity: new Date(lastTimestamp).toISOString(),
      daysSinceActivity: Math.round(daysSinceActivity),
    };
  } catch (err) {
    log(`Couldn't check liveness for ${contractAddress}:`, err.message);
    return { alive: null, lastActivity: null };
  }
}

// Find the first-ever incoming transaction to a wallet (its funding source)
function findFundingTx(txList, address) {
  return txList.find((tx) => tx.to?.toLowerCase() === address.toLowerCase());
}

// Runs the full deployer risk check. Returns a summary object.
export async function runDeployerRiskCheck(deployerAddress) {
  const summary = {
    deployer: deployerAddress,
    priorContractsCount: 0,
    deadContracts: 0,
    aliveContracts: 0,
    fundingSource: null,
    fundingSourceTxCount: null,
    fundingSourceLooksFresh: null,
    score: 0,
    label: "Unknown",
    notes: [],
  };

  let deployerTxs;
  try {
    deployerTxs = await blockscoutTxList(deployerAddress);
  } catch (err) {
    summary.notes.push(`Could not fetch deployer history: ${err.message}`);
    summary.label = "Unable to verify";
    return summary;
  }

  // 1. Prior contracts deployed by this wallet
  const priorContracts = extractDeployedContracts(deployerTxs, deployerAddress);
  summary.priorContractsCount = priorContracts.length;

  if (priorContracts.length === 0) {
    summary.notes.push("No prior contract deployments found — fresh deployer wallet");
  } else {
    // Check liveness of each prior contract (skip the one we're currently alerting on)
    for (const tx of priorContracts) {
      const liveness = await checkContractLiveness(tx.contractAddress);
      if (liveness.alive === true) summary.aliveContracts++;
      if (liveness.alive === false) summary.deadContracts++;
    }
    if (summary.deadContracts > 0) {
      summary.notes.push(
        `${summary.deadContracts} of ${priorContracts.length} prior contract(s) show no activity in ${DORMANT_DAYS_THRESHOLD}+ days`
      );
      summary.score -= 3 * summary.deadContracts;
    }
    if (summary.aliveContracts > 0) {
      summary.notes.push(`${summary.aliveContracts} prior contract(s) still show recent activity`);
      summary.score += 2 * summary.aliveContracts;
    }
  }

  // 2. Funding source trace
  const fundingTx = findFundingTx(deployerTxs, deployerAddress);
  if (fundingTx) {
    summary.fundingSource = fundingTx.from;
    try {
      const funderTxs = await blockscoutTxList(fundingTx.from);
      summary.fundingSourceTxCount = funderTxs.length;
      summary.fundingSourceLooksFresh = funderTxs.length < FRESH_FUNDER_TX_THRESHOLD;
      if (summary.fundingSourceLooksFresh) {
        summary.notes.push(
          `Funding wallet has very little history (${funderTxs.length} txs) — looks freshly created`
        );
        summary.score -= 2;
      } else {
        summary.notes.push(
          `Funding wallet has established history (${funderTxs.length} txs)`
        );
        summary.score += 1;
      }
    } catch (err) {
      summary.notes.push(`Could not verify funding wallet: ${err.message}`);
    }
  } else {
    summary.notes.push("No funding transaction found for this wallet");
  }

  // 3. Overall label
  if (summary.score >= 2) summary.label = "Lower risk signals";
  else if (summary.score <= -3) summary.label = "⚠️ High risk — caution";
  else summary.label = "Neutral / not enough history";

  return summary;
}

// Formats the risk check result as a Telegram follow-up message
export function formatRiskMessage(deployerAddress, riskSummary) {
  const lines = [
    `🔍 *Deployer risk check*`,
    ``,
    `Deployer: \`${deployerAddress}\``,
    `Verdict: *${riskSummary.label}* (score: ${riskSummary.score})`,
    ``,
    ...riskSummary.notes.map((n) => `• ${n}`),
  ];
  if (riskSummary.fundingSource) {
    lines.push(``, `Funded by: \`${riskSummary.fundingSource}\``);
  }
  lines.push(
    ``,
    `_Heuristic signal only — not financial advice. Always verify manually before minting._`
  );
  return lines.join("\n");
}
