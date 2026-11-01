# Data retention — how section 8 of the Privacy Policy is actually enforced

**Status: implemented 2026-11-01.** Before that date the policy promised that personal data was
eventually "deleted or anonymised" and *nothing did it* — no TTL or expiry column on `Ticket`,
`ScanLog`, `WebhookLog`, `ChainAction` or `Organizer`, no purge in root's crontab, no systemd timer.
(The policy text had been made honest on 2026-10-31 — it said outright that deletion was not
automated. This replaces that admission with the periods below.)

| | |
|---|---|
| job | `backend/scripts/retention.js` |
| schedule | `gembaticket-retention.timer` → **05:20 UTC daily** (`ops/retention/`) |
| default mode | **dry run** — prints what it *would* do and writes nothing |
| apply mode | `--apply` (only the systemd unit passes it) |
| audit | tables `RetentionRun` + `RetentionItem` (migration `20261101_retention_audit`) |
| policy version | `2026-11-01` (recorded on every run) |
| tests | `tests/retention-e2e.js` (76 assertions), `tests/retention-canaries.js` (3 guards) |

```bash
# inspect before trusting it — this is the default, it writes nothing
cd /gembaticket.com/backend && node scripts/retention.js

# what the timer does
systemctl start gembaticket-retention.service
journalctl -u gembaticket-retention -n 30
```

## The rule that decides delete vs anonymise

> Does the row still have operational or accounting value once the person is removed from it?
> If yes it is **anonymised**; if no it is **deleted**.

A ticket is a sales record: `pricePaid`, `discountAmount`, `paymentId` and `refundId` are the money
trail, and Закон за счетоводството чл. 12 wants that for ten years — but the buyer's e-mail and
wallet are no part of it. So the money stays and the person goes. A scan log, by contrast, is "who
walked in when": no accounting value at all, so it is deleted outright.

**Anonymisation is a constant, not a hash.** `buyerEmail` becomes the literal `anonymised@invalid`.
A sha256 of an e-mail address is *not* anonymisation — the space of real addresses is small enough to
reverse by dictionary, so a hash would still be personal data under the GDPR.

## The periods

| rule | table | action | period | measured from |
|---|---|---|---|---|
| `ticket.anonymise` | `Ticket` | anonymise | 12 months | **the event's end**, not the purchase |
| `scanlog.delete` | `ScanLog` | delete | 180 days | row age, *and* the event must be over |
| `webhooklog.delete` | `WebhookLog` | delete | 90 days | row age (processed, no error) |
| `webhooklog.anonymise` | `WebhookLog` | anonymise payload | 12 months | row age (unresolved or errored) |
| `chainjob.delete` | `ChainJob` | delete | 90 days | row age (terminal only) |
| `notification.delete` | `Notification` | delete | 180 days | row age |
| `scannersession.delete` | `ScannerSession` | delete | 90 days | revoked-at, else last-used |
| `organizer.delete` | `Organizer` | delete | 90 days | created-at (unverified, unused only) |
| `chainaction.delete` | `ChainAction` | delete | 10 years | row age (accounting record) |

What a ticket loses: `buyerEmail` (→ constant), `buyerWallet`, `claimedWallet`, `buyerLocale`, and
every live credential — `claimCode`, `claimHash`, `viewToken`, `qrSeed`, `qrDeviceId`,
`qrDeviceBoundAt`. After the event those credentials are pure risk; nothing reads them.
What it keeps: `status`, `pricePaid`, `discountAmount`, `paymentId`, `paymentHash`, `refundId`,
`refundStatus`, `refundedAt`, `tokenId`, `txHash`, `createdAt`, `eventId`.

## The guards — rows the job must never touch

The periods are the easy half. These are the reasons a row that is "old enough" is still skipped:

- **"Already-started period" is measured from the event, not the row.** A ticket's clock starts when
  the event is *over*: `COALESCE(endedAt, canceledAt, endDate, eventDate)`. A ticket bought three
  years ago for an event next month is a **live ticket** and is never touched. If all four columns
  are null the event has no known end and nothing belonging to it is ever touched.
- **A scan log for an unfinished event is load-bearing.** It is what stops a ticket being used
  twice; deleting it for a season pass or a multi-day festival would re-open re-entry. Only logs
  whose event is over are deleted. A log with no ticket (a QR that matched nothing) belongs to no
  event and goes on age alone.
- **Open money is never anonymised.** `refundStatus` in `pending | processing | manual` keeps the
  buyer — we may still have to pay them or write to them.
- **Open chain work is never anonymised.** A `ChainJob` in `pending | running`, or a `ChainAction` on
  the same event in `AWAITING_PAYMENT | PAID | SUBMITTED | REVERTED | FAILED`, holds the ticket.
- **In-flight purchases are skipped**: `PENDING_PAYMENT`, `MINTING`.
- **An errored or unprocessed webhook is never deleted** — an operator still has to see it. It is
  anonymised at 12 months instead, keeping which keys were present but not their values.

## Two brakes, because the clock is the dangerous input

Every cutoff is "now minus N days", so a wrong system clock is the one failure that could empty the
database.

1. The process clock is compared against the **database** clock; more than a day of skew aborts the
   run before any cutoff is computed.
2. Any single rule matching more than **5000 rows** refuses to apply without `--force`.

## Failing loudly

The job prints `RETENTION FAILED on <host>: <reason>` on **stderr** (so it lands in the journal),
e-mails `alerts@gembamail.com` through the backend's SMTP settings — the same transport
`gembaticket-backup.sh` uses — and **exits non-zero**, which systemd records as a failed unit.
Nothing is chained with `&&`. The audit row for a failed run is updated with `ok = false` and the
reason, so a failure is visible in the data as well as in the journal.

## 🔴 The systemd unit must use `After=`, never `Requires=postgresql.service`

On Debian/Ubuntu `postgresql.service` is a `Type=oneshot` + `RemainAfterExit=on` wrapper whose
`ExecStart` is `/bin/true`; the real cluster is `postgresql@16-main.service`, which declares
`PartOf=postgresql.service`. A `Requires=` on the wrapper enqueues a start job on an
already-exited oneshot, systemd re-runs it, `PartOf=` propagates a **stop** to the cluster, and
`/bin/true` never brings it back. This took the whole shared cluster down for about six minutes on
2026-11-01 (GembaTicket, GembaPay, GembaKitchen and GembaPass all share it). `After=` only — which
is what `gembakitchen-reminders.service` already did.

## The audit trail

`RetentionRun` is one row per run — `startedAt`, `finishedAt`, `dryRun`, `ok`, `error`, `host`,
`policyVersion`. `RetentionItem` is one row per rule per run — `rule`, `tableName`, `action`,
`cutoff`, `matched`, `applied`. On a dry run `applied` is always 0 while `matched` still reports the
work, which is how "the job refused to write" is distinguished from "there was nothing to do".
These rows hold **counts only**, never personal data, and are themselves never purged.

```sql
SELECT r."startedAt", r."dryRun", r.ok, i.rule, i.matched, i.applied
  FROM "RetentionRun" r JOIN "RetentionItem" i ON i."runId" = r.id
 ORDER BY r."startedAt" DESC, i.rule;
```

First real sweep, 2026-11-01 07:02:22 UTC (`RetentionRun 11ea382d`): 143 webhook logs and 30 chain
jobs deleted, 2 scan logs deleted, 0 tickets anonymised (no event has yet ended 12 months ago).

## Deliberately NOT done

- **Confirmed accounts are never auto-deleted.** There is no `lastLoginAt` column, so "dormant"
  cannot be measured; `updatedAt` would read a live account that simply never changed a field as
  dormant and delete it. Deletion stays on request (policy section 9). Adding `lastLoginAt` and then
  a dormancy rule is the obvious next step and would need its own policy wording.
- **`Event`, `TicketType`, `Zone`, `DiscountCode`, `ScannerDevice`** are an organizer's business
  records, not attendee personal data, and are kept while the account is active.
- **On-chain records and IPFS pins cannot be deleted at all**, by design — section 3 of the policy
  says so and that has not changed.

## Note on the legal-text pipeline

`ops/legal-i18n/build.py` generates the three legal pages from the English JSX plus the approved flat
translations in `~/Documents/Claude/GembaTicket-translations/`. Section 8 of `Privacy.jsx` has
already diverged from `privacy.{bg,es}.md` (the 2026-10-31 honesty edit changed the JSX only), and
this change extends that divergence: the new §8 is **4 paragraphs + 1 list of 8 items in each of
EN/BG/ES**, edited directly in the JSX with structural parity verified per language. The approved
translation archive still holds the original single-paragraph §8 and was left as approved; re-running
`build.py` would not reproduce the current §8.
