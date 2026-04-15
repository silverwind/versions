# versions
[![](https://img.shields.io/npm/v/versions.svg?style=flat)](https://www.npmjs.org/package/versions) [![](https://img.shields.io/npm/dm/versions.svg)](https://www.npmjs.org/package/versions) [![](https://packagephobia.com/badge?p=versions)](https://packagephobia.com/result?p=versions) [![](https://depx.co/api/badge/versions)](https://depx.co/pkg/versions)

>  CLI to increment a project's version and optionally publish release to Github/Gitea

## Usage

To increment patch version of current project:

```bash
npx versions patch
```

## Options
```
usage: versions [options] patch|minor|major|prerelease [files...]

  Options:
    -a, --all             Add all changed files to the commit
    -b, --base <version>  Base version. Default is from latest git tag or 0.0.0
    -p, --prefix          Prefix version string with a "v" character. Default is none
    -c, --command <cmd>   Run command after files are updated but before git commit and tag
    -d, --date [<date>]   Replace dates in format YYYY-MM-DD with current or given date
    -i, --preid <id>      Prerelease identifier, e.g., alpha, beta, rc
    -m, --message <str>   Custom tag and commit message
    -r, --replace <str>   Additional replacements in the format "s#regexp#replacement#flags"
    -g, --gitless         Do not perform any git action like creating commit and tag
    -D, --dry             Do not create a tag or commit, just print what would be done
    -R, --release         Create a GitHub or Gitea release with the changelog as body
    -n, --no-push         Skip pushing commit and tag
    -o, --remote <name>   Git remote to push to. Default is "origin"
    -B, --branch <name>   Git branch to push. Default is the current branch
    -V, --verbose         Print verbose output to stderr
    -v, --version         Print the version
    -h, --help            Print this help

  The message and replacement strings accept tokens _VER_, _MAJOR_, _MINOR_, _PATCH_.

  Examples:
    $ versions patch
    $ versions prerelease --preid=alpha
    $ versions -c 'npm run build' -m 'Release _VER_' minor file.css
```

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

## Pushing

By default, `versions` pushes the commit and tag to `origin` after creating them. Pass `--no-push` to skip the push and keep changes local. Use `--remote` and `--branch` to override the target remote and branch.

## Creating releases

When using the `--release` option, `versions` will automatically create a GitHub or Gitea release after pushing the tag. The release body will contain the same changelog as the commit message. `--release` requires the push and is incompatible with `--no-push`.

The tool will automatically detect whether you're using GitHub or Gitea based on your git remote URL.

### API Tokens

For GitHub releases, provide an API token via one of these environment variables (in priority order):
- `VERSIONS_FORGE_TOKEN`
- `GITHUB_API_TOKEN`
- `GITHUB_TOKEN`
- `GH_TOKEN`
- `HOMEBREW_GITHUB_API_TOKEN`

For Gitea releases, provide an API token via one of these environment variables (in priority order):
- `VERSIONS_FORGE_TOKEN`
- `GITEA_API_TOKEN`
- `GITEA_AUTH_TOKEN`
- `GITEA_TOKEN`

Example:
```bash
export GITHUB_TOKEN=ghp_your_token_here
versions --release patch
```

## CI environments

CI environments usually do incomplete git checkouts without tags. Fetch tags first:

```bash
git fetch --tags --force
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
