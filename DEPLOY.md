# NEXAVAULT — Deployment Instructions
## Advanced Token Mining & Rewards Ecosystem Upgrade

> Scope: incremental upgrade of the existing Binance-style Rewards + Token Market
> Telegram Mini App. No existing feature was redesigned, renamed, or removed.

---

## 1. Delivery Files

| File | Role |
|---|---|
| `index.html` | Updated **user panel** (existing app + mining/streak/quiz/all-pages modules) |
| `admin.html` | Updated **admin panel** (existing app + Advanced Mining & Rewards Management) |
| `functions/index.js` | Trusted Cloud Functions (v2, RTDB) — quiz grading, mining lifecycle, schedulers |
| `functions/package.json` | Functions project manifest |
| `database.rules.json` | **Additive** RTDB security-rules template for the new nodes — merge into your existing rules, do not replace them |
| `nx_user_part1.js`, `nx_user_part2.js`, `nx_user_part3.js`, `nx_user_style.css` | Development sources that were assembled into `index.html` (kept for review; not needed at runtime) |
| `nx_admin_module.js`, `nx_admin_style.css` | Development sources assembled into `admin.html` (kept for review; not needed at runtime) |
| `IMPLEMENTATION_REPORT.md` | Phase-by-phase report + regression results |
| `DEPLOY.md` | This file |

---

## 2. Deploy the Panels (Firebase Hosting)

```bash
firebase deploy --only hosting        # publishes index.html + admin.html
```

No other hosting-side change is required. Both files are self-contained single
HTML apps and keep using the existing Firebase compat SDK 10.8.1 configuration
already embedded in your originals.

---

## 3. Deploy the Cloud Functions

```bash
cd functions
npm install
npm run lint          # node --check index.js
firebase deploy --only functions
```

Deployed functions (region `us-central1`):

| Function | Type | Purpose |
|---|---|---|
| `nxQuizSubmit` | onCall | Secure quiz grading — correct answers never leave the server |
| `nxMineStart` | onCall | Trusted 24h session start (CAS, server timestamps) |
| `nxMineClaim` | onCall | Trusted reward credit (config-only amounts, one claim per session) |
| `nxMineUpgrade` | onCall | Trusted level upgrade (payment → CAS level → refund-on-abort) |
| `nxMineUnlock` | onCall | Inactivity-lock unlock (fee deduct → CAS unlock → refund) |
| `nxBoostBuy` | onCall | Boost purchase (limit check → payment → expiring boost) |
| `nxStreakClaim` | onCall | 30-day streak claim (CAS day key, UTC, grace window) |
| `nxInactivityScanJob` | scheduler, every 15 min | Auto-locks sessions unclaimed past the threshold — runs even when the app is closed |
| `nxBoostExpiryJob` | scheduler, every 10 min | Removes expired boosts |

Optional hardening: after deploying functions you may tighten
`miningHistory` / `miningUpgrades` / `dailyStreakClaims` rules to
`auth != null && auth.uid === $uid` and route those writes through the
callables (admin SDK bypasses rules). The client already tries callables first
and falls back to client-side transactions only when they are absent.

---

## 4. Publish the Security Rules

1. Open `database.rules.json`.
2. Copy the node blocks (`config`, `quizQuestions`, `quizPool`, `quizBoard`,
   `miningHistory`, `miningUpgrades`, `dailyStreakClaims`, `favPages`,
   `adminAuditLogs`) **into your existing rules** at the same nesting level —
   DO NOT replace your current rules file wholesale.
3. Publish either from the Firebase Console → Realtime Database → Rules, or:
   ```bash
   firebase deploy --only database
   ```

If your admin panel has a Rules publisher page, you can paste the merged JSON
there instead.

---

## 5. First-Run Admin Configuration

Open the updated `admin.html` → **Mining & Rewards** nav group:

1. **Mining Management → Controls tab**
   - Master Mining ON/OFF (default OFF — switch ON when ready).
   - Session duration (default `24` hours).
   - Free First Upgrade ON/OFF (default ON).
   - Inactivity lock: Enable/Disable, Threshold hours (default `48`),
     Unlock token fee (default `100`).
2. **Levels tab**
   - 100-row table of speed / cost / enabled / description — all optional;
     blank rows use the built-in generator
     (`speed = 0.5 + 0.1×(level−1)`, `cost = round(60×1.09^(level−1))`).
   - Use **Generate defaults** to prefill the table before publishing.
3. **Boost tab**
   - Enabled, duration hours (default `24`), multiplier (default `2`),
     cost (default `50`), max purchases/day (default `2`), min eligible level (default `5`).
4. **30-Day Streak page**
   - Enable the module, set each day's reward type
     (`main` / `token` / `both`) with amounts, grace hours (default `4`),
     missed-day reset rule, 30-day completion bonus.
5. **Quiz Earning page**
   - Enable quizzes, set Simple/Advanced rewards, daily/weekly attempt limits.
   - Add questions (4 options + correct index + timer + category).
   - IMPORTANT: the trusted grading path (`nxQuizSubmit`) is used automatically
     when functions are deployed. The client-side *fallback grading* is
     disabled unless you explicitly enable `config/quiz/fallbackPool`,
     which would allow determined users to inspect answers in devtools —
     not recommended for production.
6. **Module Controls page**
   - Global ON/OFF for each new module (Mining / Streak / Quiz / All Pages).
   - Per-page visibility switches for the All Pages directory
     (`config/allpages/{pageId}/visible`).

All admin saves are audited (`adminAuditLogs`) and permission-gated the same
way as your existing admin config pages.

---

## 6. Database Migration Check

**No migration is required.** The upgrade only ADDS nodes:

- New config: `config/mining`, `config/miningLevels`, `config/miningBoost`,
  `config/streak30`, `config/quiz`, `config/allpages`
- New user fields (under the existing `users/{uid}`): `mining`, `boost`,
  `boostPurchases`, `streak30`, `quizAns`, `quizStats`, `quizDaily`, `quizWeekly`
- New top-level nodes: `miningHistory`, `miningUpgrades`, `dailyStreakClaims`,
  `quizQuestions` (private), `quizPool` (public sanitized), `quizBoard`,
  `favPages`, `adminAuditLogs`

All existing nodes (`users`, `ledger`, `userNotifications`, `withdrawals`,
`tokenWithdrawals`, `tokenTransactions`, `tokenPriceHistory`, `events`,
`giveaways`, `promoCodes`, `activeTasks`, `userTasks`, `vipRequests`,
`lbRounds`, `lbPoints`, `deviceProfiles`, …) are untouched and keep their
existing rules.

---

## 7. Post-Deploy Smoke Test

1. User panel → bottom nav → **Mining** → START → verify countdown + status
   `MINING_ACTIVE`.
2. Shorten `config/mining/sessionHours` to `0.01` on a TEST account → wait →
   CLAIM → verify token credit + `ledger` entry + history row.
3. Restore session hours to `24`.
4. Admin → Mining Users → lock a test user → user panel shows `LOCKED` →
   UNLOCK with token fee → verify deduct + unlock.
5. Streak claim today → claim again → second attempt rejected.
6. Quiz: answer correctly → reward credited; question re-answer attempt rejected.
7. All Pages nav → search, category chips, favorites work.
8. Confirm in `functions` logs that `nxInactivityScanJob` and
   `nxBoostExpiryJob` finish successfully.
