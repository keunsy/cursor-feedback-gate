// Run: node cursor-extension/test/windows-paths.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
const helperStart = source.indexOf('\nfunction _normalizeWorkspacePath(');
const start = helperStart >= 0 ? helperStart : source.indexOf('\nfunction _workspacePathsMatch(');
const end = source.indexOf('\nfunction discoverMcpPids(', start);
assert(start >= 0 && end > start, 'Load the production workspace matching functions');

function loadMatcher(platform) {
    const context = { process: { platform }, module: { exports: {} } };
    vm.runInNewContext(source.slice(start, end) + '\nmodule.exports = _workspacePathsMatch;', context);
    return context.module.exports;
}

const matches = loadMatcher('win32');
const cases = [
    ['drive letter, case and separators', 'c:/users/alice/project', ['C:\\Users\\Alice\\Project'], true],
    ['child workspace', 'C:\\work\\project\\src', ['c:/work/project'], true],
    ['parent workspace', 'C:\\work', ['c:/work/project'], true],
    ['trailing separator', 'C:\\work\\project\\', ['c:/work/project'], true],
    ['UNC workspace', '\\\\SERVER\\Share\\Project', ['//server/share/project'], true],
    ['multiple roots', 'D:\\other,C:\\work\\project', ['c:/work/project'], true],
    ['sibling with a shared prefix', 'C:\\work\\project-old', ['c:/work/project'], false],
    ['unrelated drive', 'D:\\work\\project', ['C:/work/project'], false],
    ['missing hint', '', ['C:/work/project'], false],
    ['no workspace', 'C:/work/project', [], false],
];
let failed = 0;
for (const [name, hint, workspaces, expected] of cases) {
    try {
        assert.strictEqual(matches(hint, workspaces), expected);
        console.log(`PASS ${name}`);
    } catch (error) {
        failed++;
        console.error(`FAIL ${name}: ${error.message}`);
    }
}
const posixMatches = loadMatcher('linux');
assert.strictEqual(posixMatches('/work/Project', ['/work/project']), false);
assert.strictEqual(posixMatches('/work/project/src', ['/work/project']), true);
console.log('PASS POSIX case and directory boundaries');
if (failed) process.exitCode = 1;
