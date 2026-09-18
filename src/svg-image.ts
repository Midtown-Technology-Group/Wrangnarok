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
// scripts, event-handler attributes (on*=), javascript:/vbscript: URLs,
// active containers (foreignObject, iframe, object, embed), document-level
// tags that can carry loads (link, meta, handler, listener), external
// references (http(s) URLs, non-fragment url(...) targets), HTML-embedded
// data payloads, and DTD/entity declarations (no XXE surface even though
// browsers would not resolve it). Allowed: static shapes, gradients,
// SMIL animation, internal fragment refs (url(#...)), and embedded raster
// image data.
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
  "<!doctype",
  "<!entity",
] as const;

/** Namespace declarations (`xmlns="http://www.w3.org/2000/svg"`) are
 * identifiers, never fetches: strip their values before the remote-ref
 * scan so ordinary exported SVG passes while real href/src loads fail. */
const XMLNS_DECL = /xmlns(?::[\w-]+)?\s*=\s*("[^"]*"|'[^']*')/g;

/** Event-handler attributes (` onload=`, `onbegin =`, ...) on the lowered markup. */
const EVENT_HANDLER_ATTR = /\son[a-z]+\s*=/;

/** Non-fragment url(...) targets: url(#gradient) is internal and fine;
 * url(http...), url(data:...), url(//...) leave the document. */
const URL_REF = /url\(\s*([^)]*)\)/g;

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
  URL_REF.lastIndex = 0;
  for (const match of scannable.matchAll(URL_REF)) {
    const target = (match[1] ?? "").trim();
    if (!target.startsWith("#")) {
      throw new Error("SVG images must reference only internal fragments: no external url(...) targets.");
    }
  }
}
