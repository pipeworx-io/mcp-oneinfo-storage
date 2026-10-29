# @pipeworx/oneinfo-storage

Italian regulated company disclosures direct from **1INFO** — a document
index (title, issuer, category, timestamp, document link), updated same-day,
covering the ~314 issuers that use 1INFO instead of eMarket Storage as their
Officially Appointed Mechanism (OAM) for EU Transparency Directive filings.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `oneinfo_search_disclosures(company?, ndg?, category?, date_from?, date_to?, limit?, offset?)`
  — search disclosures by issuer (name, resolved against 1INFO's own
  314-issuer list, or a known `ndg`), category, and/or a publication date
  window. Returns newest first.
- `oneinfo_get_disclosure(id, date)` — fetch one disclosure by its
  protocolCode and publication date (both come from a prior search — this
  source has no by-id-only lookup).

## Why this pack exists — and why it's separate from `emarket-storage`

Italy has TWO Officially Appointed Mechanisms for Transparency Directive
disclosures: eMarket Storage (Teleborsa) and 1INFO. An issuer discloses
through exactly one of the two — **there is no overlap**, so neither pack can
be dropped in favor of the other. Confirmed live 2026-09-24: 1INFO's own
314-issuer list includes IREN and SOMEC, both absent from eMarket Storage's
picklist; roughly half of STAR-segment issuers use 1INFO. **If a company
isn't found here, try `emarket-storage`'s `emarket_search_disclosures`
instead** (and vice versa — `emarket-storage`'s not-found note points back
here).

## One call per day, not one call per issuer

`company`/`ndg` are optional on `oneinfo_search_disclosures`. Omit them and
pass only `date_from`/`date_to` (and optionally `category`) to get every
1INFO issuer's disclosures for that window in ONE call — verified live
2026-10-19. A design partner doing a daily check across ~155 issuers across
all three ESEF-regulator packs was instead calling once per issuer and
exhausting a 50-credit-per-call allowance in ~35 calls (fleet #3300); the
date-window call (with no `ndg` to filter on, every row the scan finds is a
match) is the cheap way to do that check.

## ⚠️ Six things a caller must know

1. **1INFO-covered issuers only — not the full Italian market.** A company
   search that matches nothing returns an explanatory `note`, not a bare
   error, pointing at `emarket-storage` instead. This pack does not merge
   eMarket Storage data.
2. **This is a document index, not an XBRL-facts API.** Every row is a
   disclosure EVENT: a title, an issuer, a category, a publication timestamp,
   and a link to the underlying document. There is no per-fact extraction.
   For XBRL facts (net income, revenue…) from Italian ANNUAL reports, use
   `esef-filings` (proxies filings.xbrl.org) — measured 2026-09-24: annual
   filings from 1INFO issuers (SOMEC, IREN, Softlab) reached filings.xbrl.org
   about **6 days** after they were stored here. **There is no XBRL-facts
   source anywhere for HALF-YEAR reports** (ESEF is annual-only by
   construction), so this pack is the only structured way to see those land.
3. **No ISIN.** LEI appears only embedded in the filename of XBRL-tagged
   annual-report ZIPs (`has_xbrl: true` rows — e.g.
   `81560001692D0424C949-2025-12-31-1-it.html` inside SOMEC's FY2025 ZIP).
   Identify issuers by name (resolved against 1INFO's own list) or by `ndg`
   (1INFO's internal numeric id) directly once you have it from a prior
   search.
4. **`date_to` is INCLUSIVE** (the last local-calendar day you want,
   Europe/Rome). Unlike `emarket-storage`, this pack filters dates itself
   client-side rather than passing a range upstream, so there's no
   exclusive-upstream-bound trap to work around — verified live 2026-09-24:
   `date_from=2026-09-22&date_to=2026-09-22` returns the one disclosure
   actually published that day (UNIDATA), proving the last day is included.
5. **No server-side filter by issuer exists on this source.** Verified live
   2026-09-24: 1INFO's `/API/Documenti` endpoint honors `SearchFilter[categoria]`
   (it genuinely narrows the result set) but silently IGNORES both
   `SearchFilter[ndg]` and the DataTables global `search[value]` —
   `recordsFiltered` is identical with or without them. This pack resolves a
   company to `ndg` and filters CLIENT-SIDE while paging the (always
   storage-date-descending) result set. A `date_from`/`date_to` window is
   scanned to completion (bounded to 6 upstream requests / ~6,000 rows as a
   safety cap); an open-ended company-only search stops as soon as it has
   `limit` matches, which is cheap but may miss an issuer's older filings.
   Every response says honestly how far it scanned
   (`scanned.oldest_date_local`, `scanned.stopped_reason`) and whether
   `matched_in_scanned_range` is an exact count for the range
   (`range_fully_scanned: true`) or only a lower bound — never a fabricated
   total.
6. **`fiscal_year` is now derived from the DOCUMENT, not the deposit date —
   `fiscal_year_source` says which rule produced it.** `dataEsercizio` (the
   field the old `fiscal_year` was computed from) is a genuine
   fiscal-period-end date ONLY on XBRL-tagged rows; on every other row (most
   of them) 1INFO sets it EQUAL to the deposit timestamp. Verified live
   2026-10-19 on Eurotech/ndg=789: the FY2024 ESEF ZIP correctly has
   `dataEsercizio` = 2024-12-31, while its sibling FY2024 PDF (deposited
   2025-04-01) had `dataEsercizio` = `dataStoccaggio` = 2025-04-01 — the old
   code reported `fiscal_year: "2025"` for a document whose own title says
   "...annuale 2024...". This pack now reads the year stated in the title for
   non-XBRL rows. `fiscal_year_source` is one of `xbrl_metadata` (trusted
   `dataEsercizio`), `title` (extracted from the document's own title text),
   or `deposit_date_fallback` (no usable year in the title — still the old
   deposit-date value, never a fabricated one). The `document_url`'s own
   `year` query parameter is UNCHANGED by this fix — see the Gotchas section,
   it still needs the raw `dataEsercizio` value or the download 302s.

## Auth

Keyless. No account, no API key.

## Data sources

- <https://www.1info.it/PORTALE1INFO/> — 1INFO's public disclosure storage
  portal (an EU Transparency Directive OAM for Italy). Pipeworx queries its
  JSON API live on every call; there is no bulk download.

## Gotchas

- **No formal REST API — this is a DataTables server-side endpoint.**
  `POST /PORTALE1INFO/API/Documenti` requires the standard DataTables form
  fields (`draw`, `columns[0][...]`, `order[0][...]`, `start`, `length`); a
  bare POST missing them fails with a server-side `NullReferenceException`.
  `GET /PORTALE1INFO/API/companies/documenti` (314 issuers) and
  `GET /PORTALE1INFO/API/documenti/Categories` are plain GETs.
- **The download URL needs a `.pdf` suffix 1INFO's own JSON does not show —
  a silent-404-shaped trap.** `PdfShow.aspx` takes a `file` (the document
  code) and a `year` (the fiscal year) query parameter. When a row has an XBRL package
  (`protocolCodeXbrl` non-null, e.g. `"165960_oneinfo.zip"`), that value
  downloads as-is. But when `protocolCodeXbrl` is null — every half-year
  report, every ancillary filing, i.e. most rows — using the bare
  `protocolCode` (e.g. `"171904_oneinfo"`) 302-redirects to
  `Error.aspx …documento non trovato` with no indication of what went wrong.
  Appending `.pdf` (`"171904_oneinfo.pdf"`) is what actually resolves —
  confirmed live 2026-09-24 on three different issuers/categories (UNIDATA
  REGEM, Banca Sistema 3.1, SOMEC 1.2), each 302 without the suffix and
  HTTP 200 with it.
- **The download URL's `year` and the reported `fiscal_year` are now
  DIFFERENT things, on purpose.** `year` in `document_url` must be
  `romeYearLocal(dataEsercizio)` EXACTLY — it is a resolver key `PdfShow.aspx`
  itself checks, confirmed live 2026-10-19 on Eurotech's FY2024 PDF
  (protocolCode `152498_oneinfo`): `year=2025` (its own `dataEsercizio`)
  resolves a 6.2MB PDF, `year=2024` or any other value 302s to an error page.
  `fiscal_year` (the metadata field) is the corrected, document-derived value
  — see "Six things a caller must know" above. Two sibling filings stored the
  same day for the same report can still need different `year` values in
  their URLs (SOMEC's FY2025 ESEF ZIP and plain-PDF twin, stored 2 minutes
  apart, needed `year=2025` and `year=2026` respectively) — that part of the
  original finding is unchanged; only what gets REPORTED as `fiscal_year`
  changed.
- **Company-name resolution** uses `rankMatches` (exact > prefix > whole-word
  > substring) against 1INFO's own issuer picklist, embedded at
  `/API/companies/documenti`. An ambiguous match (multiple issuers tied at
  the same score) returns `candidates` instead of guessing.
- **The `categoria` filter accepts multi-value rows** — a single disclosure
  can carry more than one code (e.g. `"1.2,2.2"`); `category_labels` reflects
  every code on the row, while filtering by `category` matches on membership,
  not exact equality.
- Dates are computed in Europe/Rome via `Intl.DateTimeFormat` (DST-correct)
  rather than manual UTC offsets — `dataStoccaggio`/`dataEsercizio` are raw
  Unix-seconds timestamps with no timezone marker in the source JSON.
- `oneinfo_get_disclosure` has no direct by-id endpoint on the source — it
  re-scans that day's listing (up to 3 requests / 3,000 rows, far more than
  any single day's market-wide volume — 33,444 rows measured over roughly 5
  years) and matches on `protocolCode`.
- **Each Documenti page fetch (search or lookup) gets a 15s timeout**, not
  the shared 25s default. A single page genuinely takes longer than
  eMarket's HTML listing — measured live 2026-10-19, ~3.1s typical — and the
  search/lookup loops are sequential, so the old 25s default bounded a
  6-request search to a 150s worst case. A design partner reported ~230s
  stalls in production (fleet #3300) that line up with that order of
  magnitude; 15s is ~5x the measured normal latency while capping the new
  worst case at 90s (search) / 45s (by-id lookup).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "oneinfo-storage": {
      "url": "https://gateway.pipeworx.io/oneinfo-storage/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/oneinfo-storage/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/oneinfo_search_disclosures \
  -H 'Content-Type: application/json' \
  -d '{"date_from":"2026-09-17","date_to":"2026-09-24"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/oneinfo_search_disclosures`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-oneinfo-storage` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/oneinfo-storage/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "oneinfo-storage": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-oneinfo-storage"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Oneinfo Storage data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
