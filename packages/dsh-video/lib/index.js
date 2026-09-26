/**
 * dsh-video — Node half.
 *
 * The video surface is browser-only: it registers a `video` tab type into the
 * right bar's registry (dsh-rightbar) and reads everything it shows from
 * **dsh-media**'s host routes — the Range-capable file stream, the probe
 * summary, and the remux/transcode job. That split is deliberate: ffmpeg has
 * exactly one owner in this pack, and a second implementation of the media path
 * policy would be a second thing to get wrong.
 *
 * So the host tree gains nothing here and this row exists only so the package's
 * `dsh.client` declaration puts its browser bundle in the boot graph — exactly
 * like dsh-image and dsh-audio, whose Node halves are one no-op row each.
 *
 * A profile that installs this bundle WITHOUT dsh-media still loads: the tab
 * renders and says, in one sentence, which package owns the routes it needs.
 */
export const name = 'dsh-video'

/** Host plugin body: the video viewer contributes nothing to the host tree. */
export function apply() {}
