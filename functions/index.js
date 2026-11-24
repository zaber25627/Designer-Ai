/**
 * NEXAVAULT — Advanced Token Mining & Rewards Ecosystem (trusted backend)
 * -----------------------------------------------------------------------
 * Firebase Cloud Functions v2 against the Firebase REALTIME DATABASE.
 *
 * ARCHITECTURE NOTE: the MASTER PROMPT mentioned Cloud Firestore, but the
 * existing platform (user panel + admin panel) runs entirely on Firebase
 * REALTIME DATABASE (firebase.database(), compat SDK 10.8.1). Rebuilding on
 * Firestore would violate the preservation rule, so every function below
 * operates on the same RTDB nodes the panels use.
 *
 * NODE MAP (all additive — no existing nodes are renamed or removed):
 *   config/mining             { enabled, sessionHours, freeUpgrade,
 *                               inactivity:{enabled,thresholdHours,unlockFee} }
 *   config/miningLevels/{l}   { speed, cost, enabled, desc }  (admin overrides)
 *   config/miningBoost        { enabled, durationHours, multiplier, cost,
 *                               maxPerDay, minLevel }
 *   config/streak30           { enabled, days:{n:{type,main,token}},
 *                               graceHours, resetMissed, bonusMain, bonusToken }
 *   config/quiz               { enabled, simpleRewardMain, simpleRewardToken,
 *                               advRewardMain, advRewardToken,
 *                               dailyLimit, weeklyLimit }
 *   users/{uid}/mining        { st, level, seq, upgSeq, sessStart, sessEnd,
 *                               sessBoost{mult,expiresAt}, totalMined,
 *                               freeUpgradeUsed, lastClaimAt,
 *                               lockOn, lockReason, lockAt, lockFee, lockNote }
 *   users/{uid}/boost         { mult, expiresAt }
 *   users/{uid}/boostPurchases/{dayKey} = count
 *   users/{uid}/streak30      { day, lastKey, best, claims:{dayKey:ts} }
 *   users/{uid}/quizAns/{qid} = ts      (private; first-answer CAS)
 *   users/{uid}/quizStats|quizDaily|quizWeekly
 *   quizQuestions/{qid}       PRIVATE (holds `correct`) — admin write only
 *   quizPool/{qid}            PUBLIC sanitized mirror (no `correct`)
 *   quizBoard/{uid}           { name, correct, lines }
 *   miningHistory/{uid}, miningUpgrades/{uid}, dailyStreakClaims/{uid},
 *   ledger/{uid}, userNotifications/{uid}, adminNotifs
 *
 * SECURITY MODEL
 *  - Nothing client-sent is trusted: rewards, costs, speeds, timestamps and
 *    limits are always read from `config/...` server-side.
 *  - Balance-sensitive paths use RTDB transactions with negative guards and
 *    CAS compare-and-set semantics, with refunds on abort.
 *  - Scheduled jobs keep inactivity lock + boost expiry running even while
 *    the app is closed.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.database();

const REGION = 'us-central1';
const HOUR = 3600 * 1000;

/* ---------------------------- helpers ----------------------------- */

const num = (v, d = 0) => { const n = Number(v); return isFinite(n) ? n : d; };
const rnd = (v, d = 4) => Math.round(num(v) * Math.pow(10, d)) / Math.pow(10, d);
const DAY_HOUR = 24;

const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const weekKey = (ts = Date.now()) => {
  const d = new Date(ts);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const dayStart = key => new Date(key + 'T00:00:00Z').getTime();

function validStr(s, max = 4000) {
  return typeof s === 'string' && s.length > 0 && s.length <= max ? s : null;
}
const clampUid = uid =>
  (typeof uid === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(uid)) ? uid : null;
const clampLevel = l => Math.max(1, Math.min(100, Math.round(num(l, 1) || 1)));

async function getCfg(paths) {
  const snap = await db.ref('config').get();
  const root = snap.val() || {};
  const out = {};
  (paths || []).forEach(p => {
    let cur = root, hit = true;
    for (const k of p.split('/')) {
      if (cur && typeof cur === 'object' && k in cur) cur = cur[k];
      else { hit = false; break; }
    }
    out[p] = hit ? cur : null;
  });
  return out;
}

/** Default generator — MUST mirror the client generator exactly. */
function defaultLevels() {
  const m = {};
  for (let l = 1; l <= 100; l++) {
    m[l] = {
      speed: rnd(0.5 + 0.1 * (l - 1), 2),
      cost: l > 1 ? Math.round(60 * Math.pow(1.09, l - 2)) : 0,
      enabled: true,
      desc: ''
    };
  }
  return m;
}

async function levelsMap(maxLevel = 100) {
  const snap = await db.ref('config/miningLevels').get();
  const def = defaultLevels();
  const m = {};
  for (let l = 1; l <= maxLevel; l++) {
    const o = (snap.val() || {})[l] || {};
    m[l] = {
      speed: num(o.speed, def[l].speed),
      cost: num(o.cost, def[l].cost),
      enabled: o.enabled !== false,
      desc: typeof o.desc === 'string' ? o.desc : ''
    };
  }
  return m;
}

async function ledger(uid, o) {
  await db.ref(`ledger/${uid}`).push({
    cat: validStr(o.cat, 40) || 'misc',
    source: validStr(o.source, 60) || 'system',
    amount: num(o.amount),
    unit: validStr(o.unit, 10) || 'main',
    ref: validStr(o.ref, 80) || '',
    note: validStr(o.note, 200) || '',
    ts: admin.database.ServerValue.TIMESTAMP
  });
}

async function notifyUser(uid, cat, title, body) {
  await db.ref(`userNotifications/${uid}`).push({
    cat: validStr(cat, 30) || 'system',
    title: validStr(title, 120) || 'Notice',
    body: validStr(body, 500) || '',
    read: false,
    ts: admin.database.ServerValue.TIMESTAMP
  });
}

const bumpStat = async (path, delta, isFloat) => {
  await db.ref(path).transaction(cur => {
    const v = num(cur, 0) + delta;
    if (v < 0) return 0;
    return isFloat ? rnd(v, 4) : v;
  });
};

/** Reward for a finished session, computed only from trusted config. */
async function sessionReward(mining) {
  const mc = (await getCfg(['mining']))['mining'] || {};
  const hours = num(mc.sessionHours, 24);
  const lvl = clampLevel(mining.level);
  const levels = await levelsMap(100);
  const base = num((levels[lvl] || {}).speed, 0.5 + 0.1 * (lvl - 1));
  let mult = 1;
  const sb = mining.sessBoost;
  if (sb && num(sb.expiresAt, 0) > num(mining.sessEnd, 0)) mult = num(sb.mult, 1);
  return rnd(base * hours * mult, 4);
}

/** Deduct `amount` tokens; returns committed bool (negative-guarded). */
async function deductTokens(uid, amount) {
  const t = await db.ref(`users/${uid}/tokenBalance`).transaction(cur => {
    const c = num(cur, 0);
    if (c < amount) return; // insufficient
    return rnd(c - amount, 4);
  });
  return t.committed;
}
const refundTokens = (uid, amount) =>
  db.ref(`users/${uid}/tokenBalance`).transaction(cur => rnd(num(cur, 0) + amount, 4));

/* ------------------------------------------------------------------ */
/* Scheduled job 1 — inactivity lock scan (every 15 minutes)           */
/* ------------------------------------------------------------------ */

exports.nxInactivityScanJob = onSchedule(
  { schedule: 'every 15 minutes', region: REGION, timeZone: 'Etc/UTC' },
  async () => {
    const mc = (await getCfg(['mining']))['mining'] || {};
    const inact = mc.inactivity || {};
    if (mc.enabled === false || inact.enabled === false) return;

    const thresholdHours = num(inact.thresholdHours, 48);
    if (thresholdHours <= 0) return;
    const cutoff = Date.now() - thresholdHours * HOUR;

    const snap = await db.ref('users')
      .orderByChild('mining/st').equalTo('active')
      .get();
    const users = snap.val() || {};
    let locked = 0;

    for (const uid of Object.keys(users)) {
      const m = users[uid].mining || {};
      const sessEnd = num(m.sessEnd, 0);
      if (m.lockOn || !sessEnd || sessEnd >= cutoff) continue;

      const fee = num(inact.unlockFee, 100);

      const t = await db.ref(`users/${uid}/mining`).transaction(cur => {
        if (!cur || cur.st !== 'active' || cur.lockOn) return; // CAS vs client/lazy lock
        return {
          ...cur,
          st: 'ready',
          lockOn: true,
          lockReason: 'inactivity',
          lockAt: admin.database.ServerValue.TIMESTAMP,
          lockFee: fee,
          lockNote: `Auto-locked: session unclaimed for ${thresholdHours}h. Unclaimed session rewards are void.`
        };
      });
      if (!t.committed) continue;

      await db.ref(`miningHistory/${uid}`).push({
        type: 'autolock',
        level: clampLevel(m.level),
        sessStart: num(m.sessStart, 0),
        sessEnd,
        voided: true,
        note: `unclaimed ${thresholdHours}h`,
        ts: admin.database.ServerValue.TIMESTAMP
      });
      await notifyUser(
        uid, 'mining', 'Mining locked',
        `Mining auto-locked after ${thresholdHours}h without claiming. ` +
        `Pay ${fee} tokens to unlock. The unclaimed session reward is void.`
      );
      locked++;
    }

    if (locked > 0) {
      await db.ref('adminNotifs').push({
        cat: 'mining',
        title: 'Inactivity scan',
        body: `${locked} user(s) auto-locked (threshold ${thresholdHours}h).`,
        ts: admin.database.ServerValue.TIMESTAMP
      });
    }
  }
);

/* ------------------------------------------------------------------ */
/* Scheduled job 2 — boost expiry sweep (every 10 minutes)             */
/* ------------------------------------------------------------------ */

exports.nxBoostExpiryJob = onSchedule(
  { schedule: 'every 10 minutes', region: REGION, timeZone: 'Etc/UTC' },
  async () => {
    const now = Date.now();
    const snap = await db.ref('users').get();
    const users = snap.val() || {};
    let cleared = 0;

    for (const uid of Object.keys(users)) {
      const u = users[uid];
      const b = u.boost;
      const m = u.mining || {};

      const boostExpired = b && num(b.expiresAt, 0) > 0 && num(b.expiresAt, 0) < now;
      const sbExpired = m.sessBoost &&
        num(m.sessBoost.expiresAt, 0) > 0 && num(m.sessBoost.expiresAt, 0) < now;

      if (!boostExpired && !sbExpired) continue;

      if (boostExpired) await db.ref(`users/${uid}/boost`).remove();
      if (sbExpired) {
        await db.ref(`users/${uid}/mining/sessBoost`).transaction(cur =>
          (cur && num(cur.expiresAt, 0) < now) ? null : cur
        );
      }
      cleared++;
    }

    if (cleared > 0) {
      await db.ref('adminNotifs').push({
        cat: 'mining', title: 'Boost expiry',
        body: `Expired boosts cleared for ${cleared} user(s).`,
        ts: admin.database.ServerValue.TIMESTAMP
      });
    }
  }
);

/* ------------------------------------------------------------------ */
/* Callable — secure quiz grading                                      */
/* ------------------------------------------------------------------ */

exports.nxQuizSubmit = onCall({ region: REGION }, async req => {
  const uid = req.auth && clampUid(req.auth.uid);
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const qid = validStr(req.data && req.data.qid, 60);
  const pick = num(req.data && req.data.pick, -1);
  if (!qid || pick < 0 || pick > 3) {
    throw new HttpsError('invalid-argument', 'Invalid answer payload.');
  }

  const qz = (await getCfg(['quiz']))['quiz'] || {};
  if (qz.enabled === false) throw new HttpsError('failed-precondition', 'Quiz is disabled.');

  // First answer wins. CAS: only store a timestamp if none exists.
  const ansRef = db.ref(`users/${uid}/quizAns/${qid}`);
  let cas;
  await ansRef.transaction(cur => {
    if (cur !== null) return;                 // someone (earlier attempt) answered
    cas = true;
    return admin.database.ServerValue.TIMESTAMP;
  });
  if (!cas) throw new HttpsError('failed-precondition', 'Question already answered.');

  const qsnap = await db.ref(`quizQuestions/${qid}`).get();
  const q = qsnap.val();
  if (!q || q.on === false) throw new HttpsError('failed-precondition', 'Question not available.');

  // Attempt limits (daily / weekly lines)
  const dk = dayKey(), wk = weekKey();
  const [dSnap, wSnap] = await Promise.all([
    db.ref(`users/${uid}/quizDaily/${dk}`).get(),
    db.ref(`users/${uid}/quizWeekly/${wk}`).get()
  ]);
  const dLines = num((dSnap.val() || {}).lines, 0);
  const wLines = num((wSnap.val() || {}).lines, 0);
  if (dLines >= num(qz.dailyLimit, 50)) throw new HttpsError('resource-exhausted', 'Daily quiz limit reached.');
  if (wLines >= num(qz.weeklyLimit, 300)) throw new HttpsError('resource-exhausted', 'Weekly quiz limit reached.');

  // Grade from the PRIVATE question node. `correct` never leaves this function.
  const adv = q.cat === 'advanced';
  const isCorrect = pick === num(q.correct, -1);
  const dVal = dSnap.val() || {};
  const wVal = wSnap.val() || {};

  let main = 0, token = 0;
  if (isCorrect) {
    main = num(adv ? qz.advRewardMain : qz.simpleRewardMain, adv ? 1 : 0.5);
    token = num(adv ? qz.advRewardToken : qz.simpleRewardToken, adv ? 1 : 0.5);
  }

  if (main > 0) {
    await bumpStat(`users/${uid}/balance`, main, true);
    await bumpStat(`users/${uid}/totalEarned`, main, true);
    await ledger(uid, { cat: 'quiz', source: 'quiz', amount: main, unit: 'main', ref: qid });
  }
  if (token > 0) {
    await bumpStat(`users/${uid}/tokenBalance`, token, true);
    await ledger(uid, { cat: 'quiz', source: 'quiz', amount: token, unit: 'token', ref: qid });
  }

  // Stats + counters + leaderboard aggregate.
  const name = validStr((await db.ref(`users/${uid}/name`).get()).val(), 60) || 'User';
  await db.ref().update({
    [`users/${uid}/quizStats/correct`]: num(((await db.ref(`users/${uid}/quizStats`).get()).val() || {}).correct, 0) + (isCorrect ? 1 : 0),
    [`users/${uid}/quizStats/wrong`]: num(((await db.ref(`users/${uid}/quizStats`).get()).val() || {}).wrong, 0) + (isCorrect ? 0 : 1),
    [`users/${uid}/quizStats/main`]: rnd(num(((await db.ref(`users/${uid}/quizStats`).get()).val() || {}).main, 0) + main, 4),
    [`users/${uid}/quizStats/token`]: rnd(num(((await db.ref(`users/${uid}/quizStats`).get()).val() || {}).token, 0) + token, 4),
    [`users/${uid}/quizDaily/${dk}/lines`]: dLines + 1,
    [`users/${uid}/quizDaily/${dk}/correct`]: num(dVal.correct, 0) + (isCorrect ? 1 : 0),
    [`users/${uid}/quizDaily/${dk}/main`]: rnd(num(dVal.main, 0) + main, 4),
    [`users/${uid}/quizDaily/${dk}/token`]: rnd(num(dVal.token, 0) + token, 4),
    [`users/${uid}/quizWeekly/${wk}/lines`]: wLines + 1,
    [`users/${uid}/quizWeekly/${wk}/correct`]: num(wVal.correct, 0) + (isCorrect ? 1 : 0),
    [`quizBoard/${uid}/name`]: name,
    [`quizBoard/${uid}/correct`]: num(((await db.ref(`quizBoard/${uid}`).get()).val() || {}).correct, 0) + (isCorrect ? 1 : 0),
    [`quizBoard/${uid}/lines`]: num(((await db.ref(`quizBoard/${uid}`).get()).val() || {}).lines, 0) + 1
  });

  // Response leaks nothing beyond what the user already saw.
  return { ok: true, correct: isCorrect, correctIdx: isCorrect ? pick : -1, main: rnd(main, 4), token: rnd(token, 4) };
});

/* ------------------------------------------------------------------ */
/* Callables — mining lifecycle                                        */
/* ------------------------------------------------------------------ */

exports.nxMineStart = onCall({ region: REGION }, async req => {
  const uid = req.auth && clampUid(req.auth.uid);
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const mc = (await getCfg(['mining']))['mining'] || {};
  if (mc.enabled === false) throw new HttpsError('failed-precondition', 'Mining is currently disabled.');
  const hours = num(mc.sessionHours, 24);

  const mRef = db.ref(`users/${uid}/mining`);
  let started = false;
  await mRef.transaction(cur => {
    const m = cur || {};
    if (m.lockOn) return;                                 // locked
    if (m.st === 'active') return;                        // already running
    if (!m.st || m.st === 'ready' || m.st === 'claimed') {
      started = true;
      return {
        ...m,
        st: 'active',
        seq: num(m.seq, 0) + 1,
        sessClaimed: false,
        sessStart: admin.database.ServerValue.TIMESTAMP,
        sessEnd: 0
      };
    }
    return; // must claim previous session first
  });
  if (!started) throw new HttpsError('failed-precondition', 'Cannot start: claim the previous session or unlock first.');

  // Trusted server-clock endpoint written from the committed start value.
  const m = (await mRef.get()).val() || {};
  const start = num(m.sessStart, Date.now());
  await mRef.update({ sessEnd: start + hours * HOUR });
  return { ok: true, start, end: start + hours * HOUR };
});

exports.nxMineClaim = onCall({ region: REGION }, async req => {
  const uid = req.auth && clampUid(req.auth.uid);
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const mRef = db.ref(`users/${uid}/mining`);
  const m = (await mRef.get()).val();
  if (!m || m.st !== 'active' || m.lockOn) {
    throw new HttpsError('failed-precondition', 'No claimable session.');
  }
  const sessEnd = num(m.sessEnd, 0);
  if (!sessEnd || sessEnd > Date.now()) {
    throw new HttpsError('failed-precondition', 'Session has not finished yet.');
  }

  const reward = await sessionReward(m);

  // CAS flip → only one concurrent claim can win.
  const t = await mRef.transaction(cur => {
    if (!cur || cur.st !== 'active' || cur.lockOn) return;
    return {
      ...cur,
      st: 'claimed',
      sessClaimed: true,
      lastClaimAt: admin.database.ServerValue.TIMESTAMP,
      lastReward: reward
    };
  });
  if (!t.committed) throw new HttpsError('failed-precondition', 'Claim conflict — already claimed.');

  await bumpStat(`users/${uid}/tokenBalance`, reward, true);
  await bumpStat(`users/${uid}/mining/totalMined`, reward, true);
  await ledger(uid, { cat: 'mining', source: 'mining-claim', amount: reward, unit: 'token' });
  await db.ref(`miningHistory/${uid}`).push({
    type: 'claim',
    level: clampLevel(m.level),
    sessStart: num(m.sessStart, 0),
    sessEnd,
    reward,
    ts: admin.database.ServerValue.TIMESTAMP
  });
  return { ok: true, reward };
});

exports.nxMineUpgrade = onCall({ region: REGION }, async req => {
  const uid = req.auth && clampUid(req.auth.uid);
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const mc = (await getCfg(['mining']))['mining'] || {};
  if (mc.enabled === false) throw new HttpsError('failed-precondition', 'Mining is currently disabled.');
  const freeEnabled = mc.freeUpgrade !== false;

  const mRef = db.ref(`users/${uid}/mining`);
  const curLvl = clampLevel(num(((await mRef.get()).val() || {}).level, 1));
  if (curLvl >= 100) throw new HttpsError('failed-precondition', 'Maximum level (100) reached.');
  const nextLvl = curLvl + 1;

  const levels = await levelsMap(100);
  const nl = levels[nextLvl];
  if (!nl || nl.enabled === false) {
    throw new HttpsError('failed-precondition', 'Next level is unavailable.');
  }

  const isFree = freeEnabled && ((await mRef.get()).val() || {}).freeUpgradeUsed !== true;
  const cost = isFree ? 0 : num(nl.cost, 0);

  if (cost > 0) {
    const paid = await deductTokens(uid, cost);
    if (!paid) throw new HttpsError('failed-precondition', 'Insufficient tokens.');
  }

  // CAS on the level: aborts refund payment for paid upgrades.
  const t = await mRef.transaction(cur => {
    const c = cur || {};
    if (clampLevel(num(c.level, 1)) !== curLvl) return;                 // level moved
    if (isFree && c.freeUpgradeUsed === true) return;                   // free already used
    return {
      ...c,
      level: nextLvl,
      upgSeq: num(c.upgSeq, 0) + 1,
      freeUpgradeUsed: isFree ? true : c.freeUpgradeUsed === true
    };
  });

  if (!t.committed) {
    if (cost > 0) await refundTokens(uid, cost);
    throw new HttpsError('failed-precondition',
      isFree ? 'Free upgrade already used.' : 'Upgrade conflict — payment refunded.');
  }

  await db.ref(`miningUpgrades/${uid}`).push({
    from: curLvl, to: nextLvl, free: isFree, cost, ts: admin.database.ServerValue.TIMESTAMP
  });
  return { ok: true, level: nextLvl, free: isFree, cost };
});

exports.nxMineUnlock = onCall({ region: REGION }, async req => {
  const uid = req.auth && clampUid(req.auth.uid);
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const inact = (((await getCfg(['mining']))['mining'] || {}).inactivity) || {};
  const fee = num(inact.unlockFee, 100);

  const paid = await deductTokens(uid, fee);
  if (!paid) throw new HttpsError('failed-precondition', `Insufficient tokens (unlock fee ${fee}).`);

  const t = await db.ref(`users/${uid}/mining`).transaction(cur => {
    if (!cur || !cur.lockOn) return;   // CAS: not actually locked
    const c = { ...cur };
    c.st = 'ready';
    delete c.lockOn; delete c.lockReason; delete c.lockAt;
    delete c.lockFee; delete c.lockNote;
    return c;
  });
  if (!t.committed) {
    await refundTokens(uid, fee);
    throw new HttpsError('failed-precondition', 'Mining is not locked — payment refunded.');
  }

  await ledger(uid, { cat: 'mining', source: 'inactivity-unlock', amount: -fee, unit: 'token' });
  await db.ref('adminNotifs').push({
    cat: 'mining', title: 'Unlock paid',
    body: `User ${uid} paid ${fee} token unlock fee.`,
    ts: admin.database.ServerValue.TIMESTAMP
  });
  return { ok: true, fee };
});

exports.nxBoostBuy = onCall({ region: REGION }, async req => {
  const uid = req.auth && clampUid(req.auth.uid);
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const bc = (await getCfg(['miningBoost']))['miningBoost'] || {};
  if (bc.enabled === false) throw new HttpsError('failed-precondition', 'Boosts are disabled.');

  const cost = num(bc.cost, 50);
  const duration = num(bc.durationHours, 24);
  const mult = num(bc.multiplier, 2);
  const minLevel = num(bc.minLevel, 5);
  const maxPerDay = num(bc.maxPerDay, 2);
  const dk = dayKey();

  const purRef = db.ref(`users/${uid}/boostPurchases/${dk}`);
  const counted = await purRef.transaction(cur => {
    const c = num(cur, 0);
    if (c >= maxPerDay) return;
    return c + 1;
  });
  if (!counted.committed) throw new HttpsError('resource-exhausted', 'Daily boost purchase limit reached.');

  const level = clampLevel(num((((await db.ref(`users/${uid}/mining`).get()).val()) || {}).level, 1));
  if (level < minLevel) {
    await purRef.transaction(cur => Math.max(0, num(cur, 1) - 1)); // release counter
    throw new HttpsError('failed-precondition', `Boost requires mining level ${minLevel}+.`);
  }

  if (!(await deductTokens(uid, cost))) {
    await purRef.transaction(cur => Math.max(0, num(cur, 1) - 1)); // release counter
    throw new HttpsError('failed-precondition', 'Insufficient tokens.');
  }

  const now = Date.now();
  const expiresAt = now + duration * HOUR;

  // Stacking: active boost extends from its existing expiry.
  await db.ref(`users/${uid}/boost`).transaction(cur =>
    ({ mult, expiresAt: (cur && num(cur.expiresAt, 0) > now ? num(cur.expiresAt, 0) : now) + duration * HOUR })
  );

  // Active session gets the boost window stamped; base speed stays untouched.
  const mRef = db.ref(`users/${uid}/mining`);
  const m = (await mRef.get()).val();
  if (m && m.st === 'active') {
    await mRef.child('sessBoost').transaction(cur =>
      ({ mult, expiresAt: (cur && num(cur.expiresAt, 0) > now ? num(cur.expiresAt, 0) : now) + duration * HOUR })
    );
  }

  await ledger(uid, { cat: 'mining', source: 'boost-buy', amount: -cost, unit: 'token' });
  return { ok: true, mult, expiresAt };
});

exports.nxStreakClaim = onCall({ region: REGION }, async req => {
  const uid = req.auth && clampUid(req.auth.uid);
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const sc = (await getCfg(['streak30']))['streak30'] || {};
  if (sc.enabled === false) throw new HttpsError('failed-precondition', 'Streak rewards are disabled.');

  const grace = num(sc.graceHours, 4);
  const resetMissed = sc.resetMissed !== false;
  const dk = dayKey();

  const sRef = db.ref(`users/${uid}/streak30`);
  const s = (await sRef.get()).val() || {};

  if (s.lastKey === dk) throw new HttpsError('failed-precondition', 'Already claimed today.');
  if (num(s.day, 0) >= 30) {
    throw new HttpsError('failed-precondition', '30-day streak complete. Contact support to reset the cycle.');
  }

  // Break detection (UTC day keys + admin-configurable grace hours).
  let day = num(s.day, 0);
  if (s.lastKey) {
    const lastDay = dayStart(s.lastKey);
    const yKey = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
    const yStart = dayStart(yKey);
    const consecutive = s.lastKey === yKey || s.lastKey === dk;
    if (!consecutive && resetMissed) {
      // Outside the streak chain; allow it only inside the grace window right
      // after the missed day, otherwise reset to 0.
      if (grace <= 0 || Date.now() > yStart + grace * HOUR) day = 0;
    }
  }

  const nextDay = Math.min(30, day + 1);
  const dCfg = (sc.days || {})[nextDay] || {};
  const type = dCfg.type || 'both';
  const main = type === 'token' ? 0 : num(dCfg.main, 0);
  const token = type === 'main' ? 0 : num(dCfg.token, 0);
  let bonusMain = 0, bonusToken = 0;
  if (nextDay === 30) {
    bonusMain = num(sc.bonusMain, 0);
    bonusToken = num(sc.bonusToken, 0);
  }

  // CAS on the day key — duplicate-proof.
  const cas = await sRef.child(`claims/${dk}`).transaction(cur =>
    (cur === null ? admin.database.ServerValue.TIMESTAMP : undefined)
  );
  if (!cas.committed) throw new HttpsError('failed-precondition', 'Already claimed today.');

  const totMain = main + bonusMain;
  const totToken = token + bonusToken;

  if (totMain > 0) {
    await bumpStat(`users/${uid}/balance`, totMain, true);
    await bumpStat(`users/${uid}/totalEarned`, totMain, true);
    await ledger(uid, { cat: 'streak', source: 'streak30', amount: totMain, unit: 'main', ref: `day-${nextDay}` });
  }
  if (totToken > 0) {
    await bumpStat(`users/${uid}/tokenBalance`, totToken, true);
    await ledger(uid, { cat: 'streak', source: 'streak30', amount: totToken, unit: 'token', ref: `day-${nextDay}` });
  }

  await db.ref(`users/${uid}/streak30`).transaction(cur => {
    const c = cur || {};
    return { ...c, day: nextDay, lastKey: dk, best: Math.max(num(c.best, 0), nextDay) };
  });

  await db.ref(`dailyStreakClaims/${uid}/${dk}`).set({
    day: nextDay,
    main: rnd(totMain, 4),
    token: rnd(totToken, 4),
    bonus: nextDay === 30,
    ts: admin.database.ServerValue.TIMESTAMP
  });

  return {
    ok: true, day: nextDay,
    main: rnd(totMain, 4), token: rnd(totToken, 4), bonus: nextDay === 30
  };
});
