# Robinhood Chain — Free Mint Detector

Watches Robinhood Chain (chain ID 4663) for new NFT contract deployments
(ERC-721 / ERC-1155) and pushes an instant Telegram alert when it detects a
**free mint**. This is Track A ("speed lane") from our plan — deployer
risk-scoring (Track B) plugs in later via the `announceFreeMint` hook in
`index.js`.

## How it works

1. Watches every new block for contract-creation transactions.
2. For each new contract, checks EIP-165 `supportsInterface` to confirm it's
   ERC-721 or ERC-1155 — ignores everything else.
3. Tries to read a price via common view functions (`mintPrice`, `price`,
   `cost`, `PRICE`). If it reads `0`, that's a confirmed free mint.
4. If no price function exists, falls back to watching the first mint
   transactions sent to that contract — if one carries `0` value, that's
   treated as a free mint too.
5. Sends a Telegram alert the moment either signal fires.

This is a heuristic, not a guarantee — some contracts gate minting through
allowlists, proxies, or non-standard functions this won't catch. Treat
alerts as "worth checking," not certainty.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get an Alchemy RPC endpoint (recommended)

The public Robinhood Chain RPC (`rpc.mainnet.chain.robinhood.com`) is
free but rate-limited and not meant for production polling. For a bot
that's watching every block continuously:

1. Sign up free at https://www.alchemy.com
2. Create an app for **Robinhood Chain Mainnet**
3. Copy the HTTPS RPC URL it gives you

If you'd rather start on the free public RPC and upgrade later, that's
fine too — just drop it into `RPC_URL` in your `.env` and expect
occasional rate-limit errors under heavy load.

### 3. Configure environment variables

```bash
cp .env.example .env
```

Fill in:
- `RPC_URL` — your Alchemy endpoint (or the public fallback)
- `TELEGRAM_BOT_TOKEN` — your existing bot's token from @BotFather
- `TELEGRAM_CHAT_ID` — the chat/channel to post alerts to

To find your chat ID if you don't have it: message your bot once, then
visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
and read the `"chat":{"id": ...}` field in the response.

### 4. Run it locally to test

```bash
npm start
```

You should see a startup log, a scan of recent blocks, then "Listening
for new blocks..." — and a confirmation message in your Telegram chat.

### 5. Deploy to Railway (for 24/7 uptime)

1. Push this folder to a GitHub repo (or use Railway's CLI to deploy
   directly from your machine)
2. In Railway: New Project → Deploy from GitHub repo
3. Add the same environment variables from your `.env` in Railway's
   "Variables" tab (never commit your real `.env` file)
4. Railway will run `npm start` automatically based on `package.json`

Railway's free tier sleeps/limits usage after a threshold of monthly
hours — keep an eye on your usage dashboard once it's running
continuously.

## Track B: Deployer risk check (now live)

Right after a free-mint alert fires, the bot automatically runs a
background check on the deployer wallet (`deployerRisk.js`) and sends a
follow-up message a few seconds later with:

- How many prior contracts that wallet has deployed, and whether those
  old contracts still show recent on-chain activity (alive) or have
  gone quiet for 30+ days (possible dead/rugged collection)
- The deployer's original funding source — the wallet that sent it its
  first-ever transaction — and whether that funding wallet has
  established history (e.g. an exchange) or looks freshly created
  just for this one deployment
- A simple score and verdict: "Lower risk signals", "Neutral / not
  enough history", or "⚠️ High risk — caution"

This uses Blockscout's free API (no key needed) — no additional signup
required for this part. It's a heuristic, not certainty: a new wallet
with no history isn't automatically a scam, and a wallet with alive
prior contracts isn't automatically safe. Always sanity-check manually
before minting anything.

## What's next (not built yet)

- **Tagged smart wallets**: a watchlist of known good wallets, alerting
  when one of them mints/buys
- **CT mention tracking**: manual/list-based for now, no paid Twitter API
