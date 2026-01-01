import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';

type CustomDictionaryEntry = {
  name?: string;
  path?: string;
  addWords?: boolean;
};

type DictionaryInfo = {
  key: string;
  name?: string;
  path: string;
};

type DictionaryFileState = {
  words: Set<string>;
  fileExists: boolean;
  endsWithNewline: boolean;
  contentLength: number;
};

type WriteResult = {
  added: number;
  failed: number;
};

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('cspell-dict-add.open', async () => {
    try {
      await run();
    } catch (error) {
      vscode.window.showErrorMessage('Unexpected error running CSpell Dict Add.');
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}

async function run() {
  const dictionaryInfo = resolveDictionaryInfo();
  if (!dictionaryInfo) {
    vscode.window.showErrorMessage(
      'No valid cSpell custom dictionary found. Check cSpell.customDictionaries.'
    );
    return;
  }

  const dictionaryState = await safeReadDictionaryFile(dictionaryInfo.path);
  if (!dictionaryState) {
    vscode.window.showErrorMessage(
      'Failed to read dictionary file. Check the path and permissions.'
    );
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

  const items: vscode.QuickPickItem[] = candidates.map(([word, count]) => ({
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
    vscode.window.showErrorMessage(
      'Failed to write to dictionary file. Check file permissions or lock state.'
    );
    return;
  }

  const dictionaryLabel = dictionaryInfo.name ?? path.basename(dictionaryInfo.path);

  if (result.failed > 0 && result.added > 0) {
    vscode.window.showWarningMessage(
      `Added ${result.added} words to ${dictionaryLabel}. Failed to add ${result.failed} words.`
    );
    return;
  }

  if (result.failed > 0 && result.added === 0) {
    vscode.window.showErrorMessage(
      'Failed to write to dictionary file. Check file permissions or lock state.'
    );
    return;
  }

  vscode.window.showInformationMessage(`Added ${result.added} words to ${dictionaryLabel}.`);
}

function resolveDictionaryInfo(): DictionaryInfo | null {
  const cspellConfig = vscode.workspace.getConfiguration('cSpell');
  const raw = cspellConfig.get<unknown>('customDictionaries');
  const entries = normalizeCustomDictionaryEntries(raw);

  if (entries.length === 0) {
    return null;
  }

  const extensionConfig = vscode.workspace.getConfiguration('cspellDictAdd');
  const preferredKey = extensionConfig.get<string>('dictionaryKey', 'custom-dictionary-user');
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

function normalizeCustomDictionaryEntries(
  raw: unknown
): Array<[string, CustomDictionaryEntry]> {
  if (!raw) {
    return [];
  }

  if (Array.isArray(raw)) {
    const entries: Array<[string, CustomDictionaryEntry]> = [];
    raw.forEach((value, index) => {
      if (!value || typeof value !== 'object') {
        return;
      }
      const entry = value as CustomDictionaryEntry;
      const key = entry.name ?? `dictionary-${index}`;
      entries.push([key, entry]);
    });
    return entries;
  }

  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, CustomDictionaryEntry>);
  }

  return [];
}

function isWritableDictionary(entry: CustomDictionaryEntry): boolean {
  return Boolean(entry.addWords && entry.path && entry.path.trim().length > 0);
}

function buildDictionaryInfo(key: string, entry: CustomDictionaryEntry): DictionaryInfo {
  return {
    key,
    name: entry.name,
    path: resolveDictionaryPath(entry.path ?? '')
  };
}

function resolveDictionaryPath(rawPath: string): string {
  const expanded = expandTilde(rawPath.trim());

  if (path.isAbsolute(expanded)) {
    return expanded;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const base = workspaceRoot ?? process.cwd();
  return path.resolve(base, expanded);
}

function expandTilde(input: string): string {
  if (input === '~') {
    return os.homedir();
  }

  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

function getMinOccurrence(): number {
  const extensionConfig = vscode.workspace.getConfiguration('cspellDictAdd');
  const raw = extensionConfig.get<number>('minOccurrence', 1);
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    return 1;
  }
  return Math.max(1, Math.floor(raw));
}

async function safeReadDictionaryFile(dictPath: string): Promise<DictionaryFileState | null> {
  try {
    return await readDictionaryFile(dictPath);
  } catch (error) {
    return null;
  }
}

async function readDictionaryFile(dictPath: string): Promise<DictionaryFileState> {
  try {
    const content = await fs.readFile(dictPath, 'utf8');
    return {
      words: parseDictionaryContent(content),
      fileExists: true,
      endsWithNewline: content.length === 0 ? true : /\r?\n$/.test(content),
      contentLength: content.length
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        words: new Set<string>(),
        fileExists: false,
        endsWithNewline: true,
        contentLength: 0
      };
    }
    throw error;
  }
}

function parseDictionaryContent(content: string): Set<string> {
  const words = new Set<string>();
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

async function safeWriteDictionaryFile(
  dictPath: string,
  words: string[],
  state: DictionaryFileState
): Promise<WriteResult | null> {
  try {
    return await writeDictionaryFile(dictPath, words, state);
  } catch (error) {
    return null;
  }
}

async function writeDictionaryFile(
  dictPath: string,
  words: string[],
  state: DictionaryFileState
): Promise<WriteResult> {
  if (words.length === 0) {
    return { added: 0, failed: 0 };
  }

  await fs.mkdir(path.dirname(dictPath), { recursive: true });

  const prefix = state.fileExists && !state.endsWithNewline && state.contentLength > 0 ? '\n' : '';
  const payload = prefix + words.join('\n') + '\n';

  try {
    if (state.fileExists) {
      await fs.appendFile(dictPath, payload, 'utf8');
    } else {
      await fs.writeFile(dictPath, payload, 'utf8');
    }
    return { added: words.length, failed: 0 };
  } catch (error) {
    return await writeDictionaryFileByWord(dictPath, words, state);
  }
}

async function writeDictionaryFileByWord(
  dictPath: string,
  words: string[],
  state: DictionaryFileState
): Promise<WriteResult> {
  let added = 0;
  let failed = 0;
  let needsPrefix = state.fileExists && !state.endsWithNewline && state.contentLength > 0;
  let fileExists = state.fileExists;

  for (const word of words) {
    const line = (needsPrefix ? '\n' : '') + word + '\n';
    try {
      if (fileExists) {
        await fs.appendFile(dictPath, line, 'utf8');
      } else {
        await fs.writeFile(dictPath, line, 'utf8');
        fileExists = true;
      }
      added += 1;
      needsPrefix = false;
    } catch (error) {
      failed += 1;
    }
  }

  return { added, failed };
}

async function collectUnknownWords(): Promise<{ counts: Map<string, number> }> {
  const diagnostics = vscode.languages.getDiagnostics();
  const counts = new Map<string, number>();
  const pending = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();

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
    } catch (error) {
      continue;
    }
  }

  return { counts };
}

function isCSpellDiagnostic(diagnostic: vscode.Diagnostic): boolean {
  const source = diagnostic.source?.toLowerCase();
  if (!source) {
    return false;
  }
  return source === 'cspell' || source.includes('cspell');
}

function extractWordFromDiagnostic(diagnostic: vscode.Diagnostic): string | null {
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

function extractWordFromMessage(message: string): string | null {
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

function normalizeWord(raw: string): string | null {
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

function incrementCount(map: Map<string, number>, word: string) {
  map.set(word, (map.get(word) ?? 0) + 1);
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
  );
}
