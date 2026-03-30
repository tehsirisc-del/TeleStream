const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'catalog.db'));

const eps = db.prepare('SELECT id, message_id, channel, file_name, episode_number FROM episodes WHERE file_name LIKE ?').all('%S2E41%');
console.log('--- Episode 41 matches ---');
eps.forEach(e => {
  console.log(JSON.stringify(e, null, 2));
});
