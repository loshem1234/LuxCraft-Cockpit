# LuxCraft Cockpit

The all-in-one business dashboard for LuxCraft Renovations: ledger, invoices and estimates, jobs and hours, bank imports, live Schedule C taxes, and a team of five Claude-powered specialists who propose changes for your approval.

Node 20+ · Express · PostgreSQL · Claude API · Gemini TTS. No build step.

## The agent team

| Agent | Title | Lives on | Specialty |
|---|---|---|---|
| Grace | Chief of Staff | Overview | Whole-business picture, daily briefing, connects the dots |
| Clara | Bookkeeper | Financials | Categorizing, splits, reimbursable materials, bank reconciliation, cash flow, Ohio sales/use tax |
| Helen | Tax Specialist | Taxes | Schedule C, SE tax, quarterlies, Ohio BID, Fairborn city & school district tax, 1099s, Section 179, home office |
| Vera | Project Estimator | Jobs | Fixed-bid pricing from past estimates and actuals, job costing, profit per hour, draws |
| Rosie | Foreman | Daily | Morning check-in, plans for you and helpers, hours per job, goals met |

- **Approval first.** Agents never change data. Each change they want appears as a card (in the chat, and under the ✓ button in the top bar). Nothing happens until you tap **Approve**.
- **Shared memory.** Facts you approve ("my day rate is $400") are known by every agent. Manage them in Settings → Agents & knowledge.
- **Knowledge folders.** Each agent has its own folder, plus a shared one. Upload PDFs, Word (.docx), text/CSV or photos; text is extracted and the agent reads it on every question (large folders are searched).
- **Web search.** All agents can look up current rules, rates and prices and cite sources.
- **Voice.** 🔊 on any reply reads it aloud with the agent's Gemini voice (prebuilt name like `Kore`, or your own `voice_…` ID). The speaker toggle in a chat reads every reply automatically. Mic button for dictation.
- **Names and voices** are editable in Settings → Agents & knowledge.

Names, titles, and voices are just defaults: rename anyone.

## Tabs

- **Overview** – Grace's daily briefing, month and YTD numbers, money owed, unbilled materials, tax set-aside, today's plan.
- **Financials** – Ledger (quick entry, receipt photo reading, split receipts, client-reimbursable materials with markup, sales tax/no-tax flags), Invoices (synced from the invoice app or uploaded), Bank import (CSV, auto-matching), Mileage, Charts.
- **Jobs** – Contract vs collected vs cost, budget warnings, your hours and real $/hour, unbilled materials; Estimates with win rate and line items; Crew & hours.
- **Taxes** – Schedule C line by line incl. home office (Line 30); estimated SE, federal (2026 brackets, QBI), Ohio (business income deduction), Fairborn school district and city tax; quarterly payments; Section 179 purchase planner; 1099-NEC tracker; Ohio sales/use tax.
- **Daily** – Rosie's check-in chat, today's goals by person, hours logged, 3-week history.
- **Settings** – Agents & knowledge, Business, Connections, Security, Categories, Data exports.

## Deploy on Railway

1. Push this folder to a new GitHub repo, then Railway → **New Project → Deploy from GitHub repo**.
2. **+ New → Database → PostgreSQL**, then in the app service's Variables add `DATABASE_URL = ${{Postgres.DATABASE_URL}}`.
3. Add the variables below, then **Settings → Networking → Generate Domain**.
4. Open the site, log in, and turn on two-factor login (Settings → Security).

Tables, categories and defaults are created on first start.

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Railway Postgres reference |
| `ADMIN_PASSWORD` | yes | Use 16+ characters |
| `ENCRYPTION_KEY` | yes | 64 hex characters. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **Keep a copy somewhere safe** – uploaded files can't be decrypted without it. |
| `ANTHROPIC_API_KEY` | for agents | Agents, receipt/invoice reading |
| `ANTHROPIC_MODEL` | no | Default `claude-sonnet-5-5` |
| `GEMINI_API_KEY` | for voice | Gemini 3.8 Flash TTS; without it the browser's voice is used |
| `GEMINI_TTS_MODEL` | no | Default `gemini-3.8-flash-tts` |
| `TZ` | no | Default `America/New_York` |

## Security

- Single owner login with optional (strongly recommended) **two-factor authentication** (any authenticator app) and one-time recovery codes.
- Server-side sessions (HttpOnly, SameSite=Strict, Secure cookies), 72-hour idle timeout, "sign out other devices".
- Login rate limiting and an **activity log** (logins, approvals, imports, deletions, key changes).
- Strict Content-Security-Policy, no third-party scripts (Chart.js is served locally), clickjacking and MIME-sniffing protection, HSTS, CSRF guard on every change.
- **Receipts, invoices and knowledge documents are encrypted at rest** (AES-256-GCM). Uploads are type-checked by their contents.
- Bank CSV import is read-only: no bank logins, no connection to your bank, no way to move money; long card/account numbers are masked before saving.
- The invoice app connects with a revocable key that can only add invoices/estimates, accepted only from that app's address.
- Agents can't change anything without your approval, and can't touch security settings.

## Connecting the invoice & estimate app

The invoice app keeps its data in the browser, so the browser sends it here:

1. Deploy the updated invoice app (adds `public/cockpit-sync.js`).
2. Cockpit → **Settings → Connections**: enter the invoice app's address, create a connection key.
3. Invoice app → **Settings → LuxCraft Cockpit**: paste the Cockpit address and key on each device you use.

Every save then syncs. Estimates come across with their line items; accepted estimates set the job's contract and make it active. Jobs are named "Client · Project".

**Payments go into the ledger automatically, exactly as the invoice app shows them.** The newest invoice on a contract holds the payment history: each earlier draw with its paid date and check # becomes one Contract Revenue entry, for the amount that draw's invoice billed (including change-order items and tax) and tagged with that invoice's number. If an invoice is marked Paid, its own draw is recorded too, dated the day it was marked Paid. Correct a date, check # or amount in the invoice app and the ledger entry follows on the next sync; clear a payment there and the synced entry is removed. Checks you already logged by hand (same invoice # plus the same check # or amount) are left alone and not doubled. Synced entries can be re-categorized in the Cockpit; their amount, date and check # always follow the invoice app.

You can also upload the app's **Export backup** files on the Invoices tab.

## How the money flows

- Client checks: **Income → Contract Revenue** with **Check #** and **Invoice #** (applies the payment to the invoice). Deposits count as income when received.
- Client-reimbursed materials: mark the expense **Client reimburses** (markup % from Settings → Business). The Jobs tab shows what's unbilled; their repayment is **Materials Reimbursement** income.
- Mixed receipts: **Split…** across jobs/categories; sales tax is shared proportionally.
- Quarterly tax payments: **Estimated Tax Payment** (not a business expense; counted on Taxes).
- Helpers/subs: pay them as **Subcontractors** (1099 tracker); log their hours for job costing.

The Taxes tab is a bookkeeping aid, not a filed return. Confirm with your accountant.

## Local development

```bash
npm install
DATABASE_URL=postgres://localhost/cockpit ADMIN_PASSWORD=dev ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm run dev
```
