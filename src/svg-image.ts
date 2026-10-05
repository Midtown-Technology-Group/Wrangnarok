// SPDX-License-Identifier: AGPL-3.0
// Shared SVG image guard (UX-01 slice 3, issue #176): allowlist-validate for
// inline SVG logos and avatars.
//
// Decision (scout UX-01-S3: allowlist-scrub vs reject-forever): validate and
// store, fail closed on anything active. Scrubbing (rewriting markup) risks
// silently changing the rendered mark and is harder to pin with tests; the
// boring alternative is to accept only inert SVG and reject the rest with
// 415 before any byte reaches R2. The validator returns void and throws a
// plain Error whose message the caller (branding or profile) wraps in its
// own Fault code (UNSUPPORTED_LOGO / UNSUPPORTED_AVATAR), so both surfaces
// share one rejection shape without sharing error codes.
//
// Rejected, fail-closed: non-UTF-8 bytes, missing <svg> root, embedded
// scripts, event-handler attributes (on*=), link elements (<a> in any
// namespace — a logo/avatar mark has no legitimate link), href/src targets
// outside the fragment-or-embedded-image allowlist (this subsumes
// javascript:/vbscript:, entity-encoded schemes, and protocol-relative
// URLs, which plain token scans miss), active containers (foreignObject,
// iframe, object, embed), document-level tags that can carry loads (link,
// meta, handler, listener), external references (http(s) URLs, non-fragment
// url(...) targets, CSS @import), HTML-embedded data payloads, and
// DTD/entity declarations (no XXE surface even though browsers would not
// resolve it). Allowed: static shapes, gradients, SMIL animation, internal
// fragment refs (url(#...), href="#...", xlink:href="#..."), and embedded
// raster image data.
//
// Serving stays safe by construction: SVG bytes ride the existing apiBytes
// path whose Content-Security-Policy is `default-src 'none'`
// (src/index.ts), so even a direct navigation cannot run script; <img>
// embeds (the only in-app consumer) never run SVG script at all. SVG is
// text, so the same byte caps as raster apply unchanged (5 MiB logos,
// 2 MiB avatars — enforced by the callers, not here).
export const SVG_CONTENT_TYPE = "image/svg+xml";

/** Forbidden literal tokens (lowercased scan): active elements, script
 * schemes, remote references, and entity/DTD declarations. */
const FORBIDDEN_TOKENS = [
  "<script",
  "<foreignobject",
  "<iframe",
  "<object",
  "<embed",
  "<link",
  "<meta",
  "<handler",
  "<listener",
  "javascript:",
  "vbscript:",
  "data:text/html",
  "http://",
  "https://",
  "@import",
  "<!doctype",
  "<!entity",
] as const;

/** Namespace declarations (`xmlns="http://www.w3.org/2000/svg"`) are
 * identifiers, never fetches: strip their values before the remote-ref
 * scan so ordinary exported SVG passes while real href/src loads fail. */
const XMLNS_DECL = /xmlns(?::[\w-]+)?\s*=\s*("[^"]*"|'[^']*')/g;

/** Event-handler attributes (` onload=`, `onbegin =`, ...) on the lowered markup. */
const EVENT_HANDLER_ATTR = /\son[a-z]+\s*=/;

/** Link elements (`<a>`, `<a href=...>`, `<a/>`): a logo/avatar mark has no
 * legitimate link. The lookahead keeps `<animate>`/`<animateTransform>`
 * (SMIL, allowed) passing — only a bare `a` tag name matches. */
const LINK_ELEMENT = /<a(?=[\s>/])/;

/** Namespaced active elements (`<svg:script>`, `<f:foreignobject>`, ...):
 * the literal-token scan only catches unprefixed tags, so match the
 * dangerous local names behind any namespace prefix. Namespaced
 * *attributes* (`xlink:href`) are unaffected — only element start tags
 * (a `<` directly before the prefixed name) match. */
const NAMESPACED_ACTIVE_ELEMENT =
  /<[\w.-]+:(script|foreignobject|iframe|object|embed|link|meta|handler|listener|a)(?=[\s>/])/;

/** Resource-target attributes: every href/src value must be an internal
 * fragment (`#gradient`), empty (same-document), or an embedded image
 * (`data:image/...`). Anything else — remote URLs, protocol-relative
 * targets, entity-encoded schemes (`&#106;avascript:`), non-image data
 * payloads — is rejected. Values are scanned raw (entities NOT decoded),
 * so an encoded scheme can never smuggle past: it simply is not a
 * fragment or an embedded image. */
const RESOURCE_ATTR = /(?:^|[\s>])(xlink:href|href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;

/** Non-fragment url(...) targets: url(#gradient) is internal and fine;
 * url(http...), url(data:...), url(//...) leave the document. */
const URL_REF = /url\(\s*([^)]*)\)/g;

function checkResourceTargets(scannable: string): void {
  RESOURCE_ATTR.lastIndex = 0;
  for (const match of scannable.matchAll(RESOURCE_ATTR)) {
    const raw = (match[2] ?? "").trim();
    const value = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1).trim() : raw;
    if (value !== "" && !value.startsWith("#") && !value.startsWith("data:image/")) {
      throw new Error(
        "SVG images must keep references self-contained: href/src targets must be fragments or embedded images.",
      );
    }
  }
}

/** Throw when the bytes are not inert, self-contained SVG. Pure function:
 * no I/O, no storage, safe to call before the R2-first write. */
export function validateSvgImage(bytes: Uint8Array): void {
  let markup: string;
  try {
    markup = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new Error("SVG images must be valid UTF-8 text.");
  }
  if (markup.includes("\0")) {
    throw new Error("SVG images must not contain NUL bytes.");
  }
  const head = markup.slice(0, 300).toLowerCase();
  if (!head.includes("<svg")) {
    throw new Error("SVG images must be inline <svg> markup, not a reference.");
  }
  const lowered = markup.toLowerCase();
  if (!lowered.includes("</svg")) {
    throw new Error("SVG images must be complete <svg> markup.");
  }
  const scannable = lowered.replace(XMLNS_DECL, "");
  for (const token of FORBIDDEN_TOKENS) {
    if (scannable.includes(token)) {
      throw new Error("SVG images must be self-contained: no scripts and no remote references.");
    }
  }
  if (EVENT_HANDLER_ATTR.test(scannable)) {
    throw new Error("SVG images must not carry event-handler attributes.");
  }
  if (LINK_ELEMENT.test(scannable)) {
    throw new Error("SVG images must not contain links.");
  }
  if (NAMESPACED_ACTIVE_ELEMENT.test(scannable)) {
    throw new Error("SVG images must not use namespaced active elements.");
  }
  checkResourceTargets(scannable);
  URL_REF.lastIndex = 0;
  for (const match of scannable.matchAll(URL_REF)) {
    const target = (match[1] ?? "").trim();
    if (!target.startsWith("#")) {
      throw new Error("SVG images must reference only internal fragments: no external url(...) targets.");
    }
  }
}
