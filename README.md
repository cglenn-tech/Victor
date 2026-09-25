# VICTOR

Victor turns explicitly started desktop work sessions into editable observations, client/matter time estimates, and saved work reports for a solo practice. Users approve the observations before generating a report. Recorded time is an estimate, not an automatic billing decision.

## Data flow

1. Sign in on the website and link the desktop installation through activation.
2. Click **Start**. The desktop checks the signed-in session and per-window capture permission before collecting screenshots.
3. Small screenshot batches travel over HTTPS to Victor's authenticated `/api/agent/analyze` endpoint. The server calls your configured self-hosted vision model. Model credentials stay on the server.
4. The desktop deletes processed screenshots and saves structured observations and parent work records in an account-specific local database. Production builds require database encryption; no plaintext fallback is introduced.
5. A durable worker uploads parent records before observations through device-authenticated APIs. Supabase stores text and time estimates, not screenshot files. Upload retries preserve user edits, approvals, and deletions.
6. Review the daily observations, correct client/matter names and time estimates on the dashboard, and approve the observation text. Reports use those approved records and calculate totals without another model call. Saved reports can be downloaded from **My Files**.

Sign out stops the server session; the agent checks it at least once per capture cycle (normally every five seconds). Network failure pauses capture. Closing all Victor pages expires permission after ten minutes. Restarting the desktop starts paused. The desktop menu's Start command opens the dashboard.

## Web development

```bash
npm ci
npm run dev
```

Set these in `.env.local` for development or in the hosting provider's server environment. Never commit actual values:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser's public Supabase key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only database access |
| `SUPABASE_JWT_SECRET` | Server-only Realtime token signing secret for the existing HS256 setup |
| `SELF_HOSTED_MODEL_URL` | Your HTTPS model base URL, ending before `/chat/completions` |
| `SELF_HOSTED_MODEL_NAME` | Model identifier served by that endpoint |
| `SELF_HOSTED_API_KEY` | Server-only model endpoint key |

Use a model that accepts multiple `image_url` JPEG data URLs through the OpenAI-compatible chat-completions format. The endpoint must return `choices[0].message.content`. Requests are capped below 3.8 MB; screenshot batches are transient application data. Retention and logging at the hosting/model provider must be configured separately; self-hosting does not by itself guarantee confidentiality.

## Existing Supabase installation

Apply `supabase/migrations/020_reliable_agent_flow.sql` after the existing migrations through 019, **before deploying this web and desktop update**. It adds missing device ownership, deletion tombstones, ingestion revisions, session state and transactional ingestion/merge functions. No existing work records are deleted.

The early migrations contain historical schema resets. Do not rerun them on an existing database. There are also duplicate historical 018/019 version prefixes; apply the forward SQL through the Supabase SQL editor if the CLI's migration ledger does not match those filenames.

## Desktop development

The desktop needs a linked device token, stored in the OS credential manager. It does **not** need a Supabase service key or model endpoint key.

For macOS:

```bash
cd agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

For Windows, use `agent/requirements_windows.txt` and `python app_windows.py` in a virtual environment. Development can point `BUILDHARVEY_BASE_URL` at your own web deployment. Launching `main.py` alone requires an already-linked account.

New local databases live under `~/.buildharvey/accounts/<account-hash>/victor.db` (the equivalent home directory on Windows). The old unowned `buildharvey.db` is left intact and is **not** automatically uploaded into whichever account next signs in. Already-synced server records remain available.

After deployment, rebuild and reinstall the desktop app: changing the website does not update an already-downloaded executable. See `docs/ROLLOUT.md` for the live acceptance steps.

## Tests without keys

```bash
npm ci
npm test
npx tsc --noEmit
npm run build
python -m pip install Pillow
python -m unittest discover -s agent/tests -p test_connected_flow.py -v
```

Web tests include real PostgreSQL execution of migration 020 in PGlite. Desktop regression tests use the real SQLite, batching, grouping and retry code with fake OS capture, fake credentials and fake HTTP. They never call a live model, Supabase project or lawyer's account. Native OS permissions, packaged apps, and the actual self-hosted endpoint still require the live checks below.
