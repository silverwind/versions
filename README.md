# versions
[![](https://img.shields.io/npm/v/versions.svg?style=flat)](https://www.npmjs.org/package/versions) [![](https://img.shields.io/npm/dm/versions.svg)](https://www.npmjs.org/package/versions) [![](https://packagephobia.com/badge?p=versions)](https://packagephobia.com/result?p=versions) [![](https://depx.co/api/badge/versions)](https://depx.co/pkg/versions)

> CLI to release a project: bump the version, commit, tag, push, and create a GitHub or Gitea release

## Usage

To release a patch version of the current project:

```bash
npx versions patch package.json
```

This bumps `package.json` to the next patch version, commits it, creates an annotated tag, and pushes both to `origin` atomically. Add `--release` to also create the GitHub or Gitea release.

With no files given, the commit and tag are still created, and a matching undated `CHANGELOG.md` entry is updated and committed with them.

## Options
```
usage: versions [options] patch|minor|major|prerelease [files...]

  Options:
    -a, --all             Add all tracked changes to the commit
    -b, --base <version>  Base version. Default is from latest semver git tag, package.json, pyproject.toml, or 0.0.0
    -p, --prefix          Prefix tag name with a "v" character. Default is none
    -c, --command <cmd>   Run command after files are updated but before git commit and tag
    -d, --date            Replace dates in format YYYY-MM-DD with current date
    -i, --preid <id>      Prerelease identifier, e.g., alpha, beta, rc
    -m, --message <str>   Custom tag and commit message
    -r, --replace <str>   Additional replacements in the format "s#regexp#replacement#flags"
    -g, --gitless         Do not perform any git action like creating commit and tag
    -D, --dry             Change nothing, just print what would be done
    -R, --release         Create a GitHub or Gitea release with the changelog as body
    -L, --login <host>    Verify and store a forge API token
    -O, --logout <host>   Remove a stored forge API token
    -n, --no-push         Skip pushing commit and tag
    -o, --remote <name>   Git remote to push to. Default is "origin"
    -B, --branch <name>   Remote branch to push HEAD to. Default is the current branch
    -V, --verbose         Print verbose output to stderr
    -v, --version         Print the version
    -h, --help            Print this help

  The message and replacement strings accept tokens _VER_, _MAJOR_, _MINOR_, _PATCH_.

  Unless --gitless, at least one given file must change.

  Examples:
    $ versions patch package.json
    $ versions prerelease --preid=alpha package.json
    $ versions -c 'npm run build' -m 'Release _VER_' minor file.css
```

## Lockfiles

When a `package.json` with a `packageManager` pin changes, its lockfile joins the same commit. A `package-lock.json` also gets the new version, other lockfiles are committed untouched.

In a `pyproject.toml` the version is read and written in `[project]` and `[tool.poetry]`. A `uv.lock` is not picked up automatically, name it as a file to get its own package entry bumped, which requires the `pyproject.toml` next to it.

## Signing commits and tags

To automatically sign commits and tags created by `versions` with GPG add this to your `~/.gitconfig`:

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

## Changelog

If a `CHANGELOG.md` is present in the current directory or any directory above it up to the repository root, and it has a heading for the new version, its body is used as the commit message, tag annotation, and release body. Heading matching is lenient — `# 1.2.3`, `## v1.2.3`, `## [1.2.3]`, `## [1.2.3] - 2024-01-15`, `## 1.2.3 (YYYY-MM-DD)` all work. If the heading has no date or a placeholder (`YYYY-MM-DD`, `xxxx-xx-xx`, etc.), it gets rewritten to today's date and included in the commit. With no matching entry, the tool falls back to a `git log` summary.

## Creating releases

`--release` creates a GitHub or Gitea release after pushing the tag, with the forge detected from the git remote URL. The body is the changelog entry or `git log` summary the commit message carries, without the leading tag name line and any `--message` strings, or just the tag name if there is neither. It requires the push, so it is incompatible with `--no-push` and `--gitless`.

### API Tokens

`versions --login <host>` reads a token from stdin or a prompt and stores it for that forge,
`versions --logout <host>` removes it. `VERSIONS_FORGE_TOKENS` wins over a stored token, which wins
over the environment variables below.

`VERSIONS_FORGE_TOKENS` holds comma-separated `host:token` pairs whose host must match the remote
exactly, port included, so a ported instance needs an https remote. An `ssh://` remote's port is
transport-only and never part of the host, so key its token to the bare host:

```bash
export VERSIONS_FORGE_TOKENS="git.example.com:tok_xxx,localhost:3000:tok_yyy"
```

Otherwise every one of these that is set is tried in order, only ever against `github.com`:
- `VERSIONS_GITHUB_API_TOKEN`
- `GITHUB_API_TOKEN`
- `GH_TOKEN`
- `GITHUB_TOKEN`
- `HOMEBREW_GITHUB_API_TOKEN`

The same for Gitea and Forgejo, only ever against the instance named by `GITEA_URL`. The names
do not say which instance they belong to, so without a matching `GITEA_URL` they go unused:
- `VERSIONS_GITEA_API_TOKEN`
- `GITEA_API_TOKEN`
- `GITEA_AUTH_TOKEN`
- `GITEA_TOKEN`
- `FORGEJO_TOKEN`

```bash
export GITEA_URL=https://git.example.com
export GITEA_TOKEN=tok_xxx
versions --release patch package.json
```

## CI environments

CI environments usually do incomplete git checkouts without tags. Fetch tags first:

```bash
git fetch --tags --force
```

`--release` needs no token wired up on GitHub, Gitea or Forgejo Actions. `actions/checkout`
leaves the job token in git config as `http.<origin>/.extraheader`, and `versions` reads it back
for that host as a last resort, so it is only ever returned to the forge that issued it. Needs
`permissions: contents: write` on GitHub and `releases: write` on Gitea. A release created with
the job token triggers no `release` workflows.

© [silverwind](https://github.com/silverwind), distributed under BSD licence
