# FraudGraph frontend

Analyst console for the FraudGraph API (Ecobank InnovateX 2026). React 19 + Vite, plain CSS, **no runtime
dependencies beyond React**. The graph view is a hand-written canvas renderer with a Barnes-Hut force layout.

Full project documentation lives in [`../docs/DOCUMENTATION.md`](../docs/DOCUMENTATION.md).

It consumes the backend in `../backend` exactly as it is: no endpoint, field or action exists here that the API
does not provide.

## Run it

```bash
# 1. backend (from ../backend): database, seed, API on :8000
docker compose up -d && cp .env.example .env && python -m app.seed
uvicorn app.main:app --port 8000

# 2. frontend (from this folder)
npm install
npm run dev          # http://localhost:5173
```

The backend only answers browsers from the origins in its `CORS_ORIGINS` (default `http://localhost:3000` and
`http://localhost:5173`). `npm run dev` is pinned to 5173 and `npm run preview` to 3000 for that reason. To serve
the frontend from somewhere else, add that origin to `CORS_ORIGINS` in the backend `.env`.

To point at a different API, copy `.env.example` to `.env` and set `VITE_API_BASE_URL`.

If the backend has `API_KEY` set, the app opens an "API key" dialog on the first 401 (or use the key icon in the
top bar). The key is sent as `X-API-Key`, and kept in `sessionStorage` for that tab only.

`npm run build` produces a static `dist/` folder. Routing is hash-based (`#/alerts/ALT-00001`), so it works on any
static host with no rewrite rules.

## Screens and the endpoints behind them

| Screen | What it does | Endpoints |
|---|---|---|
| Dashboard | Active alerts, account risk spectrum, totals, recent alerts, open alerts by pattern, highest-risk accounts | `GET /dashboard/summary`, `GET /alerts?limit=1000`, `GET /accounts?page_size=6` |
| Alerts | Filter by severity, status, pattern, entity ID; paged with `limit`/`offset` | `GET /alerts` |
| Alert detail | Explanation (rule-based or Gemini-worded), related transactions, connected entities, analyst feedback, open a case | `GET /alerts/{id}`, `PATCH /alerts/{id}/feedback`, `POST /cases`, `GET /cases`, `GET /transactions/{id}` |
| Accounts | Search (ID, name, phone), risk level, city; paged | `GET /accounts` |
| Account detail | Risk score, ML and anomaly scores, patterns, explanation, profile, alerts, recent transactions, devices, counterparties, **network graph** (1 to 3 hops) | `GET /accounts/{id}`, `GET /accounts/{id}/network`, `GET /alerts?entity_id=` |
| Transactions | Every filter the API supports; row opens a detail drawer | `GET /transactions`, `GET /transactions/{id}` |
| Cases | List by status, edit status and notes | `GET /cases`, `GET /cases/{id}`, `PATCH /cases/{id}` |
| Top bar | API and database health pill, account search | `GET /health` |

## Behaviour worth knowing

- **All times are UTC.** The API returns naive UTC timestamps; the UI pins them to UTC and labels them, and the
  transaction date filters are interpreted as UTC.
- **Feedback moves the alert status** (genuine fraud sets it to confirmed, false positive to false positive,
  suspicious and under investigation to investigating). Each button says which status it will set. Changing a case's
  status also updates its alert. Only one open case per alert; the 409 is shown with a link to the existing case.
- **Pattern filter.** The API matches `pattern` as a substring, so the filter offers families: "Fan-in" matches
  collectors and feeders, "Shared device" matches the device alert and its member accounts.
- **City filter.** There is no "list cities" endpoint and the filter is an exact match, so suggestions are collected
  by paging through `/accounts` once per session.
- **Device IDs** have no endpoint of their own, so a device links to the transactions made from it.
- **Large graphs.** At 2 to 3 hops an ordinary account can reach 300 to 1,000+ nodes. The layout stays fast, labels
  are hidden above 400 nodes, and a note says so. Ctrl or Cmd + scroll zooms (plain scroll stays page scroll); in full
  screen plain scroll zooms.
- Transaction **list rows have no `flagged` field** in the API; flagged status shows in the detail drawer and via the
  "Flagged by detectors" filter.

## Layout

```
src/
  api/client.js          one function per backend route, X-API-Key, error normalisation
  lib/                   router, formatting, display metadata, hooks
  components/            badges, gauges, pagination, drawer, toasts, top bar
  components/graph/      forceLayout.js (Barnes-Hut), engine.js (canvas), NetworkPanel.jsx
  pages/                 one file per screen
  styles/                tokens, base, layout, components, pages, graph
```
