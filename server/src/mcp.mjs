// Bitrefill eCommerce MCP: buys from any balance sub-account (the REST API only
// charges the primary one) and can send a card straight to someone's email.
const URL_MCP = 'https://api.bitrefill.com/mcp';
let nextId = 1;

export async function callTool(name, args) {
  const res = await fetch(URL_MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${process.env.BITREFILL_API_KEY}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const msg = JSON.parse(line ? line.slice(6) : raw);
  if (msg.error) throw new Error(`Bitrefill: ${msg.error.message}`);
  const text = msg.result?.content?.map((c) => c.text).join('\n') || '';
  if (msg.result?.isError) throw new Error(`Bitrefill: ${text.split('\n')[0].slice(0, 160)}`);
  return text;
}

// Replies are JSON or YAML-like text; read single fields out of either.
function field(text, key) {
  const m = text.match(new RegExp(`(?:^|\\n|[{,])\\s*"?${key}"?\\s*:\\s*"?([^"\\n]+)"?`, 'i'));
  return m ? m[1].trim().replace(/[",]+$/, '') : null;
}

export async function buy({ product_id, package_value, refill_input, gift }) {
  const item = { product_id, package_value: String(package_value) };
  if (refill_input) item.refill_input = refill_input.replace(/^\+/, '');
  if (gift) item.gift = gift;
  const text = await callTool('buy-products', {
    cart_items: [item],
    payment_method: 'balance',
    balance_currency: process.env.BITREFILL_BALANCE_CURRENCY || 'USD',
  });
  const invoice_id = field(text, 'invoice_id');
  if (!invoice_id) throw new Error(`Bitrefill: ${text.slice(0, 160)}`);
  return { invoice_id, access_token: field(text, 'invoice_access_token') };
}

// Paid isn't delivered: poll until the order lands.
export async function waitDelivered(invoice_id, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await callTool('get-invoice-by-id', { invoice_id });
    const status = field(t, 'invoice_status');
    const delivery = field(t, 'orders_delivery_status');
    if (delivery === 'all_delivered' || field(t, 'status') === 'delivered') {
      return {
        delivered: true,
        price: field(t, 'price'),
        currency: field(t, 'currency'),
        redemption: {
          code: field(t, 'code'),
          pin: field(t, 'pin'),
          other: field(t, 'other'),
          link: field(t, 'link') || field(t, 'redemption_link'),
          barcode_value: field(t, 'barcode_value'),
          instructions: field(t, 'instructions'),
        },
        access_link: field(t, 'access_link'),
      };
    }
    if (['expired', 'failed', 'refunded'].includes(status)) throw new Error(`Bitrefill: invoice ${status}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { delivered: false };
}

export async function balances() {
  const t = await callTool('get-balances', {});
  const out = {};
  for (const m of t.matchAll(/balance_currency:\s*(\w+)\s*\n\s*amount:\s*"([\d.]+)"/g)) out[m[1]] = Number(m[2]);
  return out;
}
