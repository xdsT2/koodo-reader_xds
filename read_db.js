const Database = require('./koodo-app/resources/app.asar.unpacked/node_modules/better-sqlite3');
const path = require('path');
const dbPath = path.join(process.env.APPDATA, 'koodo-reader', 'config', 'plugins.db');
const db = new Database(dbPath);
const rows = db.prepare('SELECT key, type, voiceList FROM plugins').all();
console.log('Total entries:', rows.length);
rows.forEach(r => {
  console.log(r.key, r.type, r.voiceList ? r.voiceList.substring(0, 200) : 'null');
});
db.close();
