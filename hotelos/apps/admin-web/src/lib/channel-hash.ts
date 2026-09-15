// `#channel=<id>` deep link shared by the Channel Manager hub («Mapeos» on a
// channel row) and the Mapeos screen. Pure (no DOM) so it is unit-tested:
// reading it seeds the screen's selection, writing it keeps the URL in sync
// when the hotelier switches channel with the select, so F5 / a shared link
// reopens the channel on screen and not the one the hub linked to
// (browser-ux-final#13).

/** Channel id carried by the `#channel=<id>` hash ("" when absent). */
export function channelIdFromHash(hash: string): string {
  const match = /[#&]channel=([^&]+)/.exec(hash);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * The hash with `channel=<id>` set (replaced in place when present, appended
 * otherwise, other params kept). An empty id leaves the hash untouched.
 */
export function withChannelHash(hash: string, channelId: string): string {
  if (!channelId) return hash;
  const encoded = encodeURIComponent(channelId);
  if (/[#&]channel=([^&]*)/.test(hash)) return hash.replace(/([#&])channel=([^&]*)/, `$1channel=${encoded}`);
  const bare = hash.replace(/^#/, "");
  return bare ? `#${bare}&channel=${encoded}` : `#channel=${encoded}`;
}
