'use strict';

const {session} = require('electron');

const FILTER = {urls: ['https://web.fluxer.app/api/v1/channels/*/typing']};

let _enabled = false;

module.exports = {
	name: 'invisibleTyping',
	displayName: 'Invisible Typing',
	description: 'Prevents Fluxer from sending typing indicators to other users.',
	icon: '👻',
	rendererSrc: null,

	start() {
		_enabled = true;
		session.defaultSession.webRequest.onBeforeRequest(FILTER, (details, callback) => {
			callback({cancel: _enabled});
		});
	},

	stop() {
		_enabled = false;
		session.defaultSession.webRequest.onBeforeRequest(FILTER, null);
	},
};
