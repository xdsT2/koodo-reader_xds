const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function main() {
  const SQL = await initSqlJs();
  const dbPath = path.join(process.env.APPDATA, 'koodo-reader', 'config', 'plugins.db');
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);
  
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  console.log('Tables:', JSON.stringify(tables));
  
  for (const t of tables) {
    for (const tblName of t.values) {
      const name = tblName[0];
      console.log('\n=== Table:', name, '===');
      const data = db.exec("SELECT * FROM \"" + name + "\"");
      console.log('Columns:', JSON.stringify(data.map(r => r.columns)));
      for (const row of data) {
        for (const val of row.values) {
          console.log(JSON.stringify(val));
        }
      }
    }
  }
  
  db.close();
}

main().catch(console.error);
