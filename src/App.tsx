import { useEffect, useState } from 'react'

interface Info {
  amount: number
  shareAmount: number
  xHandle: string
  denom: string
  faucetAddress: string
  cooldownHours: number
  explorerUrl: string
  prefix: string
}

// Ready-to-post samples — each mentions @SurProtocol. Framed around provenance
// of any content/data (text, images, audio, video, AI/agent output), not just text.
const SAMPLE_POSTS: string[] = [
  "Grabbed free testnet SUR from the @SurProtocol faucet 🪙 A chain that proves the origin of any content — human, AI, or agent. Try it 👉",
  "Who — or what — made this? @SurProtocol attests the origin of content: text, images, audio, video, on-chain. 🔎",
  "Provenance for everything you create. @SurProtocol proves whether data came from a human, an AI, or an agent. ✍️🤖",
  "In a world flooded with AI-generated data, knowing the source is everything. @SurProtocol makes origin verifiable. 💎",
  "@SurProtocol gives every piece of content a verifiable origin — and lets AI agents sign theirs too. The provenance layer for the web. 🌐",
  "Watermarks and detectors fail. @SurProtocol takes a cryptographic path: prove where data actually came from. 🔐",
  "Human-made, AI-made, or copied? @SurProtocol settles it on-chain — privately. 🧩",
  "Tried @SurProtocol's explorer: check whether content is human-made, AI-declared, or from an agent. This should be everywhere. ⚡",
  "Your device can prove a photo is genuine and a message was human-made — @SurProtocol anchors both on-chain. 📸",
  "AI agents are coming, and they'll produce most of our data. @SurProtocol lets them sign it, so origin is never a mystery. 🤝",
  "Content authenticity shouldn't depend on a platform. @SurProtocol makes provenance permissionless and verifiable by anyone. 🕊️",
  "Not 'trust me bro' — 'verify the origin on-chain.' That's @SurProtocol. Claimed some testnet SUR to try it. 🔗",
  "Privacy and provenance usually fight. @SurProtocol gets both: prove where data came from, reveal nothing sensitive. 🤫",
  "Deepfakes, AI slop, scraped data everywhere. @SurProtocol is building cryptographic proof of origin for all of it. 🛡️",
  "gm to everyone building trust into the internet. Shoutout @SurProtocol for proving content origin without surveillance. ☀️",
  "The internet needs an 'origin' layer for data. @SurProtocol is making it real with on-chain attestations. ✅",
  "Free testnet SUR claimed 🪙 Excited for @SurProtocol — provenance for the content layer of the web, human or machine.",
  "Photos, voice notes, documents, AI outputs — @SurProtocol can attest the origin of all of it. Provenance for the AI age. 🌅",
  "Reading about @SurProtocol — a Cosmos chain for content provenance with on-device proofs. Bookmarking this one. 📌",
  "Real human signal gets scarce as AI scales. @SurProtocol makes it provable — and tags AI/agent data honestly too. 📈",
  "If you care about what's real online, watch @SurProtocol. On-chain attestations for the origin of any content. 👀",
  "The @SurProtocol idea is simple but huge: give every piece of data a verifiable origin. Grabbing testnet SUR. 🪙",
  "Quietly bullish on provenance. @SurProtocol is doing it with ZK + a Cosmos chain, across all kinds of content. 🧠",
  "Your keystrokes, your camera, your AI agent — each can prove what it produced via @SurProtocol. Trust, but verify. 🔏",
  "Minted my first origin attestation on @SurProtocol today. A web where you can prove the source of any content. 🌐",
  "AI can generate infinite data. @SurProtocol makes the source of that data checkable by anyone, anytime. 🤖",
  "Stop guessing what's real. @SurProtocol attests content origin — human, AI, agent, or copied — on-chain. 🔍",
  "Provenance isn't just for art. @SurProtocol brings it to all content and data, with privacy built in. 🎨",
  "Testing @SurProtocol: prove a human made something, or that an AI/agent did — your choice, on-chain. ⚖️",
]

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; txHash: string }
  | { kind: 'cooldown'; retryAfterMs: number }
  | { kind: 'error'; message: string }

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${total}s`
}

function shorten(s: string): string {
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s
}

type Theme = 'dark' | 'light'

export default function App() {
  const [info, setInfo] = useState<Info | null>(null)
  const [address, setAddress] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const [postUrl, setPostUrl] = useState('')
  const [sample, setSample] = useState(() =>
    Math.floor(Math.random() * SAMPLE_POSTS.length)
  )
  const [share, setShare] = useState<Status>({ kind: 'idle' })
  const [bonusOpen, setBonusOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('sur-faucet-theme') as Theme) || 'dark'
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('sur-faucet-theme', theme)
  }, [theme])

  useEffect(() => {
    fetch('/api/info')
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => {})
  }, [])

  const prefix = info?.prefix ?? 'sur'
  const valid = new RegExp(`^${prefix}1[0-9a-z]{20,}$`).test(address.trim())

  const claim = async () => {
    if (!valid) return
    setStatus({ kind: 'loading' })
    try {
      const res = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.trim() }),
      })
      const data = await res.json()
      if (res.ok) {
        setStatus({ kind: 'success', txHash: data.txHash })
      } else if (res.status === 429) {
        setStatus({ kind: 'cooldown', retryAfterMs: data.retryAfterMs ?? 0 })
      } else {
        setStatus({ kind: 'error', message: data.error ?? 'Request failed.' })
      }
    } catch {
      setStatus({
        kind: 'error',
        message: 'Could not reach the faucet. Is it running?',
      })
    }
  }

  const copyFaucet = () => {
    if (!info) return
    navigator.clipboard.writeText(info.faucetAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const postOnX = () => {
    const text = SAMPLE_POSTS[sample]
    window.open(
      `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`,
      '_blank',
      'noopener,noreferrer'
    )
  }

  const nextSample = () =>
    setSample((s) => (s + 1) % SAMPLE_POSTS.length)

  const claimShare = async () => {
    if (!valid || !postUrl.trim()) return
    setShare({ kind: 'loading' })
    try {
      const res = await fetch('/api/share-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.trim(), postUrl: postUrl.trim() }),
      })
      const data = await res.json()
      if (res.ok) {
        setShare({ kind: 'success', txHash: data.txHash })
      } else if (res.status === 429) {
        setShare({ kind: 'cooldown', retryAfterMs: data.retryAfterMs ?? 0 })
      } else {
        setShare({ kind: 'error', message: data.error ?? 'Could not verify the post.' })
      }
    } catch {
      setShare({ kind: 'error', message: 'Could not reach the faucet.' })
    }
  }

  return (
    <div className="shell">
      <div className="card">
        <button
          className="theme-toggle"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? (
            // sun
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          ) : (
            // moon
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

        <div className="brand">
          <img src="/sur-logo.png" alt="Sur" />
          <div>
            <div className="title">Sur Faucet</div>
            <div className="sub">Testnet tokens for the Sur Chain</div>
          </div>
        </div>

        <h1 className="headline">Get free testnet SUR</h1>
        <p className="lede">
          Receive{' '}
          <span className="amount">
            {info ? `${info.amount} ${info.denom}` : '…'}
          </span>{' '}
          once every {info ? Math.round(info.cooldownHours) : 24}h. Paste your
          address and claim — no sign-in.
        </p>

        <label htmlFor="addr">Your Sur address</label>
        <input
          id="addr"
          className="input"
          placeholder={`${prefix}1…`}
          value={address}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => {
            setAddress(e.target.value)
            if (status.kind !== 'idle' && status.kind !== 'loading')
              setStatus({ kind: 'idle' })
          }}
          onKeyDown={(e) => e.key === 'Enter' && claim()}
        />

        <button
          className="btn"
          onClick={claim}
          disabled={!valid || status.kind === 'loading'}
        >
          {status.kind === 'loading' ? (
            <>
              <span className="spinner" />
              Sending…
            </>
          ) : (
            `Request ${info ? `${info.amount} ${info.denom}` : 'SUR'}`
          )}
        </button>

        {status.kind === 'success' && (
          <div className="banner success">
            <div className="row">
              ✅&nbsp;Sent! {info?.amount} {info?.denom} are on the way.
            </div>
            {info?.explorerUrl && (
              <div style={{ marginTop: 6 }}>
                <a
                  href={`${info.explorerUrl}/txs/${status.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction ↗
                </a>
              </div>
            )}
          </div>
        )}

        {status.kind === 'cooldown' && (
          <div className="banner warn">
            ⏳&nbsp;Already claimed for this address. Try again in{' '}
            <strong>{fmtDuration(status.retryAfterMs)}</strong>.
          </div>
        )}

        {status.kind === 'error' && (
          <div className="banner error">⚠️&nbsp;{status.message}</div>
        )}

        {/* Share to earn more */}
        <div className="divider" />
        <div className="bonus">
          <button
            className="bonus-toggle"
            onClick={() => setBonusOpen((o) => !o)}
            aria-expanded={bonusOpen}
          >
            <span className="mini-label">
              Earn {info ? `${info.shareAmount} ${info.denom}` : '20 SUR'} more
            </span>
            <svg
              className={`chev ${bonusOpen ? 'open' : ''}`}
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {bonusOpen && (
            <div className="bonus-body">
              <p className="lede small">
            Post about Sur mentioning{' '}
            <span className="amount">{info?.xHandle ?? '@SurProtocol'}</span>,
            then paste your post link to claim. Each post works once.
          </p>

          <div className="sample">{SAMPLE_POSTS[sample]}</div>
          <div className="sample-actions">
            <button className="btn-ghost" onClick={nextSample} type="button">
              ↻ Another
            </button>
            <button className="btn-x" onClick={postOnX} type="button">
              Post on 𝕏
            </button>
          </div>

          <input
            className="input"
            placeholder="https://x.com/you/status/…"
            value={postUrl}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setPostUrl(e.target.value)
              if (share.kind !== 'idle' && share.kind !== 'loading')
                setShare({ kind: 'idle' })
            }}
            onKeyDown={(e) => e.key === 'Enter' && claimShare()}
          />
          <button
            className="btn"
            onClick={claimShare}
            disabled={!valid || !postUrl.trim() || share.kind === 'loading'}
          >
            {share.kind === 'loading' ? (
              <>
                <span className="spinner" />
                Verifying post…
              </>
            ) : (
              `Claim ${info ? `${info.shareAmount} ${info.denom}` : '20 SUR'}`
            )}
          </button>

          {share.kind === 'success' && (
            <div className="banner success">
              <div className="row">
                ✅&nbsp;Bonus sent! {info?.shareAmount} {info?.denom} on the way.
              </div>
              {info?.explorerUrl && (
                <div style={{ marginTop: 6 }}>
                  <a
                    href={`${info.explorerUrl}/txs/${share.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction ↗
                  </a>
                </div>
              )}
            </div>
          )}
          {share.kind === 'cooldown' && (
            <div className="banner warn">
              ⏳&nbsp;This address already claimed a bonus. Try again in{' '}
              <strong>{fmtDuration(share.retryAfterMs)}</strong>.
            </div>
          )}
          {share.kind === 'error' && (
            <div className="banner error">⚠️&nbsp;{share.message}</div>
          )}
            </div>
          )}
        </div>

        <div className="foot">
          <span className="pill">
            <span className="dot" />
            {info ? 'Faucet online' : 'Connecting…'}
          </span>
          {info && (
            <button className="copy" onClick={copyFaucet} title={info.faucetAddress}>
              {copied ? 'Copied!' : `from ${shorten(info.faucetAddress)}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
