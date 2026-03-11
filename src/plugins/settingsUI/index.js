/**
 * src/plugins/settingsUI/index.js
 *
 * Main-process stub for the Reflux Settings UI plugin.
 * All real work happens in renderer-side.js, which injects a "Reflux"
 * section into Fluxer's settings sidebar and renders the plugins panel.
 */

'use strict';

const path = require('node:path');

module.exports = {
  name:        'settingsUI',
  description: 'Adds a Reflux section to the Fluxer settings sidebar with plugin management.',
  rendererSrc: path.join(__dirname, 'renderer-side.js'),
  start() {},
  stop()  {},
};
