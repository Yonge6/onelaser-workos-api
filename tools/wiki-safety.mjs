const originalCatalogLine = "    const fid=route.startsWith('family/')?decodeURIComponent(route.slice(7)):params.get('family')||'',isDownloads=route==='downloads',q=params.get('q')||'',top=isDownloads?'downloads':params.get('topic')||'';";
const hardenedCatalogLine = "    const requestedFid=route.startsWith('family/')?decodeURIComponent(route.slice(7)):params.get('family')||'',fid=library.families.some(f=>f.id===requestedFid)?requestedFid:'',isDownloads=route==='downloads',q=params.get('q')||'',top=isDownloads?'downloads':params.get('topic')||'';";

/** Apply only after the pinned upstream Git blob has passed byte verification.
 * The original page interpolates its URL-supplied family value into HTML links.
 * Select a family from the fixed public catalog instead of rendering that value.
 * Refuse changed upstream code, duplicate sites, or an accidental second pass.
 */
export function hardenWikiApp(source) {
  if (typeof source !== 'string') throw new TypeError('Wiki application source must be text.');
  const lines = source.split('\n');
  if (lines.filter(line => line === originalCatalogLine).length !== 1 ||
      source.indexOf(originalCatalogLine) !== source.lastIndexOf(originalCatalogLine)) {
    throw new Error('Pinned Wiki catalog guard must match exactly once.');
  }
  return source.replace(originalCatalogLine, hardenedCatalogLine);
}
