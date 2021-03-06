/* push-pull-window.js */
'use strict';
var Writable = require('stream').Writable,
    debug = require('debug')('push-pull-window'),
    WebMByteStream = require('webm-byte-stream'),
    Encoder = require('./encoder.js');

function PushPullWindow(options) {

  var self = this;
  options = options || {};
  Writable.call(self, {});

  var durations = options.durations || false;
  if (typeof durations !== 'boolean') {
    throw new Error('durations must be a boolean value (' + durations + ')');
  }

  var bitrate = options.bitrate;
  if (typeof bitrate !== 'number' || bitrate < 1) {
    throw new Error('bitrate must be a positive number (' + bitrate + ')');
  }

  self._tc = [];
  self._window = {};
  self._pushQueue = [];
  self._encoder = new Encoder();
  self._webmstream = new WebMByteStream({durations: durations});

  // get byte stream ready for datachannel
  var lastTime = new Date().getTime();
  self._webmstream.on('Initialization Segment', function(data) {
    self._pushInitSegment(data, lastTime); // TODO
  });
  self._webmstream.on('Media Segment', function(data) {
    lastTime = new Date().getTime();
    self._pushMediaSegment(data, lastTime);
  });

  // push media segment chunks to gateway
  var messagesPerSec = (bitrate*1024)/self._encoder._maxChunkSize;
  setInterval(function() {
    var chunk = self._pushQueue.shift();
    if (chunk) {
      self.emit('Media Segment Chunk', chunk);
    }
  }, 1000/messagesPerSec);
  debug('Pushes ' + messagesPerSec + ' messages per second');
 
}

require('util').inherits(PushPullWindow, Writable);
PushPullWindow.prototype._write = function(data, enc, done) {
  var self = this;
  self._webmstream.write(data);
  done();
};

PushPullWindow.prototype._pushInitSegment = function(data, timecode) {
  var self = this;

  debug('Pushing initialization segment: ' + data.length + ' bytes');
  if (data.length > self._encoder._maxInitSegPayload) {
    throw new Error('Initialization Segment is too large: '
      + data.length + ' bytes');
  }
  // build empty message
  var message = self._encoder.getEmptyInitSegMessage({
    timecode: timecode,
    payloadSize: data.length
  });
  // write payload
  var payloadView = new Uint8Array(message.data, message.start);
  for (var ii = 0; ii < data.length; ii++) {
    payloadView[ii] = data[ii];
  }
  // push initialization segment
  self.emit('Initialization Segment', message.data);

};

PushPullWindow.prototype._pushMediaSegment = function(data, timecode) {
  var self = this;

  var cluster = data.cluster,
      duration = data.duration,
      numChunks = Math.ceil(cluster.length / self._encoder._maxChunkPayload),
      maxChunkPayload = self._encoder._maxChunkPayload,
      maxChunksPerMessage = self._encoder._maxChunksPerMessage;

  debug('Pushing media segment: timecode=' + timecode + ', duration='
    + ((duration < 0) ? 'unknown' : (duration + 'ms')) + ', chunks='
    + numChunks);

  if (numChunks > maxChunksPerMessage) {
    throw new Error('Media Segment is too large: ' + numChunks
      + ' chunks greater than max ' + maxChunksPerMessage);
  }

  // window contains previous and current media segment
  self._tc.push(timecode);
  self._window[timecode] = [];
  if (self._tc.length > 2) {
    var tc = self._tc.shift();
    delete self._window[tc];
  }

  // split the media segment into chunks
  var start = 0;
  var finalIndex = numChunks - 1;
  for (var chunk = 0; chunk < numChunks; chunk++) {
    // calculate payload size
    var payloadSize = ((cluster.length - start) > maxChunkPayload)
      ? maxChunkPayload : (cluster.length - start);
    // build empty message
    var message = self._encoder.getEmptyChunkMessage({
      timecode: timecode,
      chunkIndex: chunk,
      finalIndex: finalIndex,
      duration: duration,
      payloadSize: payloadSize
    });
    // write payload
    var payloadView = new Uint8Array(message.data, message.start);
    for (var ii = 0; ii < payloadSize; ii++) {
      payloadView[ii] = cluster[start + ii];
    }
    start += payloadSize;
    // push chunk into queue
    self._pushQueue.push(message.data);
    self._window[timecode].push(message.data);
  }

};

PushPullWindow.prototype.pullChunk = function(timecode, chunkIndex) {
  var self = this;

  if (timecode in self._window) {
    return self._window[timecode][chunkIndex];
  } else {
    return null;
  }

};

module.exports = PushPullWindow;
