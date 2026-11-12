// Install the packaged .vsix into the local VS Code (run `npm run package` first).
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = `${name}-${version}.vsix`;
const editor = process.env.EDITOR_CLI ?? 'code'; // e.g. EDITOR_CLI=cursor
execFileSync(editor, ['--install-extension', vsix, '--force'], { stdio: 'inherit', shell: process.platform === 'win32' });
console.log(`Installed ${vsix}. Run "Developer: Reload Window" in open windows.`);
