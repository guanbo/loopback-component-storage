var IncomingForm = require('formidable');
var StringDecoder = require('string_decoder').StringDecoder;

var defaultOptions = {
  maxFileSize: 10 * 1024 * 1024 // 10 MB
};

/**
 * Handle multipart/form-data upload to the storage service
 * @param {Object} provider The storage service provider
 * @param {Request} req The HTTP request
 * @param {Response} res The HTTP response
 * @param {Object} [options] The container name
 * @callback {Function} cb Callback function
 * @header storageService.upload(provider, req, res, options, cb) 
 */
exports.upload = function (provider, req, res, options, cb) {
  if (!cb && 'function' === typeof options) {
    cb = options;
    options = {};
  }

  if (!options.maxFileSize) {
    options.maxFileSize = defaultOptions.maxFileSize;
  }

  var form = new IncomingForm(options);
  container = options.container || req.params.container;
  var fields = {}, files = {};
  form.handlePart = function (part) {
    var self = this;

    if (part.filename === undefined) {
      var value = ''
        , decoder = new StringDecoder(this.encoding);

      part.on('data', function (buffer) {
        self._fieldsSize += buffer.length;
        if (self._fieldsSize > self.maxFieldsSize) {
          self._error(new Error('maxFieldsSize exceeded, received ' + self._fieldsSize + ' bytes of field data'));
          return;
        }
        value += decoder.write(buffer);
      });

      part.on('end', function () {
        var values = fields[part.name];
        if (values === undefined) {
          values = [value];
          fields[part.name] = values;
        } else {
          values.push(value);
        }
        self.emit('field', part.name, value);
      });
      return;
    }

    this._flushing++;

    var file = {
      container: container,
      name: part.filename,
      type: part.mime
    };

    // Options for this file

    // Build a filename
    if ('function' === typeof options.getFilename) {
      file.name = options.getFilename(file, req, res);
    }

    // Get allowed mime types
    if (options.allowedContentTypes) {
      var allowedContentTypes;
      if ('function' === typeof options.allowedContentTypes) {
        allowedContentTypes = options.allowedContentTypes(file, req, res);
      } else {
        allowedContentTypes = options.allowedContentTypes;
      }
      if (Array.isArray(allowedContentTypes) && allowedContentTypes.length !== 0) {
        if (allowedContentTypes.indexOf(file.type) === -1) {
          self._error(new Error('contentType "' + file.type + '" is not allowed (Must be in [' + allowedContentTypes.join(', ') + '])'));
          return;
        }
      }
    }

    // Get max file size
    var maxFileSize;
    if (options.maxFileSize) {
      if ('function' === typeof options.maxFileSize) {
        maxFileSize = options.maxFileSize(file, req, res);
      } else {
        maxFileSize = options.maxFileSize;
      }
    }

    // Get access control list
    if (options.acl) {
      if ('function' === typeof options.acl) {
        file.acl = options.acl(file, req, res);
      } else {
        file.acl = options.acl;
      }
    }

    self.emit('fileBegin', part.name, file);

    var uploadParams = {container: container, remote: file.name, contentType: file.type};
    if (file.acl) {
      uploadParams.acl = file.acl;
    }
    var writer = provider.upload(uploadParams);

    writer.on('error', function(err) {
      self._error(err);
    });

    var endFunc = function () {
      self._flushing--;
      var values = files[part.name];
      if (values === undefined) {
        values = [file];
        files[part.name] = values;
      } else {
        values.push(file);
      }
      self.emit('file', part.name, file);
      self._maybeEnd();
    };

    var fileSize = 0;
    if (maxFileSize) {
      part.on('data', function (buffer) {
        fileSize += buffer.length;
        file.size = fileSize;
        if (fileSize > maxFileSize) {
          // We are missing some way to tell the provider to cancel upload/multipart upload of the current file.
          // - s3-upload-stream doesn't provide a way to do this in it's public interface
          // - We could call provider.delete file but it would not delete multipart data 
          self._error(new Error('maxFileSize exceeded, received ' + fileSize + ' bytes of field data (max is ' + maxFileSize + ')'));
          return;
        }
      });
    }

    part.pipe(writer, { end: false });
    part.on("end", function () {
      writer.end();
      endFunc();
    });
  };

  form.parse(req, function (err, _fields, _files) {
    if (err) {
      console.error(err);
    }
    cb && cb(err, {files: files, fields: fields});
  });
}

/**
 * Handle download from a container/file.
 * @param {Object} provider The storage service provider
 * @param {Request} req The HTTP request
 * @param {Response} res The HTTP response
 * @param {String} container The container name
 * @param {String} file The file name
 * @callback {Function} cb Callback function.
 * @header storageService.download(provider, req, res, container, file, cb) 
 */
exports.download = function (provider, req, res, container, file, cb) {
  var reader = provider.download({
    container: container || req && req.params.container,
    remote: file || req && req.params.file
  });

  res.type(file);
  reader.pipe(res);
  reader.on('error', function (err) {
    if (err.code === 'ENOENT') {
      res.type('application/json');
      res.status(404).send({ error: err });
      return;
    }

    res.type('application/json');
    res.status(500).send({ error: err });
  });
}




