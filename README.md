# ver
[![](https://img.shields.io/npm/v/ver.svg?style=flat)](https://www.npmjs.org/package/ver) [![](https://img.shields.io/npm/dm/ver.svg)](https://www.npmjs.org/package/ver) [![](https://api.travis-ci.org/silverwind/ver.svg?style=flat)](https://travis-ci.org/silverwind/ver)

> Semantically increment a project's version in multiple files

## Installation
```
npm i -g ver
```

## Usage
```
usage: ver [options] command [files...]

  Semantically increment a project's version in multiple files.

  Commands:
    patch                    Increment patch 0.0.x version
    minor                    Increment minor 0.x.0 version
    major                    Increment major x.0.0 version

  Arguments:
   files                     Files to handle. Default is the nearest package.json which if
                             present, will always be included.
  Options:
    -b, --base <version>     Base version to use. Default is parsed from the nearest package.json
    -c, --command <command>  Run a command after files are updated but before git commit and tag
    -d, --date [<date>]      Replace dates in format YYYY-MM-DD with current or given date
    -r, --replace <str>      Additional replacement in the format "s#regexp#replacement#flags"
    -g, --gitless            Do not create a git commit and tag
    -p, --prefix             Prefix git tags with a "v" character
    -v, --version            Print the version
    -h, --help               Print this help

  Examples:
    $ ver patch
    $ ver -g minor build.js
    $ ver -p major build.js
    $ ver patch -c 'npm run build'
```

## Signing commits and tags

To automatically sign commits and tags created by `ver` with GPG add this to your `~/.gitconfig`:

``` ini
[user]
  signingkey = <keyid>
[commit]
  gpgsign = true
[tag]
  forceSignAnnotated = true
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
