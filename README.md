# versions
[![](https://img.shields.io/npm/v/versions.svg?style=flat)](https://www.npmjs.org/package/versions) [![](https://img.shields.io/npm/dm/versions.svg)](https://www.npmjs.org/package/versions) [![](https://packagephobia.com/badge?p=versions)](https://packagephobia.com/result?p=versions) [![](https://depx.co/api/badge/versions)](https://depx.co/pkg/versions)

> Release automation: bump the version, commit, tag, push and create a GitHub or Gitea release

The current version comes from the latest git tag. Files given on the command line get the new version written into them, release notes come from `CHANGELOG.md`.

## Usage

```bash
pnpm i -D versions
pnpm exec versions --release --prefix patch  # tag-only, e.g. a Go module
pnpm exec versions patch package.json        # Node
pnpm exec versions patch pyproject.toml      # Python
```

Each run commits, creates an annotated tag and pushes both atomically. With nothing to commit, the release commit is empty unless `--skip-empty` is passed.

## Options
```
usage: versions [options] patch|minor|major|prerelease [files...]

  Options:
    -a, --all             Add all tracked changes to the commit
    -e, --skip-empty      Skip the release commit when nothing needs committing, only tag
    -b, --base <version>  Base version. Default is from latest semver git tag, package.json, pyproject.toml, or 0.0.0
    -p, --prefix          Prefix tag name with a "v" character. Default is none
    -c, --command <cmd>   Run command after files are updated but before git commit and tag
    -d, --date            Replace dates in format YYYY-MM-DD with current date
    -i, --preid <id>      Prerelease identifier, e.g., alpha, beta, rc
    -m, --message <str>   Custom tag and commit message
    -N, --notes <file>    Read changelog from file, "-" for stdin. Default is CHANGELOG.md or git log
    -r, --replace <str>   Additional replacements in the format "s#regexp#replacement#flags"
    -g, --gitless         Do not perform any git action like creating commit and tag
    -D, --dry             Change nothing, just print what would be done
    -R, --release         Create a GitHub or Gitea release with the changelog as body
    -L, --login <host>    Verify and store a forge API token
    -O, --logout <host>   Remove a stored forge API token
    -n, --no-push         Skip pushing HEAD and the tag
    -o, --remote <name>   Git remote to push to. Default is "origin"
    -B, --branch <name>   Remote branch to push HEAD to. Default is the current branch
    -V, --verbose         Print verbose output to stderr
    -v, --version         Print the version
    -h, --help            Print this help

  The message and replacement strings accept tokens _VER_, _MAJOR_, _MINOR_, _PATCH_.

  Unless --gitless, at least one given file must change.

  Examples:
    $ versions patch
    $ versions patch package.json
    $ versions prerelease --preid=alpha package.json
    $ versions -c 'npm run build' -m 'Release _VER_' minor file.css
```

## Changelog

The `CHANGELOG.md` entry for the new version becomes the commit message, tag annotation and release body. The file is looked up from the current directory up to the repository root, and headings like `# 1.2.3`, `## v1.2.3` or `## [1.2.3] - 2024-01-15` match. An undated heading, or one with a placeholder like `YYYY-MM-DD`, gets today's date and is committed with the release. Without a matching entry, a `git log` summary is used.

## Releases

`--release` creates a GitHub or Gitea release for the pushed tag, detecting the forge from the remote URL. Its body is the tag annotation without the tag name and `--message` lines, or the tag name if nothing remains. It needs the push, so `--no-push` and `--gitless` are rejected.

### API tokens

`versions --login <host>` stores a token read from stdin or a prompt, `versions --logout <host>` removes it.

`VERSIONS_FORGE_TOKENS` holds comma-separated `host:token` pairs like `git.example.com:tok1,localhost:3000:tok2`, and a matching host uses only that token. The host must match the remote exactly, port included, so a ported instance needs an https remote. An `ssh://` remote's port is not part of the host. Otherwise these are tried in order:

1. The stored token
1. For `github.com`: `VERSIONS_GITHUB_API_TOKEN`, `GITHUB_API_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `HOMEBREW_GITHUB_API_TOKEN`
1. For the Gitea or Forgejo instance in `GITEA_URL`: `VERSIONS_GITEA_API_TOKEN`, `GITEA_API_TOKEN`, `GITEA_AUTH_TOKEN`, `GITEA_TOKEN`, `FORGEJO_TOKEN`
1. The CI job token `actions/checkout` leaves in git config, only against the forge that issued it

## CI

Checkouts often lack tags, so run `git fetch --tags --force` first. On GitHub, Gitea and Forgejo Actions, `--release` then works with the job token alone. It needs `permissions: contents: write` on GitHub and `releases: write` on Gitea, and its releases trigger no `release` workflows.

## Lockfiles

A `package.json` with a `packageManager` pin gets its lockfile committed with it. `package-lock.json` also gets the new version, other lockfiles stay untouched. In `pyproject.toml`, the `[project]` and `[tool.poetry]` versions are updated. Pass `uv.lock` explicitly to bump its package entry, which needs the `pyproject.toml` next to it.

## Signing

To GPG-sign commits and tags, add to `~/.gitconfig`:

```ini
[user]
  signingkey = <keyid>
[commit]
  gpgSign = true
[tag]
  forceSignAnnotated = true
[push]
  gpgSign = if-asked
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
