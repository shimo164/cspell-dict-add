"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs_1 = require("fs");
const vscode = __importStar(require("vscode"));
function activate(context) {
    const disposable = vscode.commands.registerCommand('cspell-dict-add.open', async () => {
        try {
            await run();
        }
        catch (error) {
            vscode.window.showErrorMessage('Unexpected error running CSpell Dict Add.');
        }
    });
    context.subscriptions.push(disposable);
}
function deactivate() { }
async function run() {
    const dictionaryInfo = resolveDictionaryInfo();
    if (!dictionaryInfo) {
        vscode.window.showErrorMessage('No valid cSpell custom dictionary found. Check cSpell.customDictionaries.');
        return;
    }
    const dictionaryState = await safeReadDictionaryFile(dictionaryInfo.path);
    if (!dictionaryState) {
        vscode.window.showErrorMessage('Failed to read dictionary file. Check the path and permissions.');
        return;
    }
    const { counts } = await collectUnknownWords();
    const minOccurrence = getMinOccurrence();
    const candidates = Array.from(counts.entries())
        .filter(([word, count]) => count >= minOccurrence && !dictionaryState.words.has(word))
        .sort((a, b) => {
        if (b[1] !== a[1]) {
            return b[1] - a[1];
        }
        return a[0].localeCompare(b[0]);
    });
    if (candidates.length === 0) {
        vscode.window.showInformationMessage('No new words found to add from cspell diagnostics.');
        return;
    }
    const items = candidates.map(([word, count]) => ({
        label: word,
        description: `appears ${count} times`,
        picked: true
    }));
    const selection = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select words to add to the cSpell dictionary'
    });
    if (!selection) {
        return;
    }
    if (selection.length === 0) {
        vscode.window.showInformationMessage('No words selected to add.');
        return;
    }
    const selectedWords = selection.map((item) => item.label);
    const wordsToAdd = selectedWords.filter((word) => !dictionaryState.words.has(word));
    if (wordsToAdd.length === 0) {
        vscode.window.showInformationMessage('No new words found to add from cspell diagnostics.');
        return;
    }
    const result = await safeWriteDictionaryFile(dictionaryInfo.path, wordsToAdd, dictionaryState);
    if (!result) {
        vscode.window.showErrorMessage('Failed to write to dictionary file. Check file permissions or lock state.');
        return;
    }
    const dictionaryLabel = dictionaryInfo.name ?? path.basename(dictionaryInfo.path);
    if (result.failed > 0 && result.added > 0) {
        vscode.window.showWarningMessage(`Added ${result.added} words to ${dictionaryLabel}. Failed to add ${result.failed} words.`);
        return;
    }
    if (result.failed > 0 && result.added === 0) {
        vscode.window.showErrorMessage('Failed to write to dictionary file. Check file permissions or lock state.');
        return;
    }
    vscode.window.showInformationMessage(`Added ${result.added} words to ${dictionaryLabel}.`);
}
function resolveDictionaryInfo() {
    const cspellConfig = vscode.workspace.getConfiguration('cSpell');
    const raw = cspellConfig.get('customDictionaries');
    const entries = normalizeCustomDictionaryEntries(raw);
    if (entries.length === 0) {
        return null;
    }
    const extensionConfig = vscode.workspace.getConfiguration('cspellDictAdd');
    const preferredKey = extensionConfig.get('dictionaryKey', 'custom-dictionary-user');
    const preferred = entries.find(([key]) => key === preferredKey);
    if (preferred && isWritableDictionary(preferred[1])) {
        return buildDictionaryInfo(preferred[0], preferred[1]);
    }
    const fallback = entries.find((entry) => isWritableDictionary(entry[1]));
    if (!fallback) {
        return null;
    }
    return buildDictionaryInfo(fallback[0], fallback[1]);
}
function normalizeCustomDictionaryEntries(raw) {
    if (!raw) {
        return [];
    }
    if (Array.isArray(raw)) {
        const entries = [];
        raw.forEach((value, index) => {
            if (!value || typeof value !== 'object') {
                return;
            }
            const entry = value;
            const key = entry.name ?? `dictionary-${index}`;
            entries.push([key, entry]);
        });
        return entries;
    }
    if (typeof raw === 'object') {
        return Object.entries(raw);
    }
    return [];
}
function isWritableDictionary(entry) {
    return Boolean(entry.addWords && entry.path && entry.path.trim().length > 0);
}
function buildDictionaryInfo(key, entry) {
    return {
        key,
        name: entry.name,
        path: resolveDictionaryPath(entry.path ?? '')
    };
}
function resolveDictionaryPath(rawPath) {
    const expanded = expandTilde(rawPath.trim());
    if (path.isAbsolute(expanded)) {
        return expanded;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const base = workspaceRoot ?? process.cwd();
    return path.resolve(base, expanded);
}
function expandTilde(input) {
    if (input === '~') {
        return os.homedir();
    }
    if (input.startsWith('~/') || input.startsWith('~\\')) {
        return path.join(os.homedir(), input.slice(2));
    }
    return input;
}
function getMinOccurrence() {
    const extensionConfig = vscode.workspace.getConfiguration('cspellDictAdd');
    const raw = extensionConfig.get('minOccurrence', 1);
    if (typeof raw !== 'number' || Number.isNaN(raw)) {
        return 1;
    }
    return Math.max(1, Math.floor(raw));
}
async function safeReadDictionaryFile(dictPath) {
    try {
        return await readDictionaryFile(dictPath);
    }
    catch (error) {
        return null;
    }
}
async function readDictionaryFile(dictPath) {
    try {
        const content = await fs_1.promises.readFile(dictPath, 'utf8');
        return {
            words: parseDictionaryContent(content),
            fileExists: true,
            endsWithNewline: content.length === 0 ? true : /\r?\n$/.test(content),
            contentLength: content.length
        };
    }
    catch (error) {
        if (isFileNotFound(error)) {
            return {
                words: new Set(),
                fileExists: false,
                endsWithNewline: true,
                contentLength: 0
            };
        }
        throw error;
    }
}
function parseDictionaryContent(content) {
    const words = new Set();
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        if (trimmed.startsWith('#')) {
            continue;
        }
        words.add(trimmed);
    }
    return words;
}
async function safeWriteDictionaryFile(dictPath, words, state) {
    try {
        return await writeDictionaryFile(dictPath, words, state);
    }
    catch (error) {
        return null;
    }
}
async function writeDictionaryFile(dictPath, words, state) {
    if (words.length === 0) {
        return { added: 0, failed: 0 };
    }
    await fs_1.promises.mkdir(path.dirname(dictPath), { recursive: true });
    const prefix = state.fileExists && !state.endsWithNewline && state.contentLength > 0 ? '\n' : '';
    const payload = prefix + words.join('\n') + '\n';
    try {
        if (state.fileExists) {
            await fs_1.promises.appendFile(dictPath, payload, 'utf8');
        }
        else {
            await fs_1.promises.writeFile(dictPath, payload, 'utf8');
        }
        return { added: words.length, failed: 0 };
    }
    catch (error) {
        return await writeDictionaryFileByWord(dictPath, words, state);
    }
}
async function writeDictionaryFileByWord(dictPath, words, state) {
    let added = 0;
    let failed = 0;
    let needsPrefix = state.fileExists && !state.endsWithNewline && state.contentLength > 0;
    let fileExists = state.fileExists;
    for (const word of words) {
        const line = (needsPrefix ? '\n' : '') + word + '\n';
        try {
            if (fileExists) {
                await fs_1.promises.appendFile(dictPath, line, 'utf8');
            }
            else {
                await fs_1.promises.writeFile(dictPath, line, 'utf8');
                fileExists = true;
            }
            added += 1;
            needsPrefix = false;
        }
        catch (error) {
            failed += 1;
        }
    }
    return { added, failed };
}
async function collectUnknownWords() {
    const diagnostics = vscode.languages.getDiagnostics();
    const counts = new Map();
    const pending = new Map();
    for (const [uri, list] of diagnostics) {
        for (const diagnostic of list) {
            if (!isCSpellDiagnostic(diagnostic)) {
                continue;
            }
            const word = extractWordFromDiagnostic(diagnostic);
            if (word) {
                incrementCount(counts, word);
                continue;
            }
            const key = uri.toString();
            const entry = pending.get(key) ?? { uri, diagnostics: [] };
            entry.diagnostics.push(diagnostic);
            pending.set(key, entry);
        }
    }
    for (const entry of pending.values()) {
        try {
            const document = await vscode.workspace.openTextDocument(entry.uri);
            for (const diagnostic of entry.diagnostics) {
                const rangeText = document.getText(diagnostic.range);
                const word = normalizeWord(rangeText);
                if (word) {
                    incrementCount(counts, word);
                }
            }
        }
        catch (error) {
            continue;
        }
    }
    return { counts };
}
function isCSpellDiagnostic(diagnostic) {
    const source = diagnostic.source?.toLowerCase();
    if (!source) {
        return false;
    }
    return source === 'cspell' || source.includes('cspell');
}
function extractWordFromDiagnostic(diagnostic) {
    const messageCandidate = extractWordFromMessage(diagnostic.message);
    if (messageCandidate) {
        return messageCandidate;
    }
    const related = diagnostic.relatedInformation ?? [];
    for (const info of related) {
        const candidate = extractWordFromMessage(info.message);
        if (candidate) {
            return candidate;
        }
    }
    return null;
}
function extractWordFromMessage(message) {
    const patterns = [
        /Unknown word\s*\(([^)]+)\)/i,
        /Unknown word\s*[:\-]\s*["']?([^"'\s]+)["']?/i,
        /Unknown word\s+["']?([^"'\s]+)["']?/i
    ];
    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match?.[1]) {
            const normalized = normalizeWord(match[1]);
            if (normalized) {
                return normalized;
            }
        }
    }
    return null;
}
function normalizeWord(raw) {
    let value = raw.trim();
    if (!value) {
        return null;
    }
    value = value.replace(/^[\s"'`()\[\]{}<>,.;:!?]+|[\s"'`()\[\]{}<>,.;:!?]+$/g, '');
    if (!value) {
        return null;
    }
    if (/\s/.test(value)) {
        return null;
    }
    return value;
}
function incrementCount(map, word) {
    map.set(word, (map.get(word) ?? 0) + 1);
}
function isFileNotFound(error) {
    return Boolean(error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT');
}
//# sourceMappingURL=extension.js.map