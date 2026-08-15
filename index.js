import { ethers } from "ethers";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { runDeployerRiskCheck, formatRiskMessage } from "./deployerRisk.js";
import { startTaggedWalletRefresh, getTaggedWallets } from "./taggedWallets.js";
import { logEvent } from "./sheetLogger.js";
import { getMintStats, formatMintProgress, startMintProgressTracker } from "./mintStats.js";

dotenv.config();

const {
  RPC_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  STARTUP_LOOKBACK_BLOCKS = 50,
  MINT_WATCH_BLOCKS = 20,
} = process.env;

if (!RPC_URL || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error(
    "Missing required env vars. Check RPC_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID in your .env"
  );
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// EIP-165 interface IDs
const ERC721_INTERFACE_ID = "0x80ac58cd";
const ERC1155_INTERFACE_ID = "0xd9b67a26";

// Event topic hashes used to spot transfers/mints landing in tagged wallets
const ERC721_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ERC1155_TRANSFER_SINGLE_TOPIC = ethers.id(
  "TransferSingle(address,address,address,uint256,uint256)"
);
const ERC1155_TRANSFER_BATCH_TOPIC = ethers.id(
  "TransferBatch(address,address,address,uint256[],uint256[])"
);

// Minimal ABI: EIP-165 check + common "price" view functions collections use
const PROBE_ABI = [
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function mintPrice() view returns (uint256)",
  "function price() view returns (uint256)",
  "function cost() view returns (uint256)",
  "function PRICE() view returns (uint256)",
];

// contracts we're actively watching for mint-price confirmation
// address -> { deployBlock, name, kind }
const watching = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function sendAlert(message) {
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  } catch (err) {
    log("Telegram send failed:", err.message);
  }
}

function explorerLink(address) {
  return `https://robinhoodchain.blockscout.com/address/${address}`;
}

// Checks a block's Transfer/TransferSingle/TransferBatch logs for any
// activity landing in one of our tagged wallets, and alerts immediately.
async function checkTaggedWalletActivity(blockNumber) {
  const taggedWallets = getTaggedWallets();
  if (taggedWallets.size === 0) return; // no wallets configured, skip entirely

  try {
    // ERC-721: Transfer(from indexed, to indexed, tokenId) -> "to" is topics[2]
    const erc721Logs = await provider.getLogs({
      fromBlock: blockNumber,
      toBlock: blockNumber,
      topics: [ERC721_TRANSFER_TOPIC],
    });

    // ERC-1155: TransferSingle/TransferBatch -> "to" is topics[3]
    const erc1155SingleLogs = await provider.getLogs({
      fromBlock: blockNumber,
      toBlock: blockNumber,
      topics: [ERC1155_TRANSFER_SINGLE_TOPIC],
    });
    const erc1155BatchLogs = await provider.getLogs({
      fromBlock: blockNumber,
      toBlock: blockNumber,
      topics: [ERC1155_TRANSFER_BATCH_TOPIC],
    });

    for (const log_ of erc721Logs) {
      const to = "0x" + log_.topics[2]?.slice(26);
      await alertIfTagged(to, log_.address, log_.transactionHash, taggedWallets);
    }
    for (const log_ of [...erc1155SingleLogs, ...erc1155BatchLogs]) {
      const to = "0x" + log_.topics[3]?.slice(26);
      await alertIfTagged(to, log_.address, log_.transactionHash, taggedWallets);
    }
  } catch (err) {
    log("Error checking tagged wallet activity:", err.message);
  }
}

async function alertIfTagged(toAddress, contractAddress, txHash, taggedWallets) {
  const key = toAddress?.toLowerCase();
  if (!key || !taggedWallets.has(key)) return;

  const label = taggedWallets.get(key);
  const message =
    `🎯 *Tagged wallet activity*\n\n` +
    `Wallet: \`${toAddress}\` (${label})\n` +
    `Contract: \`${contractAddress}\`\n\n` +
    `[View contract](${explorerLink(contractAddress)}) · [View tx](https://robinhoodchain.blockscout.com/tx/${txHash})`;

  log(`TAGGED WALLET ALERT: ${label} (${toAddress}) received a token from ${contractAddress}`);
  await sendAlert(message);
  logEvent("Tagged Wallet", {
    contract: contractAddress,
    wallet: toAddress,
    details: `${label} — tx ${txHash}`,
  }).catch((err) => log("Sheet log failed:", err.message));
}

// Check whether a freshly deployed contract is ERC-721 / ERC-1155.
// Returns "721", "1155", or null.
async function detectNftKind(address) {
  const contract = new ethers.Contract(address, PROBE_ABI, provider);
  try {
    if (await contract.supportsInterface(ERC721_INTERFACE_ID)) return "721";
  } catch {
    // not all contracts implement supportsInterface cleanly — ignore and try next
  }
  try {
    if (await contract.supportsInterface(ERC1155_INTERFACE_ID)) return "1155";
  } catch {
    /* ignore */
  }
  return null;
}

// Try to read an on-chain price via common view function names.
// Returns a bigint price in wei, or null if none of the probes worked.
async function probeMintPrice(address) {
  const contract = new ethers.Contract(address, PROBE_ABI, provider);
  const probes = ["mintPrice", "price", "cost", "PRICE"];
  for (const fn of probes) {
    try {
      const value = await contract[fn]();
      return value; // bigint
    } catch {
      // function doesn't exist or reverted — try next probe
    }
  }
  return null; // no price-related view function found
}

// Handle a brand-new contract deployment transaction.
async function handleNewContract(txHash) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || !receipt.contractAddress) return;

  const address = receipt.contractAddress;
  const deployer = receipt.from;
  const kind = await detectNftKind(address);
  if (!kind) return; // not an NFT contract, ignore

  log(`New ERC-${kind} contract detected: ${address} (deployer: ${deployer})`);

  const price = await probeMintPrice(address);

  if (price !== null && price === 0n) {
    // Confirmed free mint via on-chain price view function
    await announceFreeMint(address, kind, "on-chain price() view returns 0", deployer);
  } else if (price !== null && price > 0n) {
    // Has a real price — not a free mint, no need to keep watching
    log(`  -> ${address} has nonzero mint price (${ethers.formatEther(price)} ETH), skipping`);
  } else {
    // No price view function found — fall back to watching early mint tx values
    watching.set(address.toLowerCase(), {
      deployBlock: receipt.blockNumber,
      kind,
      deployer,
    });
    log(`  -> No price view function on ${address}, will watch early mint txs instead`);
  }
}

// Fallback path: for contracts with no readable price function, inspect the
// value sent in early transactions TO that contract (i.e. mint calls).
async function checkWatchedContractsInBlock(block) {
  if (watching.size === 0) return;

  for (const tx of block.prefetchedTransactions ?? []) {
    if (!tx.to) continue;
    const key = tx.to.toLowerCase();
    const watched = watching.get(key);
    if (!watched) continue;

    if (tx.value === 0n) {
      await announceFreeMint(
        tx.to,
        watched.kind,
        "early mint transaction carried zero value",
        watched.deployer
      );
      watching.delete(key);
      continue;
    }

    // Stop watching after the configured window even if inconclusive —
    // avoids watching dead/failed deployments forever
    if (block.number - watched.deployBlock > Number(MINT_WATCH_BLOCKS)) {
      log(`  -> Gave up watching ${tx.to}: mint appears to cost ETH or is inactive`);
      watching.delete(key);
    }
  }
}

async function announceFreeMint(address, kind, reason, deployer) {
  const stats = await getMintStats(provider, address).catch(() => ({
    totalSupply: null,
    maxSupply: null,
  }));
  const progressLine = formatMintProgress(stats);

  const message =
    `🆓 *Free mint detected — Robinhood Chain*\n\n` +
    `Contract: \`${address}\`\n` +
    `Standard: ERC-${kind}\n` +
    `Signal: ${reason}\n` +
    (progressLine ? `Progress: ${progressLine}\n` : ``) +
    `\n[View on Blockscout](${explorerLink(address)})\n\n` +
    `_Deployer/wallet risk check running — follow-up incoming._`;

  log(`FREE MINT ALERT: ${address} (${reason})`);
  await sendAlert(message);
  logEvent("Free Mint", { contract: address, wallet: deployer || "", details: reason }).catch(
    (err) => log("Sheet log failed:", err.message)
  );

  // Track progress for a short window after detection — free mints move
  // fast, so periodic updates matter more than a single snapshot.
  startMintProgressTracker(
    provider,
    address,
    (progress) => {
      log(`Progress update for ${address}: ${progress}`);
      sendAlert(`📈 *Mint progress update*\n\nContract: \`${address}\`\n${progress}`);
      logEvent("Mint Progress", { contract: address, details: progress }).catch((err) =>
        log("Sheet log failed:", err.message)
      );
    },
    {
      pollSeconds: Number(process.env.MINT_PROGRESS_POLL_SECONDS || 45),
      durationMinutes: Number(process.env.MINT_PROGRESS_DURATION_MINUTES || 10),
    }
  );

  // Track B: run the deployer risk check in the background and send a
  // follow-up once it's done, so the initial alert isn't delayed by it.
  if (deployer) {
    runDeployerRiskCheck(deployer)
      .then((riskSummary) => {
        const followUp = formatRiskMessage(deployer, riskSummary);
        logEvent("Risk Check", {
          contract: address,
          wallet: deployer,
          details: `${riskSummary.label} (score: ${riskSummary.score})`,
        }).catch((err) => log("Sheet log failed:", err.message));
        return sendAlert(followUp);
      })
      .catch((err) => log("Risk check failed:", err.message));
  }
}

async function processBlock(blockNumber) {
  const block = await provider.getBlock(blockNumber, true);
  if (!block) return;

  // 1. Look for new contract creations in this block
  for (const tx of block.prefetchedTransactions ?? []) {
    if (tx.to === null) {
      handleNewContract(tx.hash).catch((err) =>
        log("Error handling new contract:", err.message)
      );
    }
  }

  // 2. Check contracts we're already watching for free-mint confirmation
  checkWatchedContractsInBlock(block).catch((err) =>
    log("Error checking watched contracts:", err.message)
  );

  // 3. Check for any tagged/smart wallet activity in this block
  checkTaggedWalletActivity(blockNumber).catch((err) =>
    log("Error in tagged wallet check:", err.message)
  );
}

async function main() {
  log("Starting Robinhood Chain free mint detector...");

  startTaggedWalletRefresh();

  const latest = await provider.getBlockNumber();
  const lookback = Number(STARTUP_LOOKBACK_BLOCKS);
  log(`Connected. Latest block: ${latest}. Scanning last ${lookback} blocks on startup...`);

  for (let b = Math.max(0, latest - lookback); b <= latest; b++) {
    await processBlock(b);
  }

  log("Startup scan complete. Listening for new blocks...");
  provider.on("block", (blockNumber) => {
    processBlock(blockNumber).catch((err) =>
      log(`Error processing block ${blockNumber}:`, err.message)
    );
  });

  await sendAlert("✅ Free mint detector is now live and watching Robinhood Chain.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
