# @pipeworx/oneinfo-storage

Italian regulated company disclosures direct from **1INFO** — a document
index (title, issuer, category, timestamp, document link), updated same-day,
covering the ~314 issuers that use 1INFO instead of eMarket Storage as their
Officially Appointed Mechanism (OAM) for EU Transparency Directive filings.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1807+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

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

## ⚠️ Five things a caller must know

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
- **`year` is the FISCAL year from `dataEsercizio`, not the storage year**
  — and it can differ between two filings stored on the very same day for
  the very same report: SOMEC's FY2025 annual report was stored as two
  sibling rows (the ESEF-format ZIP and a plain-PDF twin) 2 minutes apart,
  with `year=2025` for one and `year=2026` for the other — both confirmed
  live to need exactly their own computed year, not the other's.
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

Both URLs reach the same gateway and the same 1807+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/oneinfo_search_disclosures \
  -H 'Content-Type: application/json' \
  -d '{"date_from":"2026-09-17","date_to":"2026-09-24"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/oneinfo_search_disclosures`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

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

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-oneinfo-storage
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

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
