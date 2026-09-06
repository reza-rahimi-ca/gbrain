/**
 * Item 9 correction pass, gap #2: direct positive/negative coverage for the
 * exact-match GitHub remote parser (`parseGithubRemoteOwnerRepo`) and the
 * `.git/config` remote-URL extractor (`extractGitConfigRemoteUrls`) that
 * `detectBunLink` (src/commands/upgrade.ts) relies on to recognize a
 * bun-linked clone of the CONFIGURED self-upgrade source.
 *
 * The prior implementation matched a whole-file case-insensitive SUBSTRING
 * of `owner/repo` — a spoofed remote could satisfy that as a prefix, suffix,
 * path fragment, or query-like fragment while pointing at a completely
 * different repository. These tests pin the exact-match replacement so a
 * regression back to substring matching fails loudly.
 *
 * Pure functions, no env/fetch mutation — safe to run in parallel.
 */
import { describe, test, expect } from 'bun:test';
import { extractGitConfigRemoteUrls, parseGithubRemoteOwnerRepo } from '../src/commands/upgrade.ts';

describe('parseGithubRemoteOwnerRepo — recognized GitHub remote forms (positive)', () => {
  const expectOwnerRepo = (url: string, owner: string, repo: string) => {
    expect(parseGithubRemoteOwnerRepo(url)).toEqual({ owner, repo });
  };

  test('https, bare', () => expectOwnerRepo('https://github.com/owner/repo', 'owner', 'repo'));
  test('https, .git suffix', () => expectOwnerRepo('https://github.com/owner/repo.git', 'owner', 'repo'));
  test('https, trailing slash', () => expectOwnerRepo('https://github.com/owner/repo/', 'owner', 'repo'));
  test('https, embedded token userinfo', () =>
    expectOwnerRepo('https://x-access-token:TOKEN@github.com/owner/repo.git', 'owner', 'repo'));
  test('https, www. prefix', () => expectOwnerRepo('https://www.github.com/owner/repo', 'owner', 'repo'));
  test('http (not just https)', () => expectOwnerRepo('http://github.com/owner/repo', 'owner', 'repo'));
  test('ssh://, no port', () => expectOwnerRepo('ssh://git@github.com/owner/repo.git', 'owner', 'repo'));
  test('ssh://, explicit port', () => expectOwnerRepo('ssh://git@github.com:22/owner/repo', 'owner', 'repo'));
  test('git:// protocol', () => expectOwnerRepo('git://github.com/owner/repo.git', 'owner', 'repo'));
  test('scp-like shorthand (git@host:owner/repo.git)', () =>
    expectOwnerRepo('git@github.com:owner/repo.git', 'owner', 'repo'));
  test('scp-like shorthand, no user@', () => expectOwnerRepo('github.com:owner/repo', 'owner', 'repo'));
  test('case-insensitive host and owner/repo', () =>
    expectOwnerRepo('GITHUB.COM:OWNER/REPO', 'OWNER', 'REPO'));
  test('leading/trailing whitespace is trimmed', () =>
    expectOwnerRepo('  https://github.com/owner/repo.git  ', 'owner', 'repo'));
});

describe('parseGithubRemoteOwnerRepo — rejects non-GitHub / malformed remotes (negative)', () => {
  test('wrong host entirely (gitlab)', () => {
    expect(parseGithubRemoteOwnerRepo('https://gitlab.com/owner/repo.git')).toBeNull();
  });
  test('lookalike host: github.com as a subdomain suffix of an attacker domain', () => {
    expect(parseGithubRemoteOwnerRepo('https://github.com.evil.com/owner/repo')).toBeNull();
  });
  test('lookalike host: "github.com" glued onto another word', () => {
    expect(parseGithubRemoteOwnerRepo('https://evilgithub.com/owner/repo')).toBeNull();
  });
  test('path-fragment spoof: legit owner/repo followed by extra path segments', () => {
    // A remote like this would satisfy an "includes(owner/repo)" substring
    // check while pointing at an arbitrary sub-path; the anchored pattern
    // must reject it outright rather than truncate to the first two segments.
    expect(parseGithubRemoteOwnerRepo('https://github.com/owner/repo/extra/path')).toBeNull();
  });
  test('not a URL or scp-shape at all', () => {
    expect(parseGithubRemoteOwnerRepo('just some random text')).toBeNull();
  });
  test('empty string', () => {
    expect(parseGithubRemoteOwnerRepo('')).toBeNull();
  });
});

describe('parseGithubRemoteOwnerRepo — prefix/suffix/query spoofs parse to a DIFFERENT owner/repo, never equal to the real target', () => {
  // These inputs are GitHub-remote-shaped and so parse successfully, but the
  // resulting owner/repo must never equal the legitimate {owner: 'owner',
  // repo: 'repo'} pair a spoof is impersonating — detectBunLink's caller
  // compares the parsed result against the expected pair with `===`, so any
  // of these must fail that comparison.
  const REAL = { owner: 'owner', repo: 'repo' };

  test('owner prefix spoof (evil-owner/repo)', () => {
    const parsed = parseGithubRemoteOwnerRepo('https://github.com/evil-owner/repo.git');
    expect(parsed).not.toEqual(null);
    expect(parsed).not.toEqual(REAL);
  });
  test('repo suffix spoof (owner/repo-mirror)', () => {
    const parsed = parseGithubRemoteOwnerRepo('https://github.com/owner/repo-mirror.git');
    expect(parsed).not.toEqual(null);
    expect(parsed).not.toEqual(REAL);
  });
  test('repo suffix spoof without .git', () => {
    const parsed = parseGithubRemoteOwnerRepo('https://github.com/owner/repo-mirror');
    expect(parsed).not.toEqual(null);
    expect(parsed).not.toEqual(REAL);
  });
  test('owner suffix spoof, no separator (ownerrepo/repo)', () => {
    const parsed = parseGithubRemoteOwnerRepo('https://github.com/ownerrepo/repo');
    expect(parsed).not.toEqual(null);
    expect(parsed).not.toEqual(REAL);
  });
  test('query-string spoof (owner/repo?ref=evil) never parses to the bare repo name', () => {
    const parsed = parseGithubRemoteOwnerRepo('https://github.com/owner/repo?ref=evil');
    expect(parsed).not.toEqual(null);
    expect(parsed).not.toEqual(REAL);
  });
});

describe('extractGitConfigRemoteUrls — line-oriented INI section tracking', () => {
  test('extracts url= only from [remote "NAME"] sections, in file order', () => {
    const cfg = [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = https://github.com/owner/repo.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[remote "upstream"]',
      '\turl = git@github.com:owner2/repo2.git',
      '[branch "main"]',
      '\turl = https://github.com/should-not-be-extracted/repo.git',
    ].join('\n');
    expect(extractGitConfigRemoteUrls(cfg)).toEqual([
      'https://github.com/owner/repo.git',
      'git@github.com:owner2/repo2.git',
    ]);
  });

  test('a url= line outside any [remote] section is ignored', () => {
    const cfg = ['[core]', 'url = https://github.com/owner/repo.git'].join('\n');
    expect(extractGitConfigRemoteUrls(cfg)).toEqual([]);
  });

  test('empty config text extracts nothing', () => {
    expect(extractGitConfigRemoteUrls('')).toEqual([]);
  });

  test('a [remote "x"] section with no url= line contributes nothing', () => {
    const cfg = ['[remote "origin"]', 'fetch = +refs/heads/*:refs/remotes/origin/*'].join('\n');
    expect(extractGitConfigRemoteUrls(cfg)).toEqual([]);
  });
});

describe('parseGithubRemoteOwnerRepo + extractGitConfigRemoteUrls — end-to-end exact-match simulation', () => {
  // Mirrors the actual comparison detectBunLink performs: parse every
  // extracted remote URL and require an EXACT (case-insensitive) owner+repo
  // match against the expected pin, never a substring/partial one.
  function matchesExpected(configText: string, expectedOwner: string, expectedRepo: string): boolean {
    for (const url of extractGitConfigRemoteUrls(configText)) {
      const parsed = parseGithubRemoteOwnerRepo(url);
      if (
        parsed &&
        parsed.owner.toLowerCase() === expectedOwner.toLowerCase() &&
        parsed.repo.toLowerCase() === expectedRepo.toLowerCase()
      ) {
        return true;
      }
    }
    return false;
  }

  test('genuine clone of the expected owner/repo matches', () => {
    const cfg = '[remote "origin"]\nurl = https://github.com/reza-rahimi-ca/gbrain.git\n';
    expect(matchesExpected(cfg, 'reza-rahimi-ca', 'gbrain')).toBe(true);
  });

  test('a clone of an unrelated fork with the expected repo name as a SUFFIX does not match', () => {
    const cfg = '[remote "origin"]\nurl = https://github.com/some-other-owner/evil-gbrain.git\n';
    expect(matchesExpected(cfg, 'reza-rahimi-ca', 'gbrain')).toBe(false);
  });

  test('a clone whose remote embeds the expected owner/repo as a path prefix does not match', () => {
    const cfg = '[remote "origin"]\nurl = https://github.com/reza-rahimi-ca/gbrain/wiki\n';
    expect(matchesExpected(cfg, 'reza-rahimi-ca', 'gbrain')).toBe(false);
  });

  test('a clone pointed at upstream does not satisfy a pinned-fork expectation', () => {
    const cfg = '[remote "origin"]\nurl = https://github.com/garrytan/gbrain.git\n';
    expect(matchesExpected(cfg, 'reza-rahimi-ca', 'gbrain')).toBe(false);
  });
});
