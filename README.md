# versions
[![](https://img.shields.io/npm/v/versions.svg?style=flat)](https://www.npmjs.org/package/versions) [![](https://img.shields.io/npm/dm/versions.svg)](https://www.npmjs.org/package/versions)

> CLI to flexibly increment a project's version

## Installation
```
npm i -D versions
npx versions --help
```

## Usage
```
usage: versions [options] patch|minor|major [files...]

  Semantically increment a project's version in multiple files.

  Arguments:
   files                  Files to do version replacement in. The nearest package.json and
                          package-lock.json will always be included unless the -P argument is given
  Options:
    -a, --all             Add all changed files to the commit instead of only the ones currently modified
    -b, --base <version>  Base version to use. Default is parsed from the nearest package.json
    -C, --changelog       Generate a changelog since the base version tag or if absent, the latest tag
    -c, --command <cmd>   Run a command after files are updated but before git commit and tag
    -d, --date [<date>]   Replace dates in format YYYY-MM-DD with current or given date
    -m, --message <str>   Custom tag and commit message. Token _VER_ is available to fill the new version
    -p, --prefix          Prefix git tags with a "v" character
    -r, --replace <str>   Additional replacement in the format "s#regexp#replacement#flags"
    -g, --gitless         Do not perform any git action like creating commit and tag
    -G, --globless        Do not process globs in the file arguments
    -P, --packageless     Do not include package.json and package-lock.json unless explicitely given
    -v, --version         Print the version
    -h, --help            Print this help

  Examples:
    $ versions patch
    $ versions -Cc 'npm run build' -m 'Release _VER_' minor file.css
```

## Signing commits and tags

To automatically sign commits and tags created by `versions` with GPG add this to your `~/.gitconfig`:

```ini
[user]
  signingkey = <keyid>
[commit]
  gpgsign = true
[tag]
  forceSignAnnotated = true
```

## CI environments

CI environments usually only do shallow git checkouts which are insuficient for the `--changelog` argument to work. To fix this, unshallow the repository first:

```bash
git fetch --unshallow --quiet --tags
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
