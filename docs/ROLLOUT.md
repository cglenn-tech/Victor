# Deploy and verify this repair

The code and automated tests can be completed without production keys. This procedure is for the owner once access is available; no secrets belong in GitHub or a pull-request comment.

## Deployment order

1. Back up the existing Supabase database using your normal backup process. Apply the current `supabase/migrations/020_reliable_agent_flow.sql` in the SQL editor. It adds missing episode ownership fields, observations and weekly reports and can be rerun. If the earlier script failed because `public.observations` or `user_id` did not exist, replace the entire query with this corrected file. Check that all statements complete successfully.
2. Configure the server variables listed in README. The existing Realtime token code uses the project's HS256 JWT secret; an asymmetric-only Supabase project needs a separate signing integration.
3. Deploy the matching web commit. The build itself does not require secrets, but activation, login, sync and analysis do.
4. Download the Mac workflow artifact from the pull request, or rebuild the desktop from this same commit using the macOS/Windows build workflows. The Mac workflow now starts the packaged executable and checks encrypted storage before publishing the artifact. The workflow defaults and minimum desktop version are now **1.1.0**; rebuild and reinstall that version (or newer). Do not assume the previously downloaded DMG contains these fixes.
5. Keep old pilot accounts and their existing server records. Unowned local records are deliberately left out of automatic uploads; inspect them locally and recover manually if their owner is known.

## First live check — fictional data only

Use a test account and fictional documents for Client Alpha and Client Beta.

1. Launch the app and finish activation. Confirm it appears on the dashboard as connected and **idle**. Approve a test document window for capture.
2. Click Start on the dashboard. Edit an Alpha document, then a Beta document in the same application. Stop. Confirm both matters remain separate and their observations arrive automatically on `/observations`.
3. Edit one observation; confirm it is now unapproved. Approve it. Delete another. Rename a client/matter and correct its minutes on the dashboard.
4. Generate a report for today in the browser's local time zone. It must use the corrected text and active/edited minutes, exclude deleted work, and block generation if any included work still needs approval.
5. Download the report through My Files, reopen it, and compare its totals with the displayed report. Administrative work must have a separate subtotal.
6. Temporarily block upload access, then restore it. Previously analyzed records should retry automatically without duplicate records or reverted edits. Unanalyzed screenshot batches are temporary and eventually discarded after failed attempts; the dashboard must show the analysis error.
7. Sign out during a session. Capture must stop at the next session check, normally within five seconds. Sign in to a second test account: it must not see or receive the first account's local queue. Account switching requires reconnecting the desktop to the intended account.
8. Restart the desktop; it must stay paused until a fresh Start command. Close every Victor page during a session; capture must stop after the ten-minute lease expires. Lock/sleep the computer and confirm capture stops; The Mac agent reconnects paused after waking; start a new session after unlocking. On Windows, reopen the app after unlocking. Quit while an analysis is finishing and reopen; completed observations must still be present.

## What remains an estimate

Screen changes cannot establish billable time or prove an email was sent or a filing accepted. The lawyer reviews observation text and time. Report intervals that cross a date-range boundary allocate active time proportionally and say so in the export. Grouping uses an explicit visible matter identifier; ambiguous work stays separate until the user assigns it. Model output quality must be measured with your actual endpoint and practice workflow.

The application sends screenshots transiently to Victor's backend and then the configured model endpoint. It does not upload screenshots to a Supabase storage bucket. Confirm host/model logging and retention settings before using client material.

## Automated checks without production keys

`npm test` covers the web data contract, approval/report rules and actual SQL sync functions in an isolated Postgres-compatible database. `python -m unittest discover -s agent/tests -p test_connected_flow.py -v` covers 15 agent regressions, including offline startup recovery, atomic parent/observation saves, account isolation, pause accounting, batch recovery and graceful shutdown.

The Mac pull-request workflow builds a DMG and runs `Victor --self-test` against the actual packaged executable. This imports the capture/consent/runtime dependencies and saves and reopens fictional observations in an encrypted temporary database with an ephemeral key. It does not test screen recording permission, real account activation, model quality or a production deployment.

The migration regression tests also run against historical schemas with no observations table, the original 018 table, and the structured 019 table. Each scenario applies 020 twice, preserves existing matters and observations, exercises ingestion and merging, and checks access from a different account.

The deployed-schema regression reconstructs the public table/column/type export supplied on September 25, including episodes without user/device ownership and absent observations/reports. It asserts an exact match before applying 020, verifies old unowned rows are preserved and hidden, syncs new work, edits/approves observations, builds and saves a report through the actual report builder, reruns the migration, and checks that a second account cannot read those records. Constraints and policies are based on repository history and explicit legacy-policy scenarios; the export did not include live constraint/policy definitions.
