import type { Answer, Result, Sources } from './app.contract.d.ts';

// revu's landing page (LLP 0008): one page, built with exact2 for the web.
// The only data is the latest release on GitHub, so the download button
// always names the current build.
export const appId = 'dev.donadel.revu.landing';
export const grants = ['net.fetch https://api.github.com'].join('\n');

const REPO = 'gabrieldonadel/revu';

type Release = Result<'latestRelease'>;

const none: Release = { ready: false, tag: '', name: '', url: `https://github.com/${REPO}/releases`, assetUrl: '', assetName: '', sizeMb: '', published: '', notes: '', prerelease: false };

async function latestRelease(): Promise<Release> {
  try {
    // Releases, newest first; pre-releases count while there is no final one.
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=5`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) return none;
    const list = (await res.json()) as Array<Record<string, any>>;
    const release = list.find((r) => !r.draft);
    if (!release) return none;
    const asset = ((release.assets ?? []) as Array<Record<string, any>>).find((a) => /macos-arm64\.zip$/.test(String(a.name)));
    const published = String(release.published_at ?? '').slice(0, 10);
    return {
      ready: true,
      tag: String(release.tag_name ?? ''),
      name: String(release.name ?? release.tag_name ?? ''),
      url: String(release.html_url ?? none.url),
      assetUrl: String(asset?.browser_download_url ?? release.html_url ?? none.url),
      assetName: String(asset?.name ?? ''),
      sizeMb: asset ? `${Math.round(Number(asset.size) / 1_048_576)} MB` : '',
      published,
      notes: String(release.body ?? '').split('\n').slice(0, 12).join('\n'),
      prerelease: Boolean(release.prerelease),
    };
  } catch {
    return none;
  }
}

const sources: Sources = {
  latestRelease: () => latestRelease(),
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
