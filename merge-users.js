#!/usr/bin/env node
/**
 * merge-users.js
 * -----------------------------------------------------------------------
 * One-off tool to merge one user's saved picks into another user's account
 * in your Upstash Redis database, for Ryder Pick 'Em.
 *
 * WHAT IT DOES
 *   - Copies every saved pick from <source> into <target>.
 *   - If both users happened to save the exact same pick (same game +
 *     market + side), the target's existing copy is kept and the source's
 *     duplicate is skipped (reported, not silently dropped).
 *   - Login credentials, admin status, etc. are untouched — this only
 *     merges the `picks` data. After merging, log in as <target> going
 *     forward; <source>'s login still exists unless you pass --delete-source.
 *
 * SAFETY
 *   - Dry run by default. Nothing is written until you pass --confirm.
 *   - Before writing anything, the ENTIRE current `users` record is backed
 *     up to a local timestamped JSON file, so you can restore by hand if
 *     something looks wrong afterward.
 *   - Even with --confirm, it asks you to type "yes" before touching the
 *     database.
 *
 * USAGE
 *   node merge-users.js <sourceUsername> <targetUsername>              (dry run)
 *   node merge-users.js <sourceUsername> <targetUsername> --confirm     (apply)
 *   node merge-users.js <sourceUsername> <targetUsername> --confirm --delete-source
 *
 * Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN from a .env file
 * in the same folder (or from already-exported environment variables) —
 * the same two values your app's .env already has.
 * -----------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- Load .env from this script's folder, if present, without needing the
//     'dotenv' package installed anywhere ---------------------------------
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error(
    '\nMissing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.\n' +
    'Put a .env file next to this script with both values (same ones your app uses),\n' +
    'or export them in your shell before running this.\n'
  );
  process.exit(1);
}

// --- Minimal Upstash REST client (no dependencies) -----------------------
async function redisCommand(commandArray) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commandArray),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Redis error: ${data.error}`);
  return data.result;
}

async function getUsers() {
  const raw = await redisCommand(['GET', 'users']);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function setUsers(users) {
  await redisCommand(['SET', 'users', JSON.stringify(users)]);
}

function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

// --- Main ------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter(a => !a.startsWith('--'));
  const confirm = args.includes('--confirm');
  const deleteSource = args.includes('--delete-source');

  if (positional.length < 2) {
    console.error(
      '\nUsage: node merge-users.js <sourceUsername> <targetUsername> [--confirm] [--delete-source]\n'
    );
    process.exit(1);
  }

  const [sourceUsername, targetUsername] = positional;

  console.log('\nFetching current users from Redis…');
  const users = await getUsers();

  const findUser = name => users.find(u => u.username.toLowerCase() === name.toLowerCase());
  const source = findUser(sourceUsername);
  const target = findUser(targetUsername);

  if (!source) {
    console.error(`\nNo user found with username "${sourceUsername}".`);
    process.exit(1);
  }
  if (!target) {
    console.error(`\nNo user found with username "${targetUsername}".`);
    process.exit(1);
  }
  if (source.id === target.id) {
    console.error('\nSource and target are the same account — nothing to merge.');
    process.exit(1);
  }

  const sourcePicks = source.picks || {};
  const targetPicks = { ...(target.picks || {}) };

  const toMerge = [];
  const collisions = [];

  Object.entries(sourcePicks).forEach(([key, pick]) => {
    if (targetPicks[key]) {
      collisions.push({ key, pick });
    } else {
      toMerge.push({ key, pick });
      targetPicks[key] = pick;
    }
  });

  console.log(`\nSource: ${source.username}  (${Object.keys(sourcePicks).length} saved picks)`);
  console.log(`Target: ${target.username}  (${Object.keys(target.picks || {}).length} saved picks before merge)`);
  console.log(`\nWill merge in:  ${toMerge.length} pick(s)`);
  toMerge.forEach(({ pick }) => {
    console.log(`   + ${pick.gameSummary || '?'} — ${pick.pickLabel || '?'} (${pick.priceText || '?'}, ${pick.units || 1}u)`);
  });

  if (collisions.length > 0) {
    console.log(`\nSkipped (target already has the identical pick):  ${collisions.length}`);
    collisions.forEach(({ pick }) => {
      console.log(`   ~ ${pick.gameSummary || '?'} — ${pick.pickLabel || '?'} (kept target's copy)`);
    });
  }

  console.log(`\nTarget will have ${Object.keys(targetPicks).length} saved picks after merge.`);

  if (deleteSource) {
    console.log(`\n"${source.username}"'s account will be DELETED ENTIRELY after the merge (--delete-source was passed).`);
  } else {
    console.log(`\n"${source.username}"'s account and login will be left as-is (its picks are now duplicated into the target too).`);
    console.log('Pass --delete-source if you want the source account removed once the merge is confirmed good.');
  }

  if (!confirm) {
    console.log('\nDry run only — nothing was written. Re-run with --confirm to actually apply this.\n');
    return;
  }

  const proceed = await askYesNo('\nType "yes" to write these changes to your live database: ');
  if (!proceed) {
    console.log('\nCancelled — nothing was written.\n');
    return;
  }

  // Back up the *entire* current users record before touching anything.
  const backupPath = path.join(__dirname, `users-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ users }, null, 2));
  console.log(`\nBacked up current data to ${backupPath}`);

  const updatedUsers = users
    .map(u => (u.id === target.id ? { ...u, picks: targetPicks } : u))
    .filter(u => !(deleteSource && u.id === source.id));

  await setUsers(updatedUsers);

  console.log('\nDone.');
  console.log(`  - ${toMerge.length} pick(s) merged into "${target.username}"`);
  if (collisions.length > 0) console.log(`  - ${collisions.length} duplicate pick(s) skipped`);
  if (deleteSource) console.log(`  - "${source.username}"'s account was deleted`);
  console.log(`\nIf anything looks wrong, restore from: ${backupPath}\n`);
}

main().catch(err => {
  console.error('\nSomething went wrong:', err.message);
  process.exit(1);
});
