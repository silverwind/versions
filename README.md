# versions
[![](https://img.shields.io/npm/v/versions.svg?style=flat)](https://www.npmjs.org/package/versions) [![](https://img.shields.io/npm/dm/versions.svg)](https://www.npmjs.org/package/versions) [![](https://packagephobia.com/badge?p=versions)](https://packagephobia.com/result?p=versions) [![](https://depx.co/api/badge/versions)](https://depx.co/pkg/versions)

> CLI to flexibly increment a project's version

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
    -v, --version         Print the version
    -h, --help            Print this help

  The message and replacement strings accept tokens _VER_, _MAJOR_, _MINOR_, _PATCH_.

  Examples:
    $ versions patch
    $ versions -c 'npm run build' -m 'Release _VER_' minor file.css
    $ versions prerelease --preid=alpha package.json
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

## CI environments

CI environments usually do incomplete git checkouts without tags. Fetch tags first:

```bash
git fetch --tags --force
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
