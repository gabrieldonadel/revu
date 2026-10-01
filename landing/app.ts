import type { Answer, Result, Sources } from './app.contract.d.ts';

// revu's landing page (LLP 0008), the Claude Design file "Revu Landing Page".
// The one live datum is the latest GitHub release, so the download buttons
// name the current build; everything else on the page is copy and artwork.
export const appId = 'dev.donadel.revu.landing';
export const grants = ['net.fetch https://api.github.com'].join('\n');

const REPO = 'gabrieldonadel/revu';
const RELEASES = `https://github.com/${REPO}/releases`;

type Release = Result<'latestRelease'>;

const none: Release = { ready: false, tag: '', url: RELEASES, assetUrl: RELEASES, assetName: '', sizeMb: '', published: '', prerelease: false };

async function latestRelease(): Promise<Release> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=5`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) return none;
    const list = (await res.json()) as Array<Record<string, any>>;
    const release = list.find((r) => !r.draft);
    if (!release) return none;
    const asset = ((release.assets ?? []) as Array<Record<string, any>>).find((a) => /macos-arm64\.zip$/.test(String(a.name)));
    return {
      ready: true,
      tag: String(release.tag_name ?? ''),
      url: String(release.html_url ?? RELEASES),
      assetUrl: String(asset?.browser_download_url ?? release.html_url ?? RELEASES),
      assetName: String(asset?.name ?? ''),
      sizeMb: asset ? `${Math.round(Number(asset.size) / 1_048_576)} MB` : '',
      published: String(release.published_at ?? '').slice(0, 10),
      prerelease: Boolean(release.prerelease),
    };
  } catch {
    return none;
  }
}

/** "Notify me": with no backend behind the page yet, the request is a mail
 *  to the maintainer with the address filled in (LLP 0008). */
function notifyLink(email: string): Result<'notifyLink'> {
  const subject = encodeURIComponent('Tell me when revu is open source');
  const body = encodeURIComponent(`Please notify ${email.trim() || 'me'} when the revu repository is public.`);
  return { url: `mailto:revu@donadel.dev?subject=${subject}&body=${body}` };
}

const sources: Sources = {
  latestRelease: () => latestRelease(),
  notifyLink: ([email]) => notifyLink(String(email ?? '')),
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
