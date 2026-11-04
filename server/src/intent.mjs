// Turns what the user is typing into action chips for the keyboard strip.
// Fast regex rules first; Gemini only for free-form text the rules miss.
import { contacts } from './store.mjs';

const OPERATORS = ['jio', 'airtel', 'vi', 'bsnl'];
const BRANDS = ['swiggy', 'zomato', 'amazon', 'flipkart', 'blinkit', 'bigbasket', 'myntra', 'uber', 'bookmyshow', 'hotstar', 'makemytrip', 'apollo', 'phonepe', 'jiomart'];
const OCCASIONS = [
  [/\b(happy\s*b(irth)?day|hbd|bday)\b/i, 'birthday', ['flipkart', 'zomato']],
  [/\bcongrat(s|ulations)?\b/i, 'congrats', ['flipkart', 'zomato']],
  [/\b(anniversary)\b/i, 'anniversary', ['bookmyshow', 'flipkart']],
  [/\b(get well|feel better)\b/i, 'get well', ['apollo', 'zomato']],
  [/\b(thank(s| you) so much|owe you one)\b/i, 'thanks', ['zomato', 'flipkart']],
  [/\b(hungry|starving|no food|order (some )?food)\b/i, 'food', ['zomato', 'swiggy']],
];
const TRIPS = /\b(?:going to|flying to|landing in|trip to|travell?ing to|landed in|reach(?:ing)?)\s+([a-z]+(?:\s[a-z]+)?)/i;

const num = (s) => Number(String(s).replace(/[,₹]/g, ''));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function zcashUri(address, amount, memo) {
  const q = [];
  if (amount) q.push(`amount=${Number(amount)}`);
  // ZIP 321 memos are base64url without padding, shielded recipients only.
  if (memo) q.push(`memo=${Buffer.from(memo).toString('base64url')}`);
  return `zcash:${address}${q.length ? '?' + q.join('&') : ''}`;
}

function findContact(name) {
  if (!name) return null;
  const n = name.toLowerCase().replace(/'s$/, '');
  return contacts().find((c) => c.name.toLowerCase() === n || (c.aliases || []).includes(n)) || null;
}

function rules(text) {
  const t = text.toLowerCase();
  const chips = [];

  // "send 0.1 zec to rahul", "pay rahul 0.1 zec"
  let m = t.match(/\b(?:send|pay|transfer)\s+(?:(\w+)\s+)?([\d.]+)\s*zec(?:\s+to\s+(\w+))?/);
  if (m) {
    const who = findContact(m[3] || m[1]);
    chips.push({ kind: 'zec_send', amount: num(m[2]), name: who?.name || m[3] || m[1] || null, address: who?.zec || null });
  }

  // "request 0.5 zec", "you owe me 0.2 zec"
  m = t.match(/\b(?:request|owe me|send me|ask(?:ing)? for)\s+([\d.]+)\s*zec/);
  if (m) chips.push({ kind: 'zec_request', amount: num(m[1]) });

  // "swap 20 usdc to zec"
  m = t.match(/\b(?:swap|convert|change)\s+([\d.]+)\s*(zec|usdc|sol|eth)\s+(?:to|for|into)\s+(zec|usdc|sol|eth)\b/);
  if (m) chips.push({ kind: 'swap', amount: num(m[1]), from: m[2].toUpperCase(), to: m[3].toUpperCase() });

  // "recharge mom's jio for 199", "top up my airtel 10"
  m = t.match(/\b(?:recharge|top\s?up|topup)\s+(?:my\s+)?(?:(\w+?)(?:'s)?\s+)?(?:(jio|airtel|vi|bsnl)\s+)?(?:phone\s+|number\s+)?(?:for\s+|with\s+|of\s+)?(?:₹|rs\.?\s?|inr\s?)?(\d[\d,]*)/);
  if (m) {
    let who = OPERATORS.includes(m[1]) ? null : findContact(m[1]);
    if (!who && (m[1] === undefined || m[1] === 'my' || OPERATORS.includes(m[1]))) who = findContact('me');
    const operator = m[2] || (OPERATORS.includes(m[1]) ? m[1] : null) || who?.operator || null;
    chips.push({ kind: 'topup', amount: num(m[3]), name: who?.name || m[1] || 'me', phone: who?.phone || null, operator, demo: !!who?.demo });
  }

  // "send mom a ₹500 swiggy gift card", "gift rahul 200 amazon"
  m = t.match(/\b(?:send|gift|buy)\s+(?:(\w+)\s+)?(?:an?\s+)?(?:₹|rs\.?\s?)?(\d[\d,]*)?\s*(?:rs\.?\s*|rupees?\s*)?(swiggy|zomato|amazon|flipkart|blinkit|bigbasket|myntra|uber|bookmyshow|hotstar|makemytrip|apollo|phonepe|jiomart)(?:\s+(?:gift\s*card|voucher|card))?(?:\s+(?:of|for|worth)\s+(?:₹|rs\.?\s?)?(\d[\d,]*))?(?:\s+(?:to|for)\s+(\w+))?/);
  if (m && !chips.some((c) => c.kind === 'zec_send')) {
    const who = findContact(m[5] || m[1]);
    chips.push({ kind: 'gift', brand: m[3], amount: num(m[2] || m[4] || 100), name: who?.name || m[5] || (m[1] && m[1] !== 'a' ? m[1] : null), email: who?.email || null, demo: !!who?.demo });
  }

  // "esim for dubai", "get mom an esim in london"
  m = t.match(/\besim\s+(?:for|in|to)\s+([a-z]+(?:\s[a-z]+)?)/);
  if (m) chips.push({ kind: 'esim', country: m[1].replace(/\b(tomorrow|today|tonight|please|pls)\b.*$/, '').trim() });

  // "split 1200 between 4", "dinner was ₹1200 split with 3 people"
  m = t.match(/(?:₹|rs\.?\s?)?(\d[\d,]*)\D{0,30}?\bsplit\b\D{0,20}?(\d+)|\bsplit\s+(?:₹|rs\.?\s?)?(\d[\d,]*)\s+(?:between|with|among|by|in)\s+(\d+)/);
  if (m) {
    const total = num(m[1] || m[3]);
    const people = Number(m[2] || m[4]);
    if (total && people > 1) chips.push({ kind: 'zec_request', inr: Math.round(total / people), split: { total, people } });
  }

  // "zec price", "₹500 in zec", "0.1 zec in rupees"
  if (/\b(zec|zcash)\s+(price|rate)\b|\bprice of (zec|zcash)\b|how much is (a |one |1 )?(zec|zcash)/.test(t)) chips.push({ kind: 'price', amount: 1, unit: 'ZEC' });
  m = t.match(/(?:₹|rs\.?\s?)(\d[\d,]*)\s+(?:in|to)\s+zec\b|\b(\d[\d,]*)\s*(?:rupees|inr)\s+(?:in|to)\s+zec\b/);
  if (m) chips.push({ kind: 'price', amount: num(m[1] || m[2]), unit: 'INR' });
  m = t.match(/\b([\d.]+)\s*zec\s+(?:in|to)\s+(rupees|inr|usd|dollars)\b/);
  if (m) chips.push({ kind: 'price', amount: num(m[1]), unit: 'ZEC' });

  // Occasion words suggest a gift card nobody asked for yet.
  if (!chips.length) {
    for (const [re, occasion, brands] of OCCASIONS) {
      if (re.test(t)) {
        for (const brand of brands) chips.push({ kind: 'gift', brand, amount: 100, occasion });
        break;
      }
    }
  }

  // Travel talk suggests an eSIM.
  m = t.match(TRIPS);
  if (m && !chips.length) {
    const place = m[1].replace(/\b(next|this|tomorrow|today|tonight|soon|week|month|morning|evening|night|on|for|in|at|by)\b.*$/, '').trim();
    if (place && !['the', 'my', 'a', 'office', 'home', 'work'].includes(place)) chips.push({ kind: 'esim', country: place });
  }

  // Low balance talk suggests a top-up for yourself.
  if (!chips.length && /\b(balance (is )?(over|finished|low|khatam)|data (is )?(over|finished)|no data|recharge (khatam|over|expired))\b/.test(t)) {
    const me = findContact('me');
    chips.push({ kind: 'topup', amount: 199, name: 'me', phone: me?.phone || null, operator: me?.operator || 'jio' });
  }
  // A plain question gets an instant answer chip.
  if (!chips.length && /\?\s*$/.test(t) && t.split(/\s+/).length >= 4) chips.push({ kind: 'answer', question: text.trim() });
  return chips;
}

async function ai(text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || text.trim().length < 12) return [];
  const model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  const names = contacts().map((c) => c.name).join(', ');
  const prompt = `You suggest at most 2 actions for a phone keyboard in India, from the message the user is typing.
Actions (JSON objects):
{"kind":"gift","brand":one of ${BRANDS.join('|')},"amount":INR number,"name":recipient or null,"occasion":short word}
{"kind":"topup","name":who,"operator":"jio|airtel|vi|bsnl","amount":INR number}
{"kind":"esim","country":"country name"}
{"kind":"zec_send","name":who,"amount":ZEC number}
{"kind":"zec_request","amount":ZEC number}
Only suggest an action the message clearly invites. Known contacts: ${names}.
Reply with JSON only: {"chips":[...]} (empty list if nothing fits).
Message: """${text.slice(-400)}"""`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
    });
    clearTimeout(timer);
    const j = await r.json();
    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const chips = (JSON.parse(raw).chips || []).filter((c) => ['gift', 'topup', 'esim', 'zec_send', 'zec_request'].includes(c.kind));
    return chips.slice(0, 2).map((c) => {
      const who = findContact(c.name);
      if (c.kind === 'topup') return { ...c, phone: who?.phone || null, operator: c.operator || who?.operator, name: who?.name || c.name };
      if (c.kind === 'zec_send') return { ...c, address: who?.zec || null, name: who?.name || c.name };
      if (c.kind === 'gift') return { ...c, brand: BRANDS.includes(c.brand) ? c.brand : 'flipkart', amount: Number(c.amount) || 100 };
      return c;
    });
  } catch {
    return [];
  }
}

// Labels the keyboard shows; the payload goes back unchanged when the chip is tapped.
function label(c) {
  switch (c.kind) {
    case 'zec_send':
      return { title: `Send ${c.amount} ZEC${c.name ? ' to ' + cap(c.name) : ''}`, subtitle: c.address ? 'Shielded · Zcash' : 'No address saved' };
    case 'zec_request':
      if (c.split) return { title: `Split ₹${c.split.total} by ${c.split.people}: ask ₹${c.inr}`, subtitle: 'Paid in shielded ZEC' };
      return { title: `Request ${c.amount} ZEC`, subtitle: 'Shielded link' };
    case 'price':
      return { title: c.unit === 'INR' ? `₹${c.amount} in ZEC` : `${c.amount} ZEC in ₹ and $`, subtitle: 'Live price' };
    case 'answer':
      return { title: 'Ask Keyo', subtitle: c.question.slice(0, 32) };
    case 'swap':
      return { title: `Swap ${c.amount} ${c.from} → ${c.to}`, subtitle: 'NEAR Intents' };
    case 'topup':
      return { title: `Recharge ${(c.name || '').toLowerCase() === 'me' ? 'my' : cap(c.name) + "'s"} ${cap(c.operator || 'phone')} ₹${c.amount}`, subtitle: c.phone ? c.phone.replace(/^(\+\d{2})(\d{2})\d+(\d{3})$/, '$1 $2•••••$3') : 'No number saved' };
    case 'gift':
      return { title: `${c.name ? 'Send ' + cap(c.name) + ' ' : ''}₹${c.amount} ${cap(c.brand)} card`, subtitle: c.occasion ? `Gift for the ${c.occasion}` : 'Gift card · Bitrefill' };
    case 'esim':
      return { title: `eSIM for ${cap(c.country)}`, subtitle: 'Data on landing' };
    default:
      return { title: c.kind, subtitle: '' };
  }
}

export async function suggest(text) {
  let chips = rules(text);
  if (!chips.length) chips = await ai(text);
  return chips.slice(0, 3).map((c, i) => ({ id: `${Date.now()}-${i}`, ...label(c), ...c }));
}
