# FraudGraph Backend

Graph-based fraud detection and investigation API, built for Ecobank InnovateX 2026.

## What this is

A FastAPI + PostgreSQL backend that:
1. Loads transaction data (synthetic, in `data/`) into a database
2. Builds the relationship graph between accounts, devices and transactions
3. Runs four **rule-based** graph/temporal detectors (fan-in, cycles, shared-device, rapid pass-through)
4. Adds an **ML second opinion**: a Random Forest (supervised) and an Isolation Forest (unsupervised)
5. Scores every account 0-100 (rules + ML blended; strong rule findings are never diluted) and assigns a risk band
6. Generates explainable alerts - plain-language reasons behind every flag
7. Serves all of this through a REST API the frontend consumes

**The detectors need no ML model and no API key** - they are pure graph analysis + rules, and every
alert gets a deterministic rule-based explanation. The ML layer is an add-on that contributes to the
final score and surfaces unusual accounts the rules did not catch. Gemini is an optional add-on that
only rewrites explanation *wording*; it never changes what is detected or how risk is scored.

---

## Setup

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Start PostgreSQL (needs Docker; or point DATABASE_URL at any Postgres you have)
docker compose up -d

# 3. Copy the env template (defaults already match docker-compose.yml)
cp .env.example .env

# 4. Load data + run detection + ML (drops and rebuilds all tables)
python -m app.seed

# 5. Start the API
uvicorn app.main:app --reload --port 8000
```

API docs (interactive, auto-generated): **http://localhost:8000/docs** · health check: `/health`

Verify everything on your machine: `pip install -r requirements-dev.txt && pytest`

---

## PostgreSQL

PostgreSQL is the default (`DATABASE_URL` in `.env`). Things that matter, all handled:

- **Foreign keys are enforced.** Every `device_id` used by a transaction now exists in `devices.csv`
  (the generator was fixed), and `seed.py` additionally creates a placeholder `Device` row for any
  referenced device that is missing, and stops with a clear error if a transaction references an unknown
  account. SQLite silently ignored these problems; Postgres would have rejected the inserts.
- **All-or-nothing seeding.** The whole compute pipeline runs first; only then are tables rebuilt and
  written, in one transaction. A crash never leaves a half-loaded or wiped database.
- **Hosted URLs work.** `postgres://...` / `postgresql://...` URLs (Render, Neon, Supabase, Heroku) are
  converted to the `psycopg2` driver automatically.
- **Real NULLs, text phone numbers.** NaN values become NULL (not the string `NaN`), and phone numbers keep
  their leading `0` (pandas used to read them as integers and drop it).
- Indexes exist on the columns the API filters and sorts by; list endpoints use deterministic ordering so
  paging never repeats or skips rows.

SQLite still works for a throwaway local run: `DATABASE_URL=sqlite:///./fraudgraph.db`.

---

## Accuracy - reproduce it yourself

```bash
python -m app.evaluate        # no database needed; same code path that seed.py uses
```

Results on the bundled **synthetic** dataset (504 accounts, 3,796 transactions, 93 planted fraud accounts):

| Check | Result |
|---|---|
| Fan-in collectors / feeders | 3/3 · 33/33 |
| Cycle accounts / whole rings | 17/17 · 3/3 rings |
| Shared-device accounts / devices | 25/25 · 3/3 devices |
| Rapid pass-through accounts | 15/15 |
| Rule false positives | 0 of 411 normal accounts |
| Final risk score "medium or above" | catches 93/93; 16 normal accounts also flagged (3.9%) |
| Final risk score "high or above" | catches 33/93; 1 normal account flagged (0.2%) |
| Random Forest 5-fold cross-validated AUC | 0.9998 |

**How to present these honestly (a judge may well re-run them):**

- The data is synthetic and the fraud was planted with the same patterns the detectors look for, so
  near-perfect rule recall is the *expected* result - it shows the detectors work as designed, **not**
  real-world accuracy. Normal accounts in the generator are simple (no merchants, payroll accounts or
  shared family phones beyond 2-person pairs); real data will produce more false positives.
- The 16 "medium" normal accounts are the Isolation Forest's picks: it is configured to surface its most
  unusual ~8% of accounts for review, by design, regardless of whether they are fraud.
- **The ML AUC is a pipeline demo, not evidence of real-world accuracy.** The labels come from the same
  patterns the features encode. The `ml_score` shown per account is **out-of-fold**: each account is scored
  by a model that never saw its label (planted ≈ 0.98, normal ≈ 0.01). Scoring accounts with a model trained
  on their own labels would just be memorisation.
- Two thresholds were tuned on this dataset and are in `app/config.py`: `passthrough_min_amount` (₦50,000
  materiality floor - without it, ordinary small transfers re-sent within 45 minutes were flagged) and the
  detector windows. Retune them on real data.
- Pass-through ground truth labels only the *intermediate* accounts of each chain: the first account has no
  inbound transfer and the last has no outbound one, so no pass-through rule can fire on them.

---

## Security and data privacy

- **API key (optional):** set `API_KEY` in `.env` and every `/api/v1` request must send `X-API-Key`
  (the `/docs` page has an *Authorize* button). `/health` stays open. Blank = auth off (local dev only).
- **CORS:** only the origins in `CORS_ORIGINS` may call the API from a browser - no wildcard, no credentials.
- **For a real bank deployment** you would put this behind the bank's identity provider (OAuth2/OIDC),
  add per-analyst roles, and an audit log of who changed which alert or case. Not built here.
- **Gemini and personal data:** account and device IDs are replaced with placeholders (`ACCOUNT_A`,
  `DEVICE_A`...) before anything is sent to Gemini and restored afterwards. Transaction amounts and counts
  *are* sent - they are the substance of the explanation. Gemini's reply is rejected (falling back to the
  rule-based text) if it introduces any number or identifier that was not in the facts. Leave
  `GEMINI_API_KEY` blank to send nothing at all. For production, use an in-region/enterprise model endpoint
  under the bank's data-processing agreement.
- The API key is sent in a header, not in the URL, so it does not end up in access logs.

---

## Gemini (optional)

Set in `.env`:

```
GEMINI_API_KEY=your-key-here
GEMINI_MODEL=gemini-3.5-flash
GEMINI_FALLBACK_MODEL=gemini-3.1-flash-lite
```

> `gemini-2.0-flash` (the previous default) was **shut down by Google on 1 June 2026**, so it would always
> have silently fallen back. Model IDs now retire within months - check Google's deprecation page
> (https://ai.google.dev/gemini-api/docs/deprecations) shortly before the demo. If the primary model returns
> 404, the fallback model is tried automatically.

If you don't set a key, the key is wrong, or Gemini is unreachable, nothing breaks: every alert still has a
full rule-based explanation. After 3 failures in a row Gemini is switched off for the rest of the seed run, so
a bad key or no internet cannot slow seeding down. `explanation_source` on each alert says `"rule_based"` or
`"gemini"`, and the seed script reports whether Gemini was used at all.

---

## Alert and case workflow

- Every alert's `detected_at` is the timestamp of the transaction that completed the pattern, so "recent
  alerts" are ordered by when the fraud happened (not by when the seed ran).
- `PATCH /alerts/{id}/feedback` stores the feedback **and** moves the alert's status
  (`genuine_fraud → confirmed`, `false_positive → false_positive`, `suspicious / under_investigation →
  investigating`) and persists `updated_at`.
- Opening a case sets its alert to `investigating`; changing the case status updates the alert. Together
  these make the dashboard's `active_alerts` fall as work is completed.
- Only one open case per alert (`409` otherwise). Case IDs are random (`FG-1A2B3C4D`), not `count + 1`, so
  they can't collide after a delete or under concurrent requests.
- `GET /accounts/{id}` merges the explanations of **all** of that account's alerts.

---

## Scaling: "what happens at millions of transactions?"

Be straightforward: this is a **batch** pipeline that holds the transaction table in memory and recomputes
everything in `python -m app.seed`; the API only reads precomputed results, so API latency does not depend on
data size. The detectors and feature extraction are linear-time per account (sliding windows, bisect lookups)
and skip groups that cannot possibly qualify. Measured on random synthetic data in a modest sandbox
(rule detectors + feature extraction, before ML training): **~100k transactions ≈ 11s + 6s, ~300k ≈ 34s + 18s**,
i.e. roughly linear. That is fine for a nightly batch at this scale, but it will not reach millions in one
in-memory run. The path from here is:

1. Incremental runs on a rolling window of recent transactions instead of a full rebuild.
2. Push the windowed aggregations (fan-in, pass-through) into SQL window functions or Spark/Polars.
3. Cycle search is the only super-linear step; it is already bounded (length ≤ 6, amount floor, 24-hour span)
   and can be sharded by connected component or moved to a graph database/engine.
4. Stream new transactions through the same rules for near-real-time alerts (currently *not* built).
5. Page the alert/network endpoints (alerts already accept `limit`/`offset`).

---

## Project structure

```
app/
  config.py          # settings - DB URL, API key, CORS, Gemini, detection thresholds
  database.py        # SQLAlchemy engine/session (Postgres-first, URL normalisation)
  models.py          # ORM tables: Account, Device, Transaction, Alert, Case
  schemas.py         # Pydantic request/response shapes
  security.py        # optional X-API-Key auth
  detection.py       # four rule detectors + hybrid risk scoring
  features.py        # 26 behavioural & topological features per account (shares helpers with detection)
  ml.py              # Random Forest (out-of-fold scoring) + Isolation Forest
  pipeline.py        # the whole compute pipeline, no database needed
  explain.py         # rule-based explanations + optional privacy-masked Gemini polish
  graph_utils.py     # node/edge graph for the network view (never returns dangling edges)
  seed.py            # CSVs -> pipeline -> PostgreSQL (one transaction)
  evaluate.py        # reproducible accuracy numbers: python -m app.evaluate
  main.py            # FastAPI app
  routers/           # dashboard, accounts, transactions, alerts, cases
data/                # accounts.csv, devices.csv, transactions.csv, ground_truth.csv
tests/               # pytest suite (detectors, pipeline numbers, Gemini guard rails, API smoke tests)
generate_data.py     # deterministic synthetic data generator (no third-party deps)
docker-compose.yml   # local PostgreSQL
```

## Regenerating data / retuning

`python generate_data.py` rewrites `data/*.csv` deterministically (seeded - identical output every run).
After changing thresholds in `app/config.py` or regenerating data, run `python -m app.evaluate` to see the new
numbers, then `python -m app.seed` to reload the database (this wipes any cases or feedback created while testing).

## What's NOT built (by design)

- Live transaction streaming (this batch-processes a static dataset)
- Real bank system integration; bank-grade authentication/authorisation and audit logging
- Model retraining from alert feedback (feedback is captured and now drives alert status, but is not looped
  back into scoring yet)
- Historical trend analytics beyond the dashboard summary
