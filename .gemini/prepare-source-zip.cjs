const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const workspaceDir = 'C:\\Users\\sarba_lcvi2cc\\Web-Development\\Deepseek';
const tempSourceDir = path.join(workspaceDir, 'hostinger-source-dist');
const zipFile = path.join(workspaceDir, 'deepseek-source.zip');

console.log('Creating source distribution directory...');
if (fs.existsSync(tempSourceDir)) {
  fs.rmSync(tempSourceDir, { recursive: true, force: true });
}
fs.mkdirSync(tempSourceDir);

const filesToCopy = [
  'src',
  'public',
  'supabase',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  '.gitignore',
  'components.json',
  'eslint.config.js',
  'bunfig.toml',
  'bun.lock'
];

for (const item of filesToCopy) {
  const srcPath = path.join(workspaceDir, item);
  const destPath = path.join(tempSourceDir, item);
  if (fs.existsSync(srcPath)) {
    console.log(`Copying ${item}...`);
    fs.cpSync(srcPath, destPath, { recursive: true });
  }
}

console.log('Zipping...');
if (fs.existsSync(zipFile)) {
  fs.unlinkSync(zipFile);
}

execSync(`powershell -Command "Compress-Archive -Path '${tempSourceDir}\\*' -DestinationPath '${zipFile}' -Force"`, {
  stdio: 'inherit'
});

console.log('Cleaning up temporary directory...');
fs.rmSync(tempSourceDir, { recursive: true, force: true });

console.log('Success! Created ' + zipFile);
