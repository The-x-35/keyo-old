// Keyo server: the keyboard's brain. Suggests actions, buys through Bitrefill, swaps
// through NEAR Intents and sends shielded ZEC from the server wallet.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as br from './bitrefill.mjs';
import * as mcp from './mcp.mjs';
import * as swap from './swap.mjs';
import * as zec from './zec.mjs';
import { suggest, zcashUri } from './intent.mjs';
import * as store from './store.mjs';

// Tiny .env loader so the server runs with plain `node`.
const envFile = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT || 8787);
const CAP_PER_PURCHASE = Number(process.env.CAP_PER_PURCHASE_INR || 500);
const CAP_PER_DAY = Number(process.env.CAP_PER_DAY_INR || 1000);

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const maskPhone = (p) => (p ? p.replace(/^(\+\d{2})(\d{2})\d+(\d{3})$/, '$1 $2•••••$3') : p);

async function priceInr(pkg) {
  return pkg.inr;
}

const OPERATOR_PRODUCTS = { jio: 'reliance-jio-india-bundles', airtel: 'airtel-india', vi: 'vodafone-india', bsnl: 'bsnl-india' };

// Resolves a top-up, gift or eSIM chip to a Bitrefill product and package.
async function resolve(chip) {
  if (chip.kind === 'topup') {
    if (!chip.phone) throw new Error(`No phone number saved for ${chip.name}. Add it in the Keyo app.`);
    let productId = null;
    try {
      const info = await br.checkPhone(chip.phone);
      const ops = info.operators || [];
      const want = (chip.operator || '').toLowerCase();
      const op = ops.find((o) => `${o.id} ${o.name}`.toLowerCase().includes(want)) || ops[0];
      productId = op?.id;
    } catch {}
    if (!productId) productId = OPERATOR_PRODUCTS[(chip.operator || 'jio').toLowerCase()];
    if (!productId) productId = (await br.findProduct(`${chip.operator} india`, { type: 'phone_number' })).id;
    const product = await br.product(productId);
    return { product, pkg: br.pickPackage(product, chip.amount), phone_number: chip.phone };
  }
  if (chip.kind === 'gift') {
    const found = await br.findProduct(chip.brand);
    const product = await br.product(found.id);
    return { product, pkg: br.pickPackage(product, chip.amount) };
  }
  if (chip.kind === 'esim') {
    const product = await br.esimFor(chip.country);
    // Cheapest bundle; prices are in USD.
    const k = [...(product.packages || [])].sort((a, b) => a.amount - b.amount)[0];
    if (!k) throw new Error(`No eSIM bundles for ${chip.country}`);
    const inr = Math.round(Number(k.amount) * (await swap.usdToInr()));
    return { product, pkg: { value: k.value, inr, plan: k.value, esim: true } };
  }
  throw new Error(`Not a Bitrefill action: ${chip.kind}`);
}

function resultText(chip, product, order) {
  const name = product.name || cap(chip.brand || chip.operator);
  if (chip.kind === 'topup') {
    const plan = chip.plan ? ` (${chip.plan})` : '';
    return `✅ Recharged ${maskPhone(chip.phone)} with ${product.base_name || name} ₹${chip.inr ?? chip.amount}${plan}. It should land in a minute.`;
  }
  const r = order?.redemption_info || {};
  if (chip.kind === 'esim') {
    const lines = [`📶 ${product.base_name || name} · ${chip.plan}`];
    // Apple's one-tap install link opens the eSIM setup straight from the chat.
    if (r.barcode_value) lines.push(`Install: https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=${encodeURIComponent(r.barcode_value)}`);
    else if (r.instructions) lines.push(r.instructions);
    return lines.join('\n');
  }
  const lines = [`🎁 ₹${chip.inr ?? chip.amount} ${product.base_name || name} gift card for you${chip.occasion ? ` (${chip.occasion})` : ''}!`];
  if (r.code) lines.push(`Code: ${r.code}`);
  if (r.pin) lines.push(`${r.code ? 'PIN' : 'Card'}: ${r.pin}`);
  if (r.other) lines.push(r.other);
  if (r.link) lines.push(`Redeem: ${r.link}`);
  if (!r.code && !r.pin && !r.link && r.instructions) lines.push(r.instructions.replace(/\\n/g, "\n"));
  return lines.join('\n');
}

async function bitrefill(chip, { approved = false, sandbox = false } = {}) {
  if (!sandbox && chip.demo) throw new Error(`${cap(chip.name)} is a demo contact. Use Sandbox, or a real contact`);
  const { product, pkg, phone_number } = await resolve(chip);
  const inr = await priceInr(pkg);
  chip = { ...chip, inr, plan: pkg.plan };
  const spent = store.spentToday();
  if (!approved && (inr > CAP_PER_PURCHASE || spent + inr > CAP_PER_DAY)) {
    const id = `apr_${Date.now().toString(36)}`;
    store.addApproval(id, { chip, inr, product: product.name, sandbox });
    return {
      status: 'needs_approval',
      approval_id: id,
      open: `keyo://approve?id=${id}`,
      message: `₹${inr} is over your limit (₹${CAP_PER_PURCHASE} a purchase, ₹${CAP_PER_DAY - spent} left today). Approve it in Keyo.`,
    };
  }
  if (sandbox || process.env.DRY_RUN === '1') {
    // Same product, price and wording as a real purchase; nothing is paid.
    const invoice_id = `sandbox-${Date.now().toString(36)}`;
    const fake = () => Math.random().toString(36).slice(2, 6).toUpperCase();
    const redemption = chip.kind === 'esim'
      ? { barcode_value: `LPA:1$sandbox.keyo$${fake()}${fake()}` }
      : { code: `TEST-${fake()}-${fake()}`, pin: String(Math.floor(100000 + Math.random() * 900000)) };
    store.record({ type: 'bitrefill', ok: true, sandbox: true, kind: chip.kind, product: product.name, inr, invoice_id, to: chip.name });
    return { status: 'done', sandbox: true, invoice_id, text: resultText(chip, product, { redemption_info: redemption }) };
  }
  // Someone else with an email on file gets the card straight from Bitrefill.
  const gift = chip.kind === 'gift' && chip.email && chip.name && chip.name.toLowerCase() !== 'me'
    ? { recipient_name: cap(chip.name), recipient_email: chip.email, sender_name: process.env.SENDER_NAME || 'A friend', message: chip.occasion ? `Happy ${chip.occasion}!` : 'For you' }
    : null;
  const inv = await mcp.buy({ product_id: product.id, package_value: pkg.value, refill_input: phone_number, gift });
  const done = await mcp.waitDelivered(inv.invoice_id);
  const entry = store.record({
    type: 'bitrefill',
    ok: done.delivered,
    kind: chip.kind,
    product: product.name,
    inr,
    usd: done.price,
    invoice_id: inv.invoice_id,
    to: chip.name,
  });
  if (!done.delivered) {
    return { status: 'pending', invoice_id: inv.invoice_id, message: `Paid. ${product.base_name || product.name} is on its way` };
  }
  const text = gift
    ? `🎁 Sent you a ₹${inr} ${product.base_name || product.name} gift card. Check your email ${chip.email.replace(/^(.).*(@.*)$/, '$1•••$2')}!`
    : resultText(chip, product, { redemption_info: done.redemption });
  return { status: 'done', invoice_id: inv.invoice_id, activity_id: entry.id, text };
}

async function act(chip, mode = 'zodl', sandbox = false) {
  switch (chip.kind) {
    case 'topup':
    case 'gift':
    case 'esim':
      return bitrefill(chip, { sandbox });

    case 'zec_send': {
      if (!chip.address) throw new Error(`No Zcash address saved for ${chip.name || 'that contact'}.`);
      const memo = chip.memo || 'Sent with Keyo';
      if (sandbox) {
        const txid = [...Array(64)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
        store.record({ type: 'zec', ok: true, sandbox: true, kind: 'send', amount: chip.amount, to: chip.name, txid });
        return { status: 'done', sandbox: true, txid, text: `🛡️ Sent you ${chip.amount} ZEC, shielded.` };
      }
      if (mode === 'server') {
        const tx = await zec.send(chip.address, chip.amount, memo);
        store.record({ type: 'zec', ok: true, kind: 'send', amount: chip.amount, to: chip.name, txid: tx.txid });
        return { status: 'done', txid: tx.txid, text: `🛡️ Sent you ${chip.amount} ZEC, shielded.` };
      }
      return { status: 'open', open: zcashUri(chip.address, chip.amount, memo), message: `Confirm ${chip.amount} ZEC in Zodl` };
    }

    case 'price': {
      const usd = (await swap.prices()).ZEC;
      const rate = await swap.usdToInr();
      const inrPerZec = usd * rate;
      const fmt = (n, d = 0) => n.toLocaleString('en-IN', { maximumFractionDigits: d });
      if (chip.unit === 'INR') {
        return { status: 'done', text: `₹${fmt(chip.amount)} = ${(chip.amount / inrPerZec).toFixed(5)} ZEC` };
      }
      return { status: 'done', text: `${chip.amount} ZEC = ₹${fmt(chip.amount * inrPerZec)} ($${fmt(chip.amount * usd, 2)})` };
    }

    case 'answer':
      return { status: 'done', text: await answer(chip.question) };

    case 'zec_request': {
      if (chip.inr && !chip.amount) {
        const inrPerZec = (await swap.prices()).ZEC * (await swap.usdToInr());
        chip = { ...chip, amount: Number((chip.inr / inrPerZec).toFixed(5)) };
      }
      const mine = process.env.USER_ZEC_ADDRESS || (await zec.address().catch(() => ({}))).unified;
      if (!mine) throw new Error('No Zcash address to receive on');
      const uri = zcashUri(mine, chip.amount, chip.memo || 'Keyo request');
      const why = chip.split ? `Your share of ₹${chip.split.total} is ₹${chip.inr}. ` : '';
      return { status: 'done', text: `${why}Pay me ${chip.amount} ZEC (shielded): ${uri}` };
    }

    case 'swap': {
      const q = await swap.quote({ from: chip.from, to: chip.to, amount: chip.amount, dry: sandbox });
      if (sandbox) {
        store.record({ type: 'swap', ok: true, sandbox: true, from: q.from, to: q.to, amountIn: q.amountIn, amountOut: q.amountOut });
        return { status: 'done', sandbox: true, quote: q, text: `🔁 Swapped ${q.amountIn} ${q.from} → ${q.amountOut} ${q.to} through NEAR Intents.` };
      }
      store.record({ type: 'swap', ok: true, from: q.from, to: q.to, amountIn: q.amountIn, amountOut: q.amountOut, deposit: q.depositAddress });
      if (q.from === 'ZEC') {
        if (mode === 'server') {
          const tx = await zec.send(q.depositAddress, chip.amount, null);
          return { status: 'done', quote: q, txid: tx.txid, message: `Swapping ${q.amountIn} ZEC → ${q.amountOut} ${q.to}` };
        }
        return { status: 'open', quote: q, open: zcashUri(q.depositAddress, q.amountIn), message: `${q.amountIn} ZEC → ${q.amountOut} ${q.to}. Confirm in Zodl` };
      }
      return { status: 'quote', quote: q, message: `Send ${q.amountIn} ${q.from} to ${q.depositAddress} to get ${q.amountOut} ${q.to}` };
    }
  }
  throw new Error(`Unknown action ${chip.kind}`);
}

// Instant answers for questions typed in the chat.
async function answer(question) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Answers need GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `Reply with only the answer, one or two short sentences the user can send as a chat message. No preamble, no follow-up remarks.\n\n${question}` }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 120 },
    }),
  });
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
  if (!text) throw new Error('No answer right now');
  return text;
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const routes = {
  'GET /health': async () => ({ ok: true }),
  'POST /suggest': async (b) => ({ chips: await suggest(String(b.text || '')) }),
  'POST /act': async (b) => act(b.chip, b.mode, !!b.sandbox),
  'GET /approval': async (_, q) => store.approval(q.get('id')) || { status: 'missing' },
  'POST /approve': async (b) => {
    const a = store.approval(b.id);
    if (!a || a.status !== 'waiting') throw new Error('Nothing to approve');
    if (!b.approve) {
      store.settleApproval(b.id, 'declined');
      return { status: 'declined' };
    }
    store.settleApproval(b.id, 'approved');
    const out = await bitrefill(a.chip, { approved: true, sandbox: !!a.sandbox });
    store.settleApproval(b.id, out.status === 'done' ? 'done' : 'approved');
    store.approval(b.id).result = out;
    return out;
  },
  'GET /activity': async () => ({ activity: store.activity(), spentToday: store.spentToday(), caps: { perPurchase: CAP_PER_PURCHASE, perDay: CAP_PER_DAY } }),
  'GET /contacts': async () => ({ contacts: store.contacts() }),
  'POST /contacts': async (b) => {
    store.setContacts(b.contacts || []);
    return { ok: true };
  },
  'GET /balance': async () => {
    const out = {};
    try {
      const b = await mcp.balances();
      out.bitrefill = { balance: b.USD ?? 0, currency: 'USD', all: b };
    } catch (e) {
      out.bitrefillError = e.message;
    }
    const [main, test] = await Promise.allSettled([zec.balance('main'), zec.balance('test')]);
    if (main.status === 'fulfilled') out.zec = main.value;
    else out.zecError = main.reason.message;
    if (test.status === 'fulfilled') out.zecTest = test.value;
    return out;
  },
  'GET /swap/status': async (_, q) => swap.status(q.get('deposit')),
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const handler = routes[`${req.method} ${url.pathname}`];
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (!handler) return send(res, 404, { error: 'not found' });
    const token = process.env.KEYO_TOKEN;
    if (token && url.pathname !== '/health' && req.headers['x-keyo-token'] !== token) return send(res, 401, { error: 'bad token' });
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const t0 = Date.now();
      const out = await handler(body, url.searchParams);
      console.log(req.method, url.pathname, `${Date.now() - t0}ms`, body.chip?.kind || '');
      send(res, 200, out);
    } catch (e) {
      console.error(req.method, url.pathname, e.message);
      send(res, 400, { error: e.message });
    }
  })
  .listen(PORT, () => console.log(`Keyo server on :${PORT}`));
