# Sur Faucet

A clean, single-page faucet for the Sur Chain. Paste an address, get a fixed
amount of testnet **SUR**, rate-limited to one claim per address per day.

- **Frontend**: React + Vite, glassmorphism UI matching Sur Scanner.
- **Backend**: small Express server that signs a bank `MsgSend` with `@cosmjs`
  from a funded account, and enforces the per-address daily limit (persisted to
  `claims.json`).

## Setup

```bash
cd faucet
pnpm install            # or npm install
cp .env.example .env    # then set FAUCET_MNEMONIC to a FUNDED account's mnemonic
```

`FAUCET_MNEMONIC` must be an account that holds SUR on the target chain (e.g. a
funded local account). All other settings have local-chain defaults.

### Production faucet address

The account backing https://faucet.surprotocol.org/ is:

```
sur1pn3clklw4eng56pt2auln8ywt42vk4977run0q
```

Fund this address to keep the live faucet stocked.

## Run

Dev (frontend + API together, with hot reload):

```bash
pnpm dev
# UI:  http://localhost:5180   (proxies /api → http://localhost:8787)
```

Production (build the UI, serve everything from the API server):

```bash
pnpm build
pnpm start              # serves UI + API on http://localhost:8787
```

## How it works

- `GET /api/info` → amount, denom, faucet address, cooldown, explorer URL.
- `POST /api/claim { address }` → validates the `sur1…` address, checks the
  per-address cooldown, signs + broadcasts a `MsgSend` of `AMOUNT` SUR, and
  records the claim. Returns `{ txHash }`. Returns `429` with `retryAfterMs`
  if the address already claimed within the cooldown.

The daily limit is keyed by recipient address. The reservation is written
**before** sending and rolled back on failure, so retries and concurrent
requests can't double-dispense.

## Config

See `.env.example` — `AMOUNT`, `COOLDOWN_HOURS`, `RPC_ENDPOINT`, `DENOM`,
`GAS_PRICE`, `EXPLORER_URL`, `PORT`.
