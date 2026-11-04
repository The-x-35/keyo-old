// Small JSON store: contacts, spending ledger, approvals and activity.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'data');
const file = path.join(dir, 'state.json');
fs.mkdirSync(dir, { recursive: true });

function load() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const seed = JSON.parse(fs.readFileSync(path.join(root, 'contacts.example.json'), 'utf8'));
    return { contacts: seed, activity: [], approvals: {} };
  }
}
let state = load();
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));

export const contacts = () => state.contacts;
export function setContacts(list) {
  state.contacts = list;
  save();
}

export const activity = () => state.activity;
export function record(entry) {
  const e = { id: `act_${Date.now().toString(36)}`, at: new Date().toISOString(), ...entry };
  state.activity.unshift(e);
  state.activity = state.activity.slice(0, 200);
  save();
  return e;
}

// Rupees spent through Bitrefill today (IST), for the daily cap.
export function spentToday() {
  const day = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  return state.activity
    .filter((a) => a.type === 'bitrefill' && a.ok && !a.sandbox && new Date(Date.parse(a.at) + 5.5 * 3600_000).toISOString().slice(0, 10) === day)
    .reduce((s, a) => s + (Number(a.inr) || 0), 0);
}

export function addApproval(id, req) {
  state.approvals[id] = { ...req, at: new Date().toISOString(), status: 'waiting' };
  save();
}
export const approval = (id) => state.approvals[id];
export function settleApproval(id, status) {
  if (state.approvals[id]) state.approvals[id].status = status;
  save();
}
