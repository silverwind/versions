# ver
[![](https://img.shields.io/npm/v/ver.svg?style=flat)](https://www.npmjs.org/package/ver) [![](https://img.shields.io/npm/dm/ver.svg)](https://www.npmjs.org/package/ver) [![](https://api.travis-ci.org/silverwind/ver.svg?style=flat)](https://travis-ci.org/silverwind/ver)

> CLI to semantically increment the version in given files and package.json

## Installation
```
npm i ver
```

## Usage
```
usage: ver [options] command [files...]

  Semantically increment the version in given files and package.json, if present. Will create
  a git commit and tag by default. By default, only the nearest package.json file is modified.

  Commands:
    patch                   Increment patch 0.0.x version
    minor                   Increment minor 0.x.0 version
    major                   Increment major x.0.0 version

  Options:
    -b, --base <version>    Base version to use. Default is from the nearest package.json
    -r, --replace <str>     Additional replacement in the format "s#regexp#replacement#flags"
    -g, --no-git            Do not create a git commit and tag
    -p, --prefix            Prefix git tags with a "v" character
    -v, --version           Print the version
    -h, --help              Print this help

  Examples:
    $ ver patch
    $ ver patch build.js
```

© [silverwind](https://github.com/silverwind), distributed under BSD licence
