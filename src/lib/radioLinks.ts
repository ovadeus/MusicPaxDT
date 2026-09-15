/// A .pls / .m3u link is a text file that *points at* a stream — a browser
/// <audio> element can't play one (only HLS .m3u8 is native), so it fails
/// with no useful error. Radio directories and hosts such as Radio King hand
/// these out as a station's URL, so they must be unwrapped before playback
/// (the resolver follows them to the stream itself).
export function isPlaylistLink(url: string): boolean {
  const path = url.toLowerCase().split(/[?#]/)[0];
  return path.endsWith(".m3u") || path.endsWith(".pls");
}
