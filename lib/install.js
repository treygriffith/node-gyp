
module.exports = exports = install

exports.usage = 'Install node development files for the specified node version.'

/**
 * Module dependencies.
 */

var fs = require('graceful-fs')
  , tar = require('tar')
  , rm = require('rimraf')
  , path = require('path')
  , zlib = require('zlib')
  , semver = require('semver')
  , fstream = require('fstream')
  , request = require('request')
  , minimatch = require('minimatch')
  , mkdir = require('./util/mkdirp')
  , distUrl = 'http://nodejs.org/dist'
  , win = process.platform == 'win32'

function install (gyp, argv, callback) {

  // ensure no double-callbacks happen
  function cb (err) {
    if (cb.done) return
    cb.done = true
    if (err) {
      gyp.verbose('got an error, rolling back install')
      // roll-back the install if anything went wrong
      gyp.commands.remove([ version ], function (err2) {
        callback(err)
      })
    } else {
      callback(null, version)
    }
  }


  // Determine which node dev files version we are installing
  var versionStr = argv[0] || gyp.opts.target || process.version
  gyp.verbose('input version string', versionStr)

  // parse the version to normalize and ensure it's valid
  var version = semver.parse(versionStr)
  if (!version) {
    return callback(new Error('Invalid version number: ' + versionStr))
  }

  // "legacy" versions are 0.7 and 0.6
  var isLegacy = semver.lt(versionStr, '0.8.0')
  gyp.verbose('installing legacy version?', isLegacy)

  if (semver.lt(versionStr, '0.6.0')) {
    return callback(new Error('Minimum target version is `0.6.0` or greater. Got: ' + versionStr))
  }

  // 0.x.y-pre versions are not published yet. Use previous release.
  if (version[5] === '-pre') {
    version[3] = +version[3] - 1
    version[5] = null
    gyp.verbose('-pre version detected, adjusting patch version')
  }

  // flatten version into String
  version = version.slice(1, 4).join('.')
  gyp.verbose('installing version', version)

  // the directory where the dev files will be installed
  var devDir = path.resolve(gyp.devDir, version)

  // If '--ensure' was passed, then don't *always* install the version;
  // check if it is already installed, and only install when needed
  if (gyp.opts.ensure) {
    gyp.verbose('--ensure was passed, so won\'t reinstall if already installed')
    fs.stat(devDir, function (err, stat) {
      if (err) {
        if (err.code == 'ENOENT') {
          gyp.verbose('version not already installed, continuing with install', version)
          go()
        } else {
          cb(err)
        }
        return
      }
      gyp.verbose('version is already installed, need to check "installVersion"')
      var installVersionFile = path.resolve(devDir, 'installVersion')
      fs.readFile(installVersionFile, 'ascii', function (err, ver) {
        if (err && err.code != 'ENOENT') {
          return cb(err)
        }
        var installVersion = parseInt(ver, 10) || 0
        gyp.verbose('got "installVersion":', installVersion)
        gyp.verbose('needs "installVersion":', gyp.package.installVersion)
        if (installVersion < gyp.package.installVersion) {
          gyp.verbose('version is no good; reinstalling')
          go()
        } else {
          gyp.verbose('version is good')
          cb()
        }
      })
    })
  } else {
    go()
  }

  function download (url, onError) {
    gyp.info('downloading:', url)
    var requestOpts = {
        uri: url
      , onResponse: true
    }

    // basic support for a proxy server
    var proxyUrl = gyp.opts.proxy
                || process.env.http_proxy
                || process.env.HTTP_PROXY
                || process.env.npm_config_proxy
    if (proxyUrl) {
      gyp.verbose('using proxy:', proxyUrl)
      requestOpts.proxy = proxyUrl
    }
    return request(requestOpts, onError)
  }

  function go () {

  // first create the dir for the node dev files
  mkdir(devDir, function (err, created) {
    if (err) return cb(err)

    if (created) {
      gyp.verbose('created:', devDir)
    } else {
      gyp.verbose('directory already existed:', devDir)
    }

    // now download the node tarball
    var tarballUrl = distUrl + '/v' + version + '/node-v' + version + '.tar.gz'
      , badDownload = false
      , extractCount = 0
      , gunzip = zlib.createGunzip()
      , extracter = tar.Extract({ path: devDir, strip: 1, filter: isValid })

    // checks if a file to be extracted from the tarball is valid.
    // only .h header files and the gyp files get extracted
    function isValid () {
      var name = this.path.substring(devDir.length + 1)
        , _valid = valid(name)
      if (name === '' && this.type === 'Directory') {
        // the first directory entry is ok
        return true
      }
      if (_valid) {
        gyp.verbose('extracted file from tarball', name)
        extractCount++
      } else {
        // invalid
      }
      return _valid
    }

    gunzip.on('error', cb)
    extracter.on('error', cb)
    extracter.on('end', afterTarball)

    // download the tarball, gunzip and extract!
    var req = download(tarballUrl, downloadError)
      .pipe(gunzip)
      .pipe(extracter)

    // something went wrong downloading the tarball?
    function downloadError (err, res) {
      if (err || res.statusCode != 200) {
        badDownload = true
        cb(err || new Error(res.statusCode + ' status code downloading tarball'))
      }
    }

    // invoked after the tarball has finished being extracted
    function afterTarball () {
      if (badDownload) return
      if (extractCount === 0) {
        return cb(new Error('There was a fatal problem while downloading/extracting the tarball'))
      }
      gyp.verbose('done parsing tarball')
      var async = 0

      if (isLegacy) {
        // copy over the files from the `legacy` dir
        async++
        copyLegacy(deref)
      }

      if (win) {
        // need to download node.lib
        async++
        downloadNodeLib(deref)
      }

      // write the "installVersion" file
      async++
      var installVersionPath = path.resolve(devDir, 'installVersion')
      fs.writeFile(installVersionPath, gyp.package.installVersion + '\n', deref)

      if (async === 0) {
        // no async tasks required
        cb()
      }

      function deref (err) {
        if (err) return cb(err)
        --async || cb()
      }
    }

    function copyLegacy (done) {
      // legacy versions of node (< 0.8) require the legacy files to be copied
      // over since they contain many bugfixes from the current node build system
      gyp.verbose('copying "legacy" gyp configuration files for version', version)

      var legacyDir = path.resolve(__dirname, '..', 'legacy')
      gyp.verbose('using "legacy" dir', legacyDir)
      gyp.verbose('copying to "dev" dir', devDir)

      var reader = fstream.Reader({ path: legacyDir, type: 'Directory' })
        , writer = fstream.Writer({ path: devDir, type: 'Directory' })

      reader.on('entry', function onEntry (entry) {
        gyp.verbose('reading entry', entry.path)
        entry.on('entry', onEntry)
      })

      reader.on('error', done)
      writer.on('error', done)

      // Like `cp -rpf`
      reader.pipe(writer)

      reader.on('end', done)
    }

    function downloadNodeLib (done) {
      gyp.verbose('on Windows; need to download `node.lib`...')
      var dir32 = path.resolve(devDir, 'ia32')
        , dir64 = path.resolve(devDir, 'x64')
        , nodeLibPath32 = path.resolve(dir32, 'node.lib')
        , nodeLibPath64 = path.resolve(dir64, 'node.lib')
        , nodeLibUrl32 = distUrl + '/v' + version + '/node.lib'
        , nodeLibUrl64 = distUrl + '/v' + version + '/x64/node.lib'

      gyp.verbose('32-bit node.lib dir', dir32)
      gyp.verbose('64-bit node.lib dir', dir64)
      gyp.verbose('`node.lib` 32-bit url', nodeLibUrl32)
      gyp.verbose('`node.lib` 64-bit url', nodeLibUrl64)

      var async = 2
      mkdir(dir32, function (err) {
        if (err) return done(err)
        gyp.verbose('streaming 32-bit node.lib to:', nodeLibPath32)

        var req = download(nodeLibUrl32)
        req.on('error', done)
        req.on('response', function (res) {
          if (res.statusCode !== 200) {
            done(new Error(res.statusCode + ' status code downloading 32-bit node.lib'))
          }
        })
        req.on('end', function () {
          --async || done()
        })

        var ws = fs.createWriteStream(nodeLibPath32)
        ws.on('error', cb)
        req.pipe(ws)
      })
      mkdir(dir64, function (err) {
        if (err) return done(err)
        gyp.verbose('streaming 64-bit node.lib to:', nodeLibPath64)

        var req = download(nodeLibUrl64)
        req.on('error', done)
        req.on('response', function (res) {
          if (res.statusCode !== 200) {
            done(new Error(res.statusCode + ' status code downloading 64-bit node.lib'))
          }
        })
        req.on('end', function () {
          --async || done()
        })

        var ws = fs.createWriteStream(nodeLibPath64)
        ws.on('error', cb)
        req.pipe(ws)
      })
    }


  })

  }

  /**
   * Checks if a given filename is "valid" for this installation.
   */

  function valid (file) {
      // header files
    return minimatch(file, '*.h', { matchBase: true })
      // non-legacy versions of node also extract the gyp build files
      || (!isLegacy &&
            (minimatch(file, '*.gypi', { matchBase: true })
          || minimatch(file, 'tools/gyp_addon')
          || (minimatch(file, 'tools/gyp/**') && !minimatch(file, 'tools/gyp/test/**'))
            )
         )
  }

}


install.trim = function trim (file) {
  var firstSlash = file.indexOf('/')
  return file.substring(firstSlash + 1)
}
