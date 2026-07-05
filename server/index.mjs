import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import { SigningStargateClient, GasPrice, calculateFee } from '@cosmjs/stargate'
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
const SHARE_VIDEO_AMOUNT = Number(process.env.SHARE_VIDEO_AMOUNT || 100) // SUR when the post includes a video
// 0 disables the freshness check. Only enforced when the post's real creation
// time is known (authenticated API or the syndication fallback) — the oEmbed
// fallback has no timestamp precision, so age is left unchecked there.
const SHARE_MAX_AGE_MINUTES = Number(process.env.SHARE_MAX_AGE_MINUTES || 60)
const X_HANDLE = process.env.X_HANDLE || '@SurProtocol'
const PREFIX = process.env.ADDRESS_PREFIX || 'sur'
const COOLDOWN_MS = Number(process.env.COOLDOWN_HOURS || 24) * 3600 * 1000
const GAS_PRICE = process.env.GAS_PRICE || `0.025${DENOM}`
// Fixed gas limit for a single MsgSend. cosmjs 'auto' simulates with an empty
// signature and under-counts store writes on this chain (a bank send actually
// uses ~92k), so txs sent with the simulated limit fail with "out of gas". Use a
// comfortable explicit limit instead — deterministic and safely above real cost.
const GAS_LIMIT = Number(process.env.GAS_LIMIT || 200000)
const EXPLORER_URL = process.env.EXPLORER_URL || 'http://localhost:5173'
const MNEMONIC = process.env.FAUCET_MNEMONIC
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN

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

// All sends share ONE faucet account, so they must be serialized — otherwise
// concurrent claims grab the same account sequence and all but one fail with a
// sequence mismatch. This promise-chain mutex runs sends strictly one at a time.
let sendQueue = Promise.resolve()
function dispense(address, sur, memo) {
  const task = sendQueue.then(() => sendOnce(address, sur, memo))
  // Keep the chain alive even if this send rejects.
  sendQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

// Sign + broadcast a single transfer of `sur` SUR to `address`.
async function sendOnce(address, sur, memo) {
  const client = await SigningStargateClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE),
  })
  try {
    const fee = calculateFee(GAS_LIMIT, GasPrice.fromString(GAS_PRICE))
    const result = await client.sendTokens(
      faucetAddress,
      address,
      [{ denom: DENOM, amount: toMicro(sur) }],
      fee,
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

const mentionsNeedle = () => `@${X_HANDLE.replace(/^@/, '').toLowerCase()}`

// Three ways to read a post, tried in order of quality. Each either returns
// a definitive { reachable, mentions, createdAt, hasVideo } result, or `null`
// to mean "inconclusive, try the next one" (access tier issue, transient
// error, etc — not proof the post doesn't exist).

// Best: the official API, gives exact text + timestamp + media. Needs
// X_BEARER_TOKEN with read access (a paid tier at the time of writing).
async function postMentionsHandleViaApi(id) {
  const endpoint = `https://api.twitter.com/2/tweets/${id}?tweet.fields=text,created_at,attachments&expansions=attachments.media_keys&media.fields=type`
  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
  })
  if (res.status === 429) return { reachable: false, mentions: false, createdAt: null, hasVideo: false }
  if (!res.ok) return null // access issue — let caller try the next method
  const data = await res.json()
  if (!data?.data?.text) return { reachable: false, mentions: false, createdAt: null, hasVideo: false }
  const mentions = data.data.text.toLowerCase().includes(mentionsNeedle())
  const createdAt = data.data.created_at ? new Date(data.data.created_at) : null
  const media = data.includes?.media || []
  const hasVideo = media.some((m) => m.type === 'video' || m.type === 'animated_gif')
  return { reachable: true, mentions, createdAt, hasVideo }
}

// Good: X's undocumented syndication endpoint (what widgets.js and tools like
// react-tweet use under the hood). No auth, but unofficial — could change or
// get rate-limited without notice, hence the oEmbed fallback below it.
async function postMentionsHandleViaSyndication(id) {
  const endpoint = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=1`
  const res = await fetch(endpoint, { headers: { 'User-Agent': 'SurFaucet/1.0' } })
  if (!res.ok) return null // let caller try oEmbed
  const data = await res.json()
  if (!data?.text) return null
  const mentions = data.text.toLowerCase().includes(mentionsNeedle())
  const createdAt = data.created_at ? new Date(data.created_at) : null
  const media = Array.isArray(data.mediaDetails) ? data.mediaDetails : []
  const hasVideo = media.some((m) => m.type === 'video' || m.type === 'animated_gif')
  return { reachable: true, mentions, createdAt, hasVideo }
}

// Last resort: public oEmbed. Only sees rendered HTML, so no reliable
// timestamp or media type — createdAt/hasVideo are always unknown here.
async function postMentionsHandleViaOembed(url) {
  const normalized = url.replace('://x.com', '://twitter.com')
  const endpoint = `https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(
    normalized
  )}`
  const res = await fetch(endpoint, {
    headers: { 'User-Agent': 'SurFaucet/1.0' },
  })
  if (!res.ok) return { reachable: false, mentions: false, createdAt: null, hasVideo: false }
  const data = await res.json()
  const haystack = `${data.html || ''} ${data.author_name || ''} ${
    data.author_url || ''
  }`.toLowerCase()
  return {
    reachable: true,
    mentions: haystack.includes(mentionsNeedle()),
    createdAt: null,
    hasVideo: false,
  }
}

async function postMentionsHandle(url, id) {
  if (X_BEARER_TOKEN) {
    const viaApi = await postMentionsHandleViaApi(id)
    if (viaApi) return viaApi
  }
  const viaSyndication = await postMentionsHandleViaSyndication(id)
  if (viaSyndication) return viaSyndication
  return postMentionsHandleViaOembed(url)
}

const app = express()
app.use(cors())
app.use(express.json())

app.get('/api/info', (_req, res) => {
  res.json({
    amount: AMOUNT,
    shareAmount: SHARE_AMOUNT,
    videoShareAmount: SHARE_VIDEO_AMOUNT,
    maxPostAgeMinutes: SHARE_MAX_AGE_MINUTES,
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

  // Reserve the post + bonus slot NOW, synchronously, before the network
  // round-trip below. Verification is an `await`, which yields the event
  // loop — reserving only after it returned would let two concurrent
  // requests for the same tweet both pass the checks above and both get
  // paid. Roll the reservation back if verification or the send fails.
  shares.posts[post.id] = address
  shares.bonus[address] = now
  save('shares.json', shares)

  const rollback = () => {
    delete shares.posts[post.id]
    delete shares.bonus[address]
    save('shares.json', shares)
  }

  // Verify the post actually mentions @SurProtocol.
  let check
  try {
    check = await postMentionsHandle(postUrl, post.id)
  } catch {
    check = { reachable: false, mentions: false, createdAt: null, hasVideo: false }
  }
  if (!check.reachable) {
    rollback()
    return res.status(502).json({
      error:
        'Could not read that post (it may be private/deleted, or X is rate-limiting). Try again shortly.',
    })
  }
  if (!check.mentions) {
    rollback()
    return res
      .status(422)
      .json({ error: `That post doesn't mention ${X_HANDLE}.` })
  }

  // Only enforced when we actually know when the post was made — the oEmbed
  // fallback can't tell, so an unknown age is allowed through rather than
  // silently blocking every share once that fallback is in use.
  if (SHARE_MAX_AGE_MINUTES > 0 && check.createdAt) {
    const ageMinutes = (now - check.createdAt.getTime()) / 60_000
    if (ageMinutes > SHARE_MAX_AGE_MINUTES) {
      rollback()
      return res.status(422).json({
        error: `That post is more than ${SHARE_MAX_AGE_MINUTES} minutes old. Share a fresh one to claim.`,
      })
    }
  }

  const amount = check.hasVideo ? SHARE_VIDEO_AMOUNT : SHARE_AMOUNT
  try {
    const txHash = await dispense(
      address,
      amount,
      check.hasVideo ? 'Sur faucet share bonus (video)' : 'Sur faucet share bonus'
    )
    res.json({ txHash, amount, denom: DISPLAY_DENOM, video: check.hasVideo })
  } catch (e) {
    rollback()
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
  console.log(`    share bonus ${SHARE_AMOUNT} ${DISPLAY_DENOM} (${SHARE_VIDEO_AMOUNT} with video) for posts mentioning ${X_HANDLE}`)
  if (SHARE_MAX_AGE_MINUTES > 0) {
    console.log(`    posts must be <${SHARE_MAX_AGE_MINUTES}m old (when age is knowable)`)
  }
  console.log(`    faucet account: ${faucetAddress}`)
  console.log(`    node RPC: ${RPC}\n`)
})
