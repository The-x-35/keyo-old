// Aegis: shielded Zcash wallets on the server (zcash-devtool), one on mainnet and
// one on testnet, so the keyboard can send without opening Zodl.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

function cfg(network) {
  const net = network || process.env.AEGIS_NETWORK || 'main';
  const bin = process.env.ZEC_DEVTOOL_BIN;
  const wallet = net === 'test' ? process.env.ZEC_TEST_WALLET_DIR : process.env.ZEC_WALLET_DIR;
  if (!bin || !wallet) throw new Error('Aegis is not set up (ZEC_DEVTOOL_BIN, ZEC_WALLET_DIR in server/.env)');
  return { net, bin, wallet, identity: process.env.ZEC_IDENTITY_FILE };
}

async function devtool(c, args, timeout = 240_000) {
  const { stdout, stderr } = await run(c.bin, ['wallet', '-w', c.wallet, ...args], { timeout, maxBuffer: 16 << 20 });
  return { out: stdout, err: stderr };
}

// One sync at a time per wallet; sends and balances wait on it.
const syncing = {};
export function sync(network) {
  const c = cfg(network);
  if (!syncing[c.net]) {
    syncing[c.net] = devtool(c, ['sync']).finally(() => delete syncing[c.net]);
  }
  return syncing[c.net];
}

export async function address(network) {
  const c = cfg(network);
  const { out } = await devtool(c, ['list-addresses']);
  const ua = out.match(/Default Address:\s*(\S+)/)?.[1];
  const t = (await devtool(c, ['list-addresses', '--receiver', 'transparent'])).out.match(/Receiver\(transparent\):\s*(\S+)/)?.[1];
  return { unified: ua, transparent: t };
}

export async function balance(network) {
  const c = cfg(network);
  await sync(network).catch(() => {});
  const { out } = await devtool(c, ['balance', '--json']);
  const j = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop() || '{}');
  const zat = (k) => Number(j[k] ?? 0);
  const total = zat('total') || zat('total_balance') || zat('balance');
  const spendable = zat('spendable') || zat('spendable_value') || zat('spendable_balance');
  return { network: c.net, total: total / 1e8, spendable: spendable / 1e8, raw: j, ...(await address(network)) };
}

export async function send(to, amountZec, memo, network) {
  const c = cfg(network);
  await sync(network).catch(() => {});
  const zats = Math.round(Number(amountZec) * 1e8);
  const args = ['send', '--identity', c.identity, '--address', to, '--value', String(zats)];
  // Memos only reach shielded recipients.
  if (memo && /^(u1|utest1|zs|ztestsapling)/.test(to)) args.push('--memo', memo);
  const { out, err } = await devtool(c, args);
  const txid = `${out}\n${err}`.match(/\b[0-9a-f]{64}\b/)?.[0];
  if (!txid) throw new Error(`Aegis send failed: ${`${err || out}`.trim().split('\n').pop().slice(0, 200)}`);
  return { txid, network: c.net, explorer: c.net === 'test' ? `https://testnet.zcashexplorer.app/transactions/${txid}` : `https://mainnet.zcashexplorer.app/transactions/${txid}` };
}
