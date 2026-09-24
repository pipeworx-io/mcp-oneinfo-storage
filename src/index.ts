interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


// Reusable entity-resolution helpers for MCP packs. SELF-CONTAINED — no internal
// imports — so publish-pack.sh can inline it into standalone pack builds the same
// way it inlines the McpToolExport type.
//
// Recurring failure mode across financial packs: callers pass a company NAME
// ("Apple", "apple inc") where a ticker / CIK / provider symbol is expected, and
// the pack 404s or throws "not found". `rankMatches` is a generic name-ranker any
// pack can run over its OWN list (US tickers, B3 tickers, drug names, airports…);
// `resolveSecEntity` wraps it around the SEC company_tickers.json universe, shared
// by the packs that key on CIK (edgar, sec).

type MatchKind = 'exact' | 'prefix' | 'word' | 'substring';

interface RankedMatch<T> {
  item: T;
  kind: MatchKind;
  score: number;
}

const normalize = (s: string): string =>
  s.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rank `items` by how well their name matches `query`:
 * exact (4) > prefix (3) > whole-word (2) > substring (1). Ties break by shortest
 * name — the primary entity (e.g. "Apple Inc." over "Apple Hospitality REIT").
 * Returns only items that match at all, best first. Pure (no I/O).
 */
function rankMatches<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
): RankedMatch<T>[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { item: T; kind: MatchKind; score: number; len: number }[] = [];
  for (const item of items) {
    const name = getName(item);
    const n = normalize(name);
    let kind: MatchKind | null = null;
    let score = 0;
    if (n === q) { kind = 'exact'; score = 4; }
    else if (n.startsWith(q)) { kind = 'prefix'; score = 3; }
    else if (n.includes(` ${q} `) || n.endsWith(` ${q}`)) { kind = 'word'; score = 2; }
    else if (n.includes(q)) { kind = 'substring'; score = 1; }
    if (kind) scored.push({ item, kind, score, len: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.map(({ item, kind, score }) => ({ item, kind, score }));
}

interface SecTickerRow { cik_str: number; ticker: string; title: string }

interface SecEntity {
  ticker: string;
  cik: string;
  cik_padded: string;
  company_name: string;
  matched_by: 'ticker' | 'company_name';
  alternatives?: { ticker: string; company_name: string; cik: string }[];
}

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/**
 * Resolve a ticker OR company name to its SEC identity (CIK + canonical name).
 * Exact ticker first (the common, unambiguous case), then fuzzy company-name
 * fallback so "Apple" / "APPLE" → AAPL's CIK. Throws if nothing matches.
 *
 * `headers` lets callers pass their pack's SEC User-Agent — www.sec.gov requires
 * a UA. `fetchImpl` defaults to global fetch (override in tests).
 */
async function resolveSecEntity(
  query: string,
  opts: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<SecEntity> {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Required argument is missing or empty. Pass a ticker like "AAPL" or a company name like "Apple".');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(SEC_TICKERS_URL, { headers: opts.headers });
  if (!res.ok) throw new Error(`SEC ticker lookup error: ${res.status}`);
  const data = (await res.json()) as Record<string, SecTickerRow>;
  const rows = Object.values(data);

  // 1) Exact ticker match — the common, unambiguous case.
  const q = query.toUpperCase().trim();
  for (const r of rows) {
    if (r.ticker === q) return toEntity(r, 'ticker');
  }

  // 2) Company-name fallback.
  const ranked = rankMatches(query, rows, (r) => r.title);
  if (ranked.length) {
    const best = toEntity(ranked[0].item, 'company_name');
    const alts = ranked.slice(1, 4).map((m) => ({
      ticker: m.item.ticker,
      company_name: m.item.title,
      cik: String(m.item.cik_str),
    }));
    if (alts.length) best.alternatives = alts;
    return best;
  }

  throw new Error(`No SEC company matches "${query}". Pass a US-listed ticker ("AAPL") or the exact listed-company name ("Apple Inc."). If this is a clinical-trial sponsor, an operating subsidiary (e.g. "Merck Sharp & Dohme" → Merck & Co), or a foreign/private entity, call sponsor_to_filer({sponsor}) instead — it resolves subsidiaries to the listed parent and honestly reports when no US-listed filer exists.`);
}

function toEntity(r: SecTickerRow, matched_by: 'ticker' | 'company_name'): SecEntity {
  return {
    ticker: r.ticker,
    cik: String(r.cik_str),
    cik_padded: String(r.cik_str).padStart(10, '0'),
    company_name: r.title,
    matched_by,
  };
}

const GENERIC_CORP_WORDS = new Set([
  'THE', 'A', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'LLC', 'LP', 'PLC', 'SA', 'AG', 'NV', 'GMBH', 'AB', 'AS', 'OY', 'SPA',
  'GROUP', 'HOLDINGS', 'HOLDING', 'AND', 'OF', 'US', 'USA', 'INTERNATIONAL',
  'GLOBAL',
]);

/**
 * Split a corporate/organization name into its SIGNIFICANT tokens — words
 * that aren't generic corporate boilerplate (Inc, Co, Ltd, Group, ...) or
 * punctuation — sorted LONGEST FIRST. Built for cross-registry name joins
 * where the two registries anchor on different words of the same name: SEC
 * lists Eli Lilly as "ELI LILLY & Co", but Drugs@FDA's sponsor_name field
 * uses "LILLY" — the longer, more distinctive token, not the first one
 * ("ELI" alone is short and matches too loosely). Pure (no I/O); callers
 * typically try tokens in order until one call to their OWN registry
 * returns a result.
 */
function significantNameTokens(name: string): string[] {
  const tokens = name
    .toUpperCase()
    .replace(/[.,&/()-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !GENERIC_CORP_WORDS.has(t));
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}
/**
 * Italian regulated disclosures direct from 1INFO — keyless, same-day-fresh.
 *
 * 1INFO is the SECOND of Italy's two Officially Appointed Mechanisms (OAMs)
 * for EU Transparency Directive regulated-information dissemination — the
 * sibling of `emarket-storage` (Teleborsa). An issuer discloses through
 * exactly one of the two. Roughly half of STAR-segment issuers, and several
 * well-known blue chips (IREN, SOMEC — confirmed live 2026-09-24 by their
 * presence in 1INFO's own 314-issuer list and absence from eMarket
 * Storage's), use 1INFO instead.
 *
 * ⚠️ DOCUMENT INDEX, NOT XBRL FACTS. Every row is a disclosure EVENT — a
 * title, an issuer, a publication timestamp, a category, and a link to the
 * underlying document. There is no per-fact structured-data extraction. For
 * XBRL facts (net income, revenue…) from Italian ANNUAL reports, use
 * `esef-filings` (proxies filings.xbrl.org, the community ESEF index) —
 * measured 2026-09: Italian annual filings reach it about 6 days after
 * 1INFO/eMarket storage. There is no ESEF-facts source for HALF-YEAR reports
 * at all (ESEF is annual-only by construction), so this pack is the only way
 * to see those.
 *
 * ⚠️ 1INFO-COVERED ISSUERS ONLY. A company not in 1INFO's own picklist is
 * reported as such, with a pointer to `emarket-storage`'s
 * `emarket_search_disclosures` — this pack does not merge eMarket data.
 *
 * ⚠️ NO SERVER-SIDE FILTER BY ISSUER. Verified live 2026-09-24: 1INFO's own
 * `/API/Documenti` DataTables endpoint accepts `SearchFilter[categoria]` (it
 * genuinely narrows `recordsFiltered`), but BOTH `SearchFilter[ndg]` (the
 * issuer id) and the DataTables global `search[value]` are silently IGNORED —
 * `recordsFiltered` stays at the unfiltered total either way. This pack
 * resolves a company name to 1INFO's internal `ndg` and then filters
 * CLIENT-SIDE by paging the (always storage-date-descending) result set,
 * stopping once the date window is exhausted or a bounded scan depth is hit.
 * A very old or now-rarely-filing issuer's disclosures may sit past that
 * depth — every response says honestly how far back it actually scanned
 * (`scanned.oldest_date_local`, `scanned.stopped_reason`), never a fabricated
 * completeness claim.
 *
 * ⚠️ THE DOWNLOAD URL NEEDS A ".pdf" SUFFIX 1INFO's OWN JSON DOES NOT SHOW —
 * a silent-404-shaped trap, not just a cosmetic one. `PdfShow.aspx` takes
 * `file=<code>` and `year=<fiscal year>`. When a row HAS an XBRL package
 * (`protocolCodeXbrl` non-null, e.g. `"165960_oneinfo.zip"`), that value
 * downloads as-is (verified 2026-09-24: SOMEC FY2025, HTTP 200, 15.1 MB
 * ZIP). But when `protocolCodeXbrl` is null — every half-year report, every
 * ancillary filing, i.e. most rows — using the bare `protocolCode` (e.g.
 * `"171904_oneinfo"`) 302-redirects to `Error.aspx …documento non trovato`
 * with NO indication of what went wrong. Appending `.pdf` to that same code
 * (`"171904_oneinfo.pdf"`) is what actually resolves, confirmed live on
 * three different issuers/categories (UNIDATA REGEM, Banca Sistema 3.1,
 * SOMEC 1.2). `year` is the FISCAL year from `dataEsercizio`, not the
 * calendar year the document was stored (also confirmed live) — this pack
 * computes both from the row and builds a working URL every time.
 *
 * ⚠️ date_to IS INCLUSIVE (the last day you want included) — unlike
 * `emarket-storage`, this pack does the date filtering itself (client-side,
 * on the Europe/Rome calendar date of each row) rather than passing a range
 * to the upstream, so there is no exclusive-upstream-bound trap to work
 * around; the inclusive contract is simply "rows with a local date
 * <= date_to are kept."
 *
 * All tools return shaped, LLM-friendly objects (not raw JSON blobs) and
 * never throw — fetch/parse failures resolve to { error }.
 */


const UA = 'Pipeworx/1.0 (+https://pipeworx.io; support@pipeworx.io)';
const SOURCE_NAME = '1INFO (Italian OAM)';
const ORIGIN = 'https://www.1info.it';
const API_BASE = `${ORIGIN}/PORTALE1INFO/API`;
const PDF_VIEWER = `${ORIGIN}/PdfViewer/PdfShow.aspx`;

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(
    url,
    { ...init, headers: { 'User-Agent': UA, ...(init?.headers ?? {}) } },
    SOURCE_NAME,
  );
}

// EU Transparency Directive + Consob category codes, as 1INFO's own
// `/API/documenti/Categories` enumerates them (deduped; the raw endpoint
// repeats DOAG/DOOS/DOAL several times each) — extracted live 2026-09-24.
const CATEGORY_LABELS: Record<string, string> = {
  '1.1': '1.1 Relazione finanziaria annuale e relazione di revisione annuale',
  '1.2': '1.2 Relazioni finanziarie semestrali e relazioni di revisione semestrali/revisioni limitate',
  '1.3': '1.3 Pagamento ai governi',
  '2.1': "2.1 Stato membro d'origine",
  '2.2': '2.2 Informazioni privilegiate',
  '2.3': '2.3 Notifiche di partecipazioni rilevanti',
  '2.4': "2.4 Acquisizione o cessione di azioni proprie dell'emittente",
  '2.5': '2.5 Totale dei diritti di voto e del capitale',
  '2.6': '2.6 Modifiche dei diritti inerenti alle categorie di azioni o di valori mobiliari',
  '3.1': "3.1 Ulteriori informazioni previste dalla regolamentazione nazionale",
  MANTRA: 'MANTRA — Internal Dealing (operazioni di persone rilevanti e strettamente associate)',
  MANRSS: 'MANRSS — Relazione sulla gestione, inclusa la dichiarazione di sostenibilità',
  REGEM: "REGEM — Altre informazioni regolamentate (art. 82-ter Regolamento Consob 11971/1999)",
  DOAG: 'DOAG — Relazione finanziaria',
  DOOS: 'DOOS — Documenti operazioni straordinarie',
  DOAL: 'DOAL — Documenti diversi',
};
const CATEGORY_HINT = Object.entries(CATEGORY_LABELS).map(([code, label]) => `${code}=${label}`).join('; ');

const UPSTREAM_PAGE = 1000; // confirmed live: 1INFO honors length up to at least 5000, so one request covers a wide window.
const MAX_SEARCH_REQUESTS = 6; // bounds a company-only (no date_from) scan to ~6,000 rows — roughly 2.5+ years of market-wide volume, measured live 2026-09-24.
const MAX_LOOKUP_REQUESTS = 3; // a single day's market-wide volume is a few dozen rows at most (33,444 rows / ~5 years measured); 3,000 is generous headroom.

const tools: McpToolExport['tools'] = [
  {
    name: 'oneinfo_search_disclosures',
    description:
      `Search Italian regulated company disclosures from 1INFO, one of Italy's two EU Transparency Directive Officially Appointed Mechanisms (the other is eMarket Storage — use emarket-storage's emarket_search_disclosures for issuers covered there instead, e.g. WEBUILD/SAIPEM). Identify the issuer with company (free-text name, resolved against 1INFO's own 314-issuer list) or ndg (1INFO's internal numeric issuer id, from a prior result) — there is no ISIN field on this source, and LEI only appears embedded in the filename of XBRL-tagged annual-report ZIPs (see the returned document_url for those). date_to IS INCLUSIVE (the last local-calendar day you want, Europe/Rome). COVERAGE: 1INFO issuers only — a second Italian mechanism, eMarket Storage, covers a separate set (e.g. WEBUILD) and is not included; an unmatched company name is reported as "not a 1INFO issuer", not as an error. NO SERVER-SIDE ISSUER FILTER exists on this source, so a company/ndg search scans recent storage-date-ordered pages client-side up to a bounded depth — the response's scanned.oldest_date_local says honestly how far back it looked; a rarely-filing issuer may need a narrower/older date_from to surface. Category codes: ${CATEGORY_HINT}. Returns disclosure EVENTS (title, company, category, timestamp, document link) — NOT extracted XBRL facts; for annual-report XBRL facts use esef-filings (Italy: ~6 days behind 1INFO). Half-year reports have NO XBRL-facts source anywhere else, since ESEF is annual-only.`,
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Free-text issuer name, e.g. "SOMEC", "IREN". Resolved against 1INFO\'s own 314-issuer picklist (name match, not a fulltext search). If it matches more than one issuer equally well, the response lists the candidates instead of guessing — retry with ndg.' },
        ndg: { type: ['string', 'number'], description: '1INFO\'s internal issuer id, e.g. "484" (IREN). Use the value returned by a previous company search to skip name resolution.' },
        category: { type: 'string', description: `Category code to filter by, e.g. "2.2" for Informazioni privilegiate. This is the one filter 1INFO's own API honors server-side. See the tool description for the full code list. A row can carry more than one code (e.g. "1.2,2.2"); category_label reflects only the code you filtered on.` },
        date_from: { type: 'string', description: 'Only disclosures published on or after this date (YYYY-MM-DD, Europe/Rome calendar date, inclusive). If date_to is omitted, this tool searches just this one day.' },
        date_to: { type: 'string', description: 'Only disclosures published on or before this date (YYYY-MM-DD, Europe/Rome calendar date, INCLUSIVE — the last day you want included).' },
        limit: { type: ['number', 'string'], description: 'Number of disclosures to return (1-50). Default 10.' },
        offset: { type: ['number', 'string'], description: 'Result offset for pagination within the already-scanned match set. Default 0.' },
      },
    },
  },
  {
    name: 'oneinfo_get_disclosure',
    description:
      'Fetch a single 1INFO disclosure by its protocolCode id and publication date, as returned by oneinfo_search_disclosures. This source has no by-id-only lookup endpoint, only by-day listings, so both id and date are required. Returns the shaped record — company, title, category, timestamp, and the document URL (with the .pdf-suffix / fiscal-year gotchas already handled).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'protocolCode, e.g. "171904_oneinfo", from an oneinfo_search_disclosures result (its bare id, without any .pdf/.zip suffix — this tool adds the right one).' },
        date: { type: 'string', description: "The disclosure's publication date (YYYY-MM-DD, Europe/Rome), from the same search result (published_at_local's date part)." },
      },
      required: ['id', 'date'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'oneinfo_search_disclosures':
        return await searchDisclosures(args);
      case 'oneinfo_get_disclosure':
        return await getDisclosure(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- issuer (ndg) picklist -- name/id map ----------------------------------

interface Issuer { id: string; name: string }

let issuerCache: { list: Issuer[]; until: number } | null = null;
const ISSUER_TTL_MS = 24 * 60 * 60 * 1000; // the issuer roster changes rarely; a day-old cache is fine for name resolution.

async function getIssuerList(): Promise<Issuer[]> {
  if (issuerCache && issuerCache.until > Date.now()) return issuerCache.list;
  const res = await pwFetch(`${API_BASE}/companies/documenti`);
  if (!res.ok) throw await httpError(res, SOURCE_NAME);
  const raw = (await res.json()) as { ndg: number; descrizione: string }[];
  const list = raw.map((r) => ({ id: String(r.ndg), name: r.descrizione.trim() })).filter((r) => r.name);
  issuerCache = { list, until: Date.now() + ISSUER_TTL_MS };
  return list;
}

// ---- Documenti (DataTables server-side) ------------------------------------

interface RawDoc {
  ndg: number;
  dataStoccaggio: number; // unix seconds — when it was stored/published
  dataEsercizio: number; // unix seconds — the fiscal-period date, used for the download URL's "year"
  mittente: string;
  oggetto: string;
  categoria: string;
  protocolCode: string;
  protocolCodeXbrl: string | null;
}

interface DocumentiPage {
  recordsTotal: number;
  recordsFiltered: number;
  data: RawDoc[];
}

// 1INFO's `/API/Documenti` is a DataTables server-side endpoint. A bare POST
// (missing the standard DataTables form fields) fails with a
// NullReferenceException server-side — verified live 2026-09-24, this exact
// field set is what a real DataTables client sends and what 1INFO requires.
function buildDocumentiBody(categoria: string | undefined, start: number, length: number): string {
  const p = new URLSearchParams();
  p.set('draw', '1');
  p.set('columns[0][data]', '');
  p.set('columns[0][name]', '');
  p.set('columns[0][searchable]', 'true');
  p.set('columns[0][orderable]', 'false');
  p.set('columns[0][search][value]', '');
  p.set('columns[0][search][regex]', 'false');
  p.set('order[0][column]', '0');
  p.set('order[0][dir]', 'desc');
  p.set('start', String(start));
  p.set('length', String(length));
  if (categoria) p.set('SearchFilter[categoria]', categoria);
  return p.toString();
}

async function fetchDocumentiPage(categoria: string | undefined, start: number, length: number): Promise<DocumentiPage> {
  const res = await pwFetch(`${API_BASE}/Documenti`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildDocumentiBody(categoria, start, length),
  });
  if (!res.ok) throw await httpError(res, SOURCE_NAME);
  return (await res.json()) as DocumentiPage;
}

// ---- Europe/Rome date handling (DST-correct, via Intl rather than manual offsets) ----

const romeDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome',
  year: 'numeric', month: '2-digit', day: '2-digit',
});
const romeDateTimeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function romeDateLocal(epochSeconds: number): string {
  return romeDateFmt.format(new Date(epochSeconds * 1000)); // en-CA formats as YYYY-MM-DD directly
}

function romeDateTimeLocal(epochSeconds: number): string {
  const parts = romeDateTimeFmt.formatToParts(new Date(epochSeconds * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

function romeYearLocal(epochSeconds: number): string {
  return romeDateLocal(epochSeconds).slice(0, 4);
}

// ---- shared row shaping -----------------------------------------------------

function documentUrl(protocolCode: string, protocolCodeXbrl: string | null, fiscalYear: string): string {
  // ⚠️ protocolCodeXbrl (when present) already IS the downloadable filename
  // ("165960_oneinfo.zip"). When it's null — every non-XBRL filing, which is
  // most of them — the bare protocolCode 302s to an error page; appending
  // ".pdf" is what actually resolves. Both confirmed live 2026-09-24.
  const file = protocolCodeXbrl ?? `${protocolCode}.pdf`;
  const params = new URLSearchParams({ service: '', type: 'documenti', year: fiscalYear, file, download: '1' });
  return `${PDF_VIEWER}?${params.toString()}`;
}

function shapeRow(r: RawDoc): Record<string, unknown> {
  const fiscalYear = romeYearLocal(r.dataEsercizio);
  const codes = r.categoria.split(',').map((c) => c.trim()).filter(Boolean);
  return {
    id: r.protocolCode,
    company: r.mittente,
    ndg: r.ndg,
    category: r.categoria,
    category_labels: codes.map((c) => CATEGORY_LABELS[c] ?? c),
    title: r.oggetto,
    published_at_local: romeDateTimeLocal(r.dataStoccaggio),
    timezone: 'Europe/Rome',
    fiscal_year: fiscalYear,
    has_xbrl: r.protocolCodeXbrl !== null,
    document_url: documentUrl(r.protocolCode, r.protocolCodeXbrl, fiscalYear),
  };
}

// ---- args ------------------------------------------------------------------

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  let n: number;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.trunc(v);
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Math.trunc(Number(v));
  else return dflt;
  return Math.min(max, Math.max(min, n));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- search -----------------------------------------------------------------

async function searchDisclosures(args: Record<string, unknown>): Promise<unknown> {
  const companyQuery = strArg(args.company);
  const ndgArg = strArg(args.ndg);
  const categoryArg = strArg(args.category);
  const dateFromArg = strArg(args.date_from);
  const dateToArg = strArg(args.date_to);
  const limit = clampInt(args.limit, 10, 1, 50);
  const offset = clampInt(args.offset, 0, 0, 100000);

  if (dateFromArg && !DATE_RE.test(dateFromArg)) return { error: 'date_from must be YYYY-MM-DD.' };
  if (dateToArg && !DATE_RE.test(dateToArg)) return { error: 'date_to must be YYYY-MM-DD.' };

  // date_to is INCLUSIVE by contract. A lone date_from with no date_to means
  // "just that one day" (mirrors emarket-storage's convention).
  const dateFrom = dateFromArg;
  const dateTo = dateToArg ?? dateFromArg;

  let ndg: string | undefined = ndgArg;
  let resolvedCompany: string | undefined;
  let otherCandidates: { ndg: string; company: string }[] | undefined;

  if (!ndg && companyQuery) {
    const issuers = await getIssuerList();
    const ranked = rankMatches(companyQuery, issuers, (e) => e.name);
    if (ranked.length === 0) {
      return {
        error: `"${companyQuery}" does not match any 1INFO issuer.`,
        note: 'This pack only covers issuers that disclose through 1INFO. A separate mechanism, eMarket Storage, covers a different set of Italian issuers — try emarket-storage\'s emarket_search_disclosures instead.',
      };
    }
    const top = ranked[0];
    const tiedAtTop = ranked.filter((r) => r.score === top.score);
    if (tiedAtTop.length > 1) {
      return {
        error: `"${companyQuery}" matches more than one 1INFO issuer equally well.`,
        candidates: tiedAtTop.slice(0, 10).map((r) => ({ ndg: r.item.id, company: r.item.name })),
      };
    }
    ndg = top.item.id;
    resolvedCompany = top.item.name;
    otherCandidates = ranked.slice(1, 5).map((r) => ({ ndg: r.item.id, company: r.item.name }));
  }

  const needed = offset + limit;
  const matches: RawDoc[] = [];
  let start = 0;
  let requestsMade = 0;
  let rowsScanned = 0;
  let oldestDateLocal: string | null = null;
  let recordsFilteredUpstream = 0;
  // null until something explicitly ends the scan — a loop that falls out
  // only because it hit MAX_SEARCH_REQUESTS is exactly the 'scan_cap' case,
  // and leaving this unset until then (rather than defaulting to a specific
  // reason) is what makes that fallback correct regardless of matches.length.
  let stoppedReason: 'satisfied' | 'date_boundary' | 'exhausted' | 'scan_cap' | null = null;

  outer: while (requestsMade < MAX_SEARCH_REQUESTS) {
    const page = await fetchDocumentiPage(categoryArg, start, UPSTREAM_PAGE);
    requestsMade++;
    recordsFilteredUpstream = page.recordsFiltered;
    if (page.data.length === 0) { stoppedReason = 'exhausted'; break; }
    for (const row of page.data) {
      rowsScanned++;
      const local = romeDateLocal(row.dataStoccaggio);
      oldestDateLocal = local;
      if (dateFrom && local < dateFrom) { stoppedReason = 'date_boundary'; break outer; }
      if (dateTo && local > dateTo) continue; // newer than the requested window — keep scanning back
      if (ndg && String(row.ndg) !== ndg) continue;
      matches.push(row);
      // Only stop early on hitting the caller's limit when there is no
      // date_from — an open-ended (company/category-only) search has no
      // other natural boundary, so bounding it here is what keeps it cheap.
      // With a date_from, the range itself is the boundary: keep scanning to
      // date_boundary/exhausted/scan_cap so matched_in_scanned_range and
      // has_more are honest counts of the actual range, not an artifact of
      // where `limit` happened to fall.
      if (!dateFrom && matches.length >= needed) { stoppedReason = 'satisfied'; break outer; }
    }
    if (page.data.length < UPSTREAM_PAGE) { stoppedReason = 'exhausted'; break; }
    start += UPSTREAM_PAGE;
  }
  if (stoppedReason === null) stoppedReason = 'scan_cap';

  const pageSlice = matches.slice(offset, offset + limit);
  const shaped = pageSlice.map(shapeRow);

  // has_more is conservative about what "satisfied" and "scan_cap" actually
  // prove: stopping there means we reached the caller's `limit` (or our own
  // scan-depth cap) BEFORE exhausting the date range/table, so there may be
  // further matches we simply never looked at. Only 'date_boundary' and
  // 'exhausted' mean the whole range was actually scanned — there, has_more
  // is a real fact about the matches we found, not a guess.
  const rangeFullyScanned = stoppedReason === 'date_boundary' || stoppedReason === 'exhausted';
  const hasMore = rangeFullyScanned ? matches.length > offset + limit : true;

  return {
    count: shaped.length,
    limit,
    offset,
    has_more: hasMore,
    // How many matched within what was actually scanned. When
    // range_fully_scanned is true this IS the total for the filters given
    // (every row in range was checked); when false it is a true LOWER BOUND
    // only — never presented as an exact count of a range this pack did not
    // finish scanning.
    matched_in_scanned_range: matches.length,
    range_fully_scanned: rangeFullyScanned,
    ...(dateFrom ? { date_from: dateFrom } : {}),
    ...(dateTo ? { date_to: dateTo } : {}),
    ...(ndg ? { ndg } : {}),
    ...(resolvedCompany ? { company_resolved: resolvedCompany } : {}),
    ...(otherCandidates && otherCandidates.length ? { other_candidates: otherCandidates } : {}),
    ...(categoryArg ? { category: categoryArg, category_label: CATEGORY_LABELS[categoryArg] ?? null } : {}),
    // A REAL upstream count (never fabricated): how many rows match the
    // category filter (or the whole table, unfiltered) across ALL of 1INFO's
    // history — NOT narrowed by ndg/date, which this pack applies itself.
    ...(categoryArg
      ? { category_matches_all_time: recordsFilteredUpstream }
      : { all_documents_all_time: recordsFilteredUpstream }),
    // Honesty about scan depth, per this pack's no-server-side-issuer-filter
    // limitation — never claim completeness this pack cannot prove.
    scanned: {
      upstream_requests: requestsMade,
      rows_scanned: rowsScanned,
      oldest_date_local: oldestDateLocal,
      stopped_reason: stoppedReason,
    },
    disclosures: shaped,
  };
}

// ---- get by id ---------------------------------------------------------------

async function getDisclosure(args: Record<string, unknown>): Promise<unknown> {
  const id = strArg(args.id);
  const date = strArg(args.date);
  if (!id) throw new Error('oneinfo_get_disclosure requires "id" — a protocolCode like "171904_oneinfo", from an oneinfo_search_disclosures result.');
  if (!date) throw new Error('oneinfo_get_disclosure requires "date" — the disclosure\'s publication date (YYYY-MM-DD, Europe/Rome). This source has no by-id-only lookup, only by-day listings.');
  if (!DATE_RE.test(date)) return { error: 'date must be YYYY-MM-DD.' };

  let start = 0;
  for (let i = 0; i < MAX_LOOKUP_REQUESTS; i++) {
    const page = await fetchDocumentiPage(undefined, start, UPSTREAM_PAGE);
    if (page.data.length === 0) break;
    for (const row of page.data) {
      const local = romeDateLocal(row.dataStoccaggio);
      if (local > date) continue; // still newer than the requested day — keep scanning back
      if (local < date) return { error: 'disclosure not found for that id/date', id, date };
      if (row.protocolCode === id) return shapeRow(row);
    }
    if (page.data.length < UPSTREAM_PAGE) break;
    start += UPSTREAM_PAGE;
  }
  return { error: 'disclosure not found for that id/date', id, date };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
