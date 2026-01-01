# CSpell Dict Add

Add unknown words from cSpell diagnostics to a custom dictionary in one go.

## Features

- Collects cSpell diagnostics from the PROBLEMS panel
- Shows unique unknown words with occurrence counts
- Lets you pick which words to add (default: all selected)
- Appends only new words to your configured cSpell custom dictionary

## Requirements

- VS Code 1.80+
- The cSpell extension installed and enabled
- cSpell diagnostics visible in the PROBLEMS panel
- A writable custom dictionary configured in `cSpell.customDictionaries`

## Installation

### Install from VSIX

1. Build the package:
   ```bash
   npx @vscode/vsce package
   ```
2. Install the VSIX:
   ```bash
   code --install-extension cspell-dict-add-0.1.0.vsix
   ```

## Usage

1. Open a workspace where cSpell reports unknown words.
2. Run the command `CSpell Dict Add: Open` from the Command Palette.
3. Select the words you want to add and confirm.

If no new words are found, the extension will show a notification.

## Configuration

This extension reads your cSpell custom dictionaries and chooses a writable one.
By default it targets the key `custom-dictionary-user`, and falls back to the
first entry with `addWords: true` and a `path`.

Example cSpell settings:

```jsonc
"cSpell.customDictionaries": {
  "custom-dictionary-user": {
    "addWords": true,
    "name": "custom-dictionary-user",
    "path": "~/.vscode/cspell/custom-dictionary-user.txt",
    "scope": "user"
  }
}
```

Extension settings:

- `cspellDictAdd.dictionaryKey` (string, default: `custom-dictionary-user`)
  - Which key in `cSpell.customDictionaries` to use.
- `cspellDictAdd.minOccurrence` (number, default: `1`)
  - Minimum number of occurrences required to show a word in the list.

## How it works

- Reads VS Code diagnostics and filters those from cSpell.
- Extracts the unknown word from the diagnostic message or range text.
- Deduplicates and filters out words already present in the dictionary file.
- Appends new words, one per line, preserving a trailing newline.

## Development

```bash
npm install
npm run compile
```

Debug with the `Run Extension` launch configuration (F5).

## License

MIT. See `LICENSE`.
