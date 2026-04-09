// GramJS browser build entry point
const telegram = require('telegram');
const sessions = require('telegram/sessions');
const bigInt = require('big-integer');

// Make bigInt available globally for channel ID handling
window.bigInt = bigInt;

// Export telegram module
module.exports = { ...telegram, sessions, bigInt };
