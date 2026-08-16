// Manually-triggered mint execution.
//
// IMPORTANT: this module holds a real wallet capable of signing and
// sending real transactions. It NEVER mints automatically — every mint
// here is the direct result of a command you send (see the /mint
// command wiring in index.js). Nothing in this file runs on a timer
// or in response to a detected contract by itself.
//
// SECURITY NOTES (read before setting this up):
// - Use a dedicated "burner" wallet for this bot — never your main wallet.
// - Only fund it with what you're truly OK losing. Minting is irreversible
//   and gas is spent whether or not the mint succeeds.
// - Never share MINT_WALLET_PRIVATE_KEY with anyone, never commit it to
//   GitHub, only set it as a private Railway environment variable.

import { ethers } from "ethers";

const MINT_WALLET_PRIVATE_KEY = process.env.MINT_WALLET_PRIVATE_KEY || null;

// Common mint function signatures projects use. We try each in order
// until one doesn't revert. Covers the vast majority of standard mints.
const MINT_ABI = [
  "function mint() payable",
  "function mint(uint256 quantity) payable",
  "function publicMint() payable",
  "function publicMint(uint256 quantity) payable",
  "function claim() payable",
  "function claim(uint256 quantity) payable",
];

function log(...args) {
  console.log(new Date().toISOString(), "[mintBot]", ...args);
}

function getWallet(provider) {
  if (!MINT_WALLET_PRIVATE_KEY) {
    throw new Error(
      "MINT_WALLET_PRIVATE_KEY not set — mint bot is disabled until configured"
    );
  }
  return new ethers.Wallet(MINT_WALLET_PRIVATE_KEY, provider);
}

// Attempts to mint `quantity` from `contractAddress` using the configured
// wallet. Tries each known mint function signature until one works.
// Returns { success, txHash, error, functionUsed }.
export async function executeMint(provider, contractAddress, quantity = 1) {
  let wallet;
  try {
    wallet = getWallet(provider);
  } catch (err) {
    return { success: false, error: err.message };
  }

  const contract = new ethers.Contract(contractAddress, MINT_ABI, wallet);

  const attempts = [
    { fn: "mint", args: [] },
    { fn: "mint", args: [quantity] },
    { fn: "publicMint", args: [] },
    { fn: "publicMint", args: [quantity] },
    { fn: "claim", args: [] },
    { fn: "claim", args: [quantity] },
  ];

  for (const attempt of attempts) {
    try {
      log(`Trying ${attempt.fn}(${attempt.args.join(", ")}) on ${contractAddress}`);
      // Static call first to check it won't revert, without spending gas
      await contract[attempt.fn].staticCall(...attempt.args);

      // If the static call succeeded, send the real transaction
      const tx = await contract[attempt.fn](...attempt.args, {
        // A modest priority boost for speed — tune via env if needed
        maxPriorityFeePerGas: ethers.parseUnits(
          process.env.MINT_PRIORITY_GWEI || "2",
          "gwei"
        ),
      });

      log(`Sent tx ${tx.hash}, waiting for confirmation...`);
      const receipt = await tx.wait();

      return {
        success: receipt.status === 1,
        txHash: tx.hash,
        functionUsed: `${attempt.fn}(${attempt.args.join(", ")})`,
      };
    } catch (err) {
      // This function signature didn't work — try the next one
      log(`  ${attempt.fn}(${attempt.args.join(", ")}) failed: ${err.shortMessage || err.message}`);
    }
  }

  return {
    success: false,
    error:
      "No known mint function signature worked on this contract. It may use a custom function, require an allowlist proof, or the public sale may not be live.",
  };
}

// Returns the mint wallet's current balance, or null if not configured.
export async function getMintWalletBalance(provider) {
  if (!MINT_WALLET_PRIVATE_KEY) return null;
  const wallet = new ethers.Wallet(MINT_WALLET_PRIVATE_KEY);
  const balance = await provider.getBalance(wallet.address);
  return { address: wallet.address, balance: ethers.formatEther(balance) };
}
