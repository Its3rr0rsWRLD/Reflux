'use strict';

const path = require('node:path');

function start() {
  console.log('[Reflux:MessageLogger] Started (renderer script will be injected).');
}

function stop() {
  console.log('[Reflux:MessageLogger] Stopped.');
}

module.exports = {
  name:        'messageLogger',
  displayName: 'Message Logger',
  description: 'Intercepts deleted messages from the gateway and shows them greyed-out inline.',
  rendererSrc: path.join(__dirname, 'renderer-side.js'),
  start,
  stop,
};
