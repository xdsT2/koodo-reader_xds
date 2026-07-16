const Database = require('./koodo-app/resources/app.asar.unpacked/node_modules/better-sqlite3');
const path = require('path');

// 检查两个可能的 DB 路径
const paths = [
  path.join(process.env.APPDATA, 'koodo-reader', 'config', 'plugins.db'),
  path.join(process.env.APPDATA, 'koodo-reader', 'uploads', 'data', 'config', 'plugins.db'),
];

for (const dbPath of paths) {
  console.log('=== ' + dbPath + ' ===');
  try {
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT key, type, config, voiceList FROM plugins WHERE key LIKE "%chattts%" OR type = "voice" OR key IN ("2222","1111")').all();
    console.log('Rows:', rows.length);
    rows.forEach(r => {
      console.log('  key=' + r.key, 'type=' + r.type, 'config=' + r.config, 'voiceList=' + (r.voiceList ? r.voiceList.substring(0,200) : 'null'));
    });
    db.close();
  } catch(e) {
    console.log('  ERROR:', e.message);
  }
  console.log('');
}
