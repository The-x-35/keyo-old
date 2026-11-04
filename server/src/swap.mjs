// Swaps into and out of ZEC through NEAR Intents 1Click (mainnet).
const BASE = 'https://1click.chaindefuser.com/v0';

const ASSETS = {
  ZEC: { id: 'nep141:zec.omft.near', decimals: 8, chain: 'zec' },
  USDC: { id: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', decimals: 6, chain: 'sol' },
  SOL: { id: 'nep141:sol.omft.near', decimals: 9, chain: 'sol' },
  ETH: { id: 'nep141:eth.omft.near', decimals: 18, chain: 'eth' },
};

function auth() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.ONECLICK_JWT) h.Authorization = `Bearer ${process.env.ONECLICK_JWT}`;
  return h;
}

let priceCache = { at: 0, map: {} };
export async function prices() {
  if (Date.now() - priceCache.at < 60_000) return priceCache.map;
  const tokens = await fetch(`${BASE}/tokens`).then((r) => r.json());
  const map = {};
  for (const sym of Object.keys(ASSETS)) {
    const t = tokens.find((x) => x.assetId === ASSETS[sym].id);
    if (t) map[sym] = Number(t.price);
  }
  priceCache = { at: Date.now(), map };
  return map;
}

let inr = { at: 0, rate: 0 };
export async function usdToInr() {
  if (Date.now() - inr.at < 3600_000 && inr.rate) return inr.rate;
  const r = await fetch('https://open.er-api.com/v6/latest/USD').then((x) => x.json()).catch(() => null);
  inr = { at: Date.now(), rate: r?.rates?.INR || 88 };
  return inr.rate;
}

// Where swapped funds go and where refunds return, per chain. Set in server/.env.
// Dry quotes move nothing, so any valid address works as a stand-in there.
const STAND_IN = { sol: 'So11111111111111111111111111111111111111112', eth: '0x000000000000000000000000000000000000dEaD' };
let dryRun = false;
function addressFor(chain) {
  const env = { zec: 'USER_ZEC_ADDRESS', sol: 'USER_SOL_ADDRESS', eth: 'USER_ETH_ADDRESS' }[chain];
  const v = process.env[env] || (chain === 'zec' ? process.env.AEGIS_UA : null) || (dryRun ? STAND_IN[chain] : null);
  if (!v) throw new Error(`${env} is not set in server/.env`);
  return v;
}
// 1Click refunds ZEC to a transparent address only.
function refundFor(chain) {
  return chain === 'zec' ? process.env.USER_ZEC_REFUND_ADDRESS || process.env.AEGIS_TADDR || addressFor('zec') : addressFor(chain);
}

export async function quote({ from, to, amount, dry = false }) {
  dryRun = dry;
  const a = ASSETS[from.toUpperCase()];
  const b = ASSETS[to.toUpperCase()];
  if (!a || !b) throw new Error(`Can't swap ${from} to ${to}`);
  const base = BigInt(Math.round(Number(amount) * 10 ** Math.min(a.decimals, 12))) * 10n ** BigInt(Math.max(a.decimals - 12, 0));
  const body = {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: a.id,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: b.id,
    amount: base.toString(),
    refundTo: refundFor(a.chain),
    refundType: 'ORIGIN_CHAIN',
    recipient: addressFor(b.chain),
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
    quoteWaitingTimeMs: 3000,
  };
  const res = await fetch(`${BASE}/quote`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`1Click ${res.status}: ${j.message || JSON.stringify(j).slice(0, 160)}`);
  const q = j.quote || {};
  return {
    from: from.toUpperCase(),
    to: to.toUpperCase(),
    amountIn: q.amountInFormatted,
    amountOut: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    depositAddress: q.depositAddress,
    deadline: q.deadline,
    timeEstimate: q.timeEstimate,
  };
}

export async function status(depositAddress) {
  const r = await fetch(`${BASE}/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: auth() });
  return r.json();
}
