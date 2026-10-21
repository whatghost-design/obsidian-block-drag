// 發版腳本：加版號 → commit → push → 建 GitHub Release（附上外掛三個檔）
// 用法：node release.mjs [patch|minor|major] "這版更新了什麼"
//   patch：小修正 0.2.0 → 0.2.1（預設）
//   minor：新功能 0.2.0 → 0.3.0
//   major：大改版 0.2.0 → 1.0.0
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(dirname(fileURLToPath(import.meta.url)));

const [type = 'patch', notes = '更新'] = process.argv.slice(2);
if (!['patch', 'minor', 'major'].includes(type)) {
  console.error('版號類型只能是 patch、minor 或 major');
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

const manifest = readJson('manifest.json');
let [major, minor, patch] = manifest.version.split('.').map(Number);
if (type === 'major') [major, minor, patch] = [major + 1, 0, 0];
if (type === 'minor') [minor, patch] = [minor + 1, 0];
if (type === 'patch') patch += 1;
const version = `${major}.${minor}.${patch}`;

manifest.version = version;
writeJson('manifest.json', manifest);

const versions = readJson('versions.json');
versions[version] = manifest.minAppVersion;
writeJson('versions.json', versions);

run('git', ['add', '-A']);
run('git', ['commit', '-m', `${version}：${notes}`]);
run('git', ['push']);
run('gh', ['release', 'create', version, 'main.js', 'manifest.json', 'styles.css', '--title', version, '--notes', notes]);

console.log(`\n✅ 已發布 ${version}，到 Obsidian 執行「BRAT: Check for updates」就會更新。`);
