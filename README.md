# GenePulse - donor registry (research prototype)

Blood/organ donor registry with ABO/Rh matching, eligibility tracking, spreadsheet import, analytics, QR donor cards and a simulated DNA-kinship demo.
**Blood and DNA values are simulated until real hardware exists. Organ and kinship matching are heuristics, not clinical tools.**

## Run locally
1. Install Node 18+ and PostgreSQL. `npm install`
2. Copy `.env.example` to `.env` and fill it in (DATABASE_URL, JWT_SECRET 32+ random chars, ADMIN_USERNAME, ADMIN_PASSWORD 12+ chars).
3. `npm start` then open http://localhost:3000. Sign in as the admin; you must choose a new password at first login.
4. Tests: set `TEST_DATABASE_URL` to an empty throw-away database, then `npm test`.

## Deploy on Render
- Web Service from the GitHub repo: build `npm install`, start `npm start`.
- Environment: `NODE_ENV=production`, `DATABASE_URL` = the Postgres **Internal Database URL**, `JWT_SECRET` (new random), `ADMIN_USERNAME`, `ADMIN_PASSWORD`.
- Never commit `.env`. The old passcode `genepulse_secure_2026` is in git history: treat it as public and do not reuse it.
- Free tier sleeps after 15 min idle; the first request can take ~1 min (the app shows a "waking up" notice).

## Roles
admin (everything) / staff (register, edit, match, import) / viewer (read-only, masked phones).

## Before real use
Confirm eligibility thresholds with a medical officer, get consent processes and data-protection (India DPDP) review, and keep it a registry/decision-support tool (CDSCO software guidance).
