/**
 * dsh-research — XML and OOXML markup helpers.
 *
 * OOXML is XML, so everything a part contains has to survive being parsed by a
 * real parser before it can survive being read by Word. This module owns the
 * three places that is not free:
 *
 *   1. **A character XML cannot express must not reach the file.** Control bytes
 *      (except tab, newline and carriage return) and lone surrogates are not legal
 *      XML 1.0, and a single one makes the whole document unparseable - the
 *      failure is total, not local, which is why the strip happens in `xmlEscape`
 *      rather than at each call site.
 *   2. **`w:t` preserves space.** A run's text keeps its leading and trailing
 *      spaces, and XML's default attribute-value handling does not: without
 *      `xml:space="preserve"` Word silently eats the space between two runs, which
 *      is what makes "Smith, J." and "& Jones" print as one word.
 *   3. **An attribute value is not text.** The five predefined entities plus the
 *      two quote characters, in an attribute, or the markup breaks at the first
 *      quote of a title.
 *
 * Nothing here reads a file, and nothing decides what a document says: this is a
 * string layer under the writer.
 */

/**
 * The characters XML 1.0 does not allow, anywhere.
 *
 * C0 controls other than tab, newline and carriage return are forbidden, as are
 * the two code points that can only appear as a lone surrogate (an unpaired half
 * of a pair). `NUL` is the one most likely to arrive from ledger text.
 */
const ILLEGAL_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/g

/** The five predefined entities, plus the two quotes, as XML spells them. */
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

/** Strip what XML cannot carry, leaving everything else untouched. */
export function xmlStrip(value) {
  return String(value ?? '').replace(ILLEGAL_XML, '')
}

/** A string as XML text: stripped, then escaped so no character can open markup. */
export function xmlEscape(value) {
  return xmlStrip(value).replace(/[&<>"']/g, (one) => ENTITIES[one])
}

/** A string as an attribute value, quoted with `"`. Same escapes; the quotes matter. */
export function xmlAttr(value) {
  return '"' + xmlEscape(value) + '"'
}

/**
 * A `w:t` run's TEXT, with `xml:space="preserve"`.
 *
 * The `preserve` is the whole point: a run's own text is often a single space or
 * ends in one, and XML processors are free to strip that without it.
 */
export function wText(value) {
  return '<w:t xml:space="preserve">' + xmlEscape(value) + '</w:t>'
}

/** A `w:val` attribute for an element, `<tag w:val="v"/>`. */
export function wVal(tag, value) {
  return '<' + tag + ' w:val=' + xmlAttr(value) + '/>'
}

/** A boolean `w:val`: OOXML's ST_OnOff spellings, which accept `0`/`1` everywhere. */
export function wOnOff(tag, on) {
  return '<' + tag + ' w:val=' + xmlAttr(on === false ? '0' : '1') + '/>'
}

/** A `w:val` attribute holding an integer, `<tag w:val="720"/>`. */
export function wNum(tag, value) {
  return '<' + tag + ' w:val=' + xmlAttr(Math.round(Number(value))) + '/>'
}

/**
 * A TRIMMED run text, or null when there is nothing to write.
 *
 * A run with no text is legal XML but noise in a document, and the writer's run
 * lists are built from markup that can legitimately be empty (`****`).
 */
export function runText(value) {
  const text = xmlStrip(value)
  return text === '' ? null : text
}
