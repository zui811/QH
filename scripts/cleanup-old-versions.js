const fs = require('fs');
const path = require('path');

const dist = path.resolve(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) process.exit(0);

const versionPattern = /-(\d+\.\d+\.\d+)(?=(?:\.exe(?:\.blockmap)?|\.zip|\s+-\s+快捷方式\.lnk)$)/;
const files = fs.readdirSync(dist, { withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => ({ name: entry.name, match: entry.name.match(versionPattern) }))
  .filter(entry => entry.match);

const compareVersions = (a, b) => {
  const av = a.split('.').map(Number);
  const bv = b.split('.').map(Number);
  return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
};

const versions = [...new Set(files.map(file => file.match[1]))].sort(compareVersions);
const keep = new Set(versions.slice(0, 2));

for (const file of files) {
  if (!keep.has(file.match[1])) {
    fs.rmSync(path.join(dist, file.name));
    console.log(`已删除旧版本文件: ${file.name}`);
  }
}
