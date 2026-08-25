const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// 生成分享包：把最新的安装版 exe 打成标准 zip（zip 内为该 exe 本身，顶层，与 dist 现有产物一致）。
// 用 adm-zip 库生成标准 zip，中文文件名 UTF-8 正常，跨平台可用，无需外部工具。

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const version = require(path.join(root, 'package.json')).version;
const exeName = `千幻桌面便笺-安装版-${version}.exe`;
const zipName = `千幻桌面便笺-分享包-${version}.zip`;
const exePath = path.join(dist, exeName);
const zipPath = path.join(dist, zipName);

if (!fs.existsSync(exePath)) {
  console.error(`未找到安装包: ${exeName}，请先构建安装包`);
  process.exit(1);
}

try {
  const zip = new AdmZip();
  zip.addLocalFile(exePath, '', exeName); // 顶层 entry，中文名
  zip.writeZip(zipPath);
  const sizeMB = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  console.log(`已生成分享包: ${zipName} (${sizeMB} MB)`);
} catch (e) {
  console.error('生成分享包失败:', e.message);
  process.exit(1);
}
