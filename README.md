# versions
[![](https://img.shields.io/npm/v/versions.svg?style=flat)](https://www.npmjs.org/package/versions) [![](https://img.shields.io/npm/dm/versions.svg)](https://www.npmjs.org/package/versions) [![](https://packagephobia.com/badge?p=versions)](https://packagephobia.com/result?p=versions) [![](https://img.shields.io/badge/deno-experimental-yellow)](https://deno.land/)

> CLI to flexibly increment a project's version

## Installation
```
npm i -D versions
npx versions --help
```

## Deno

There is experimental support for deno, run via:

```bash
deno run -A npm:versions
```

## Usage
```
usage: versions [options] patch|minor|major [files...]

  Options:
    -a, --all             Add all changed files to the commit
    -b, --base <version>  Base version. Default is from latest git tag or 0.0.0
    -p, --prefix          Prefix version string with a "v" character. Default is none
    -c, --command <cmd>   Run command after files are updated but before git commit and tag
    -d, --date [<date>]   Replace dates in format YYYY-MM-DD with current or given date
    -m, --message <str>   Custom tag and commit message
    -r, --replace <str>   Additional replacements in the format "s#regexp#replacement#flags"
    -g, --gitless         Do not perform any git action like creating commit and tag
    -v, --version         Print the version
    -h, --help            Print this help

  The message and replacement strings accept tokens _VER_, _MAJOR_, _MINOR_, _PATCH_.

  Examples:
    $ versions patch
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

## CI environments

CI environments usually do shallow git checkout. Unshallow the repository first:

```bash
git fetch --unshallow --quiet --tags
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
