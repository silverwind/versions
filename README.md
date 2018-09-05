# ver
[![](https://img.shields.io/npm/v/ver.svg?style=flat)](https://www.npmjs.org/package/ver) [![](https://img.shields.io/npm/dm/ver.svg)](https://www.npmjs.org/package/ver) [![](https://api.travis-ci.org/silverwind/ver.svg?style=flat)](https://travis-ci.org/silverwind/ver)

> CLI to increment semantic versions in your project

Intended for projects with a package.json, but works with any other text-based files too. Will also create a git commit and tag by default.

## Installation
```
npm i ver
```

## Usage
```
usage: ver [options] command [files...]

  Increment semantic versions across your project. Intended for projects with a package.json, but
  works with any other text-based files too. Will also create a git commit and tag by default.

  Commands:
    patch                   Increment patch 0.0.x version
    minor                   Increment minor 0.x.0 version
    major                   Increment major x.0.0 version

  Arguments:
    files                   Files to replace the version in. Default is the nearest package.json

  Options:
    -b, --base <version>    Base version to use. Default is from the nearest package.json
    -r, --replace <str>     Additional replacement in the format s#regexp#replacement#flags
    -g, --gitless           Do not create a git commit and tag
    -c, --color             Force-enable color output
    -n, --no-color          Disable color output
    -v, --version           Print the version
    -h, --help              Print this help

  Examples:
    $ ver patch
    $ ver patch build.js
    $ ver minor build.js -r "s#[0-9]{4}-[0-9]{2}-[0-9]{2}#$(date +%Y-%m-%d)#g"
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
