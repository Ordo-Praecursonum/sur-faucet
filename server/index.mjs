import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate'
import { fromBech32 } from '@cosmjs/encoding'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- Config (env, with local-chain defaults) ---
const PORT = Number(process.env.PORT || 8787)
const RPC = process.env.RPC_ENDPOINT || 'http://localhost:26657'
const DENOM = process.env.DENOM || 'usur'
const DISPLAY_DENOM = process.env.DISPLAY_DENOM || 'SUR'
const EXPONENT = Number(process.env.EXPONENT || 6)
const AMOUNT = Number(process.env.AMOUNT || 10) // SUR per base claim
const SHARE_AMOUNT = Number(process.env.SHARE_AMOUNT || 20) // SUR per verified share
const X_HANDLE = process.env.X_HANDLE || '@SurProtocol'
const PREFIX = process.env.ADDRESS_PREFIX || 'sur'
const COOLDOWN_MS = Number(process.env.COOLDOWN_HOURS || 24) * 3600 * 1000
const GAS_PRICE = process.env.GAS_PRICE || `0.025${DENOM}`
const EXPLORER_URL = process.env.EXPLORER_URL || 'http://localhost:5173'
const MNEMONIC = process.env.FAUCET_MNEMONIC

if (!MNEMONIC) {
  console.error(
    '\n✗ FAUCET_MNEMONIC is not set. Copy .env.example to .env and set it to a funded account mnemonic.\n'
  )
  process.exit(1)
}

const toMicro = (sur) => BigInt(Math.round(sur * 10 ** EXPONENT)).toString()

// --- Persistence helpers ---
const fileFor = (name) => join(__dirname, '..', name)
function load(name, fallback) {
  try {
    const f = fileFor(name)
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    /* ignore */
  }
  return fallback
}
function save(name, data) {
  try {
    writeFileSync(fileFor(name), JSON.stringify(data))
  } catch (e) {
    console.error(`could not persist ${name}:`, e.message)
  }
}

// base claims: address -> last claim ms
let claims = load('claims.json', {})
// share bonus: { posts: { tweetId: address }, bonus: { address: lastMs } }
let shares = load('shares.json', { posts: {}, bonus: {} })

// --- Wallet ---
let wallet
let faucetAddress
async function initWallet() {
  wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: PREFIX })
  const [acc] = await wallet.getAccounts()
  faucetAddress = acc.address
}

// Sign + broadcast a transfer of `sur` SUR to `address`.
async function dispense(address, sur, memo) {
  const client = await SigningStargateClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE),
  })
  try {
    const result = await client.sendTokens(
      faucetAddress,
      address,
      [{ denom: DENOM, amount: toMicro(sur) }],
      'auto',
      memo
    )
    return result.transactionHash
  } finally {
    client.disconnect()
  }
}

function validAddress(address) {
  try {
    return fromBech32(address).prefix === PREFIX
  } catch {
    return false
  }
}

// Parse an X/Twitter status URL → { handle, id }.
function parsePost(url) {
  const m = String(url || '').match(
    /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/i
  )
  return m ? { handle: m[1], id: m[2] } : null
}

// Verify a post mentions @SurProtocol via X's public oEmbed (no auth needed).
async function postMentionsHandle(url) {
  const normalized = url.replace('://x.com', '://twitter.com')
  const endpoint = `https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(
    normalized
  )}`
  const res = await fetch(endpoint, {
    headers: { 'User-Agent': 'SurFaucet/1.0' },
  })
  if (!res.ok) return { reachable: false, mentions: false }
  const data = await res.json()
  const haystack = `${data.html || ''} ${data.author_name || ''} ${
    data.author_url || ''
  }`.toLowerCase()
  const needle = X_HANDLE.replace(/^@/, '').toLowerCase()
  return { reachable: true, mentions: haystack.includes(needle) }
}

const app = express()
app.use(cors())
app.use(express.json())

app.get('/api/info', (_req, res) => {
  res.json({
    amount: AMOUNT,
    shareAmount: SHARE_AMOUNT,
    xHandle: X_HANDLE,
    denom: DISPLAY_DENOM,
    faucetAddress,
    cooldownHours: COOLDOWN_MS / 3_600_000,
    explorerUrl: EXPLORER_URL,
    prefix: PREFIX,
  })
})

// --- Base daily claim ---
app.post('/api/claim', async (req, res) => {
  const address = String(req.body?.address || '').trim()
  if (!validAddress(address)) {
    return res.status(400).json({ error: `Enter a valid ${PREFIX}1… address.` })
  }

  const now = Date.now()
  const last = claims[address]
  if (last && now - last < COOLDOWN_MS) {
    return res.status(429).json({
      error: 'This address already claimed.',
      retryAfterMs: COOLDOWN_MS - (now - last),
    })
  }

  claims[address] = now
  save('claims.json', claims)
  try {
    const txHash = await dispense(address, AMOUNT, 'Sur faucet')
    res.json({ txHash, amount: AMOUNT, denom: DISPLAY_DENOM })
  } catch (e) {
    delete claims[address]
    save('claims.json', claims)
    console.error('claim failed:', e?.message || e)
    res.status(500).json({
      error:
        'Faucet transfer failed. The faucet account may be out of funds or the node is unreachable.',
    })
  }
})

// --- Bonus claim by sharing a post that mentions @SurProtocol ---
app.post('/api/share-claim', async (req, res) => {
  const address = String(req.body?.address || '').trim()
  const postUrl = String(req.body?.postUrl || '').trim()

  if (!validAddress(address)) {
    return res.status(400).json({ error: `Enter a valid ${PREFIX}1… address.` })
  }

  const post = parsePost(postUrl)
  if (!post) {
    return res
      .status(400)
      .json({ error: 'Paste the link to your X post (x.com/<you>/status/…).' })
  }

  // One-time use: a given post can never be redeemed twice (by anyone).
  if (shares.posts[post.id]) {
    return res
      .status(409)
      .json({ error: 'That post has already been used to claim.' })
  }

  // Optional: one bonus per address per cooldown to stop one wallet farming posts.
  const now = Date.now()
  const lastBonus = shares.bonus[address]
  if (lastBonus && now - lastBonus < COOLDOWN_MS) {
    return res.status(429).json({
      error: 'This address already claimed a share bonus.',
      retryAfterMs: COOLDOWN_MS - (now - lastBonus),
    })
  }

  // Verify the post actually mentions @SurProtocol.
  let check
  try {
    check = await postMentionsHandle(postUrl)
  } catch {
    check = { reachable: false, mentions: false }
  }
  if (!check.reachable) {
    return res.status(502).json({
      error:
        'Could not read that post (it may be private/deleted, or X is rate-limiting). Try again shortly.',
    })
  }
  if (!check.mentions) {
    return res
      .status(422)
      .json({ error: `That post doesn't mention ${X_HANDLE}.` })
  }

  // Reserve the post + bonus slot before sending.
  shares.posts[post.id] = address
  shares.bonus[address] = now
  save('shares.json', shares)
  try {
    const txHash = await dispense(address, SHARE_AMOUNT, 'Sur faucet share bonus')
    res.json({ txHash, amount: SHARE_AMOUNT, denom: DISPLAY_DENOM })
  } catch (e) {
    delete shares.posts[post.id]
    delete shares.bonus[address]
    save('shares.json', shares)
    console.error('share-claim failed:', e?.message || e)
    res
      .status(500)
      .json({ error: 'Bonus transfer failed. Try again in a moment.' })
  }
})

// Serve the built frontend in production (npm run build && npm start).
const dist = join(__dirname, '..', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')))
}

await initWallet()
app.listen(PORT, () => {
  console.log(`\n🪙  Sur faucet running on http://localhost:${PORT}`)
  console.log(`    base ${AMOUNT} ${DISPLAY_DENOM} / ${COOLDOWN_MS / 3_600_000}h`)
  console.log(`    share bonus ${SHARE_AMOUNT} ${DISPLAY_DENOM} for posts mentioning ${X_HANDLE}`)
  console.log(`    faucet account: ${faucetAddress}`)
  console.log(`    node RPC: ${RPC}\n`)
})
