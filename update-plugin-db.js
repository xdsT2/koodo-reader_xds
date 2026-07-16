const fs = require("fs");
const path = require("path");
const initSqlJs = require("./node_modules/sql.js");

const pluginScript = fs.readFileSync(path.join(__dirname, "scripts", "chattts-plugin.js"), "utf8");

const dbPaths = [
  path.join(process.env.APPDATA, "koodo-reader", "config", "plugins.db"),
  path.join(process.env.APPDATA, "koodo-reader", "uploads", "data", "config", "plugins.db"),
];

async function main() {
  const SQL = await initSqlJs();
  
  for (const dbPath of dbPaths) {
    console.log("=== " + dbPath + " ===");
    if (!fs.existsSync(dbPath)) {
      console.log("  NOT FOUND");
      continue;
    }
    try {
      const dbBuffer = fs.readFileSync(dbPath);
      const db = new SQL.Database(dbBuffer);
      
      const rows = db.exec("SELECT key, type, displayName FROM plugins WHERE key = 'chattts_voice'");
      const count = rows[0]?.values?.length || 0;
      console.log("  Found " + count + " chattts_voice plugin(s)");
      
      if (count > 0) {
        const stmt = db.prepare("UPDATE plugins SET script = ? WHERE key = 'chattts_voice'");
        stmt.bind([pluginScript]);
        stmt.step();
        const changes = db.getRowsModified();
        console.log("  Updated " + changes + " rows");
        stmt.free();
        
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
        console.log("  Saved successfully");
      }
      
      db.close();
    } catch(e) {
      console.log("  ERROR:", e.message);
    }
    console.log("");
  }
}

main().catch(console.error);
