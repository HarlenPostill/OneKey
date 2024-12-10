import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface DictionaryData {
    [key: string]: string | DictionaryData;
}

interface DictionaryEntry {
    value: string;
    line: number;
    column: number;
}

interface ParentInfo {
    obj: DictionaryData;
    existingPath: string[];
    remainingPath: string[];
}

export function activate(context: vscode.ExtensionContext) {
    let dictionaryData: DictionaryData = {};
    let dictionaryFilePath: string = '';
    let paths: Map<string, DictionaryEntry> = new Map();

	// Load dictionary file path from workspace state
	function loadStoredDictionaryPath(): string | undefined {
        const workspaceState = context.workspaceState;
        return workspaceState.get<string>('dictionaryFilePath');
    }

	// Save dictionary file path to workspace state
    async function storeDictionaryPath(filePath: string) {
        await context.workspaceState.update('dictionaryFilePath', filePath);
    }

	// Command to select dictionary file
    const selectDictionaryCommand = vscode.commands.registerCommand(
        'dictionary-intellisense.selectDictionary',
        async () => {
            const options: vscode.OpenDialogOptions = {
                canSelectMany: false,
                filters: {
                    'JSON files': ['json']
                },
                title: 'Select dictionary.json file'
            };

            const fileUri = await vscode.window.showOpenDialog(options);
            if (fileUri && fileUri[0]) {
                const filePath = fileUri[0].fsPath;
                if (path.basename(filePath) !== 'dictionary.json') {
                    vscode.window.showErrorMessage('Please select a file named dictionary.json');
                    return;
                }

                await storeDictionaryPath(filePath);
                dictionaryFilePath = filePath;
                loadDictionary();
                vscode.window.showInformationMessage(`Dictionary file set to: ${filePath}`);
            }
        }
    );

    // Helper function to get dictionary key at position
    function getDictionaryKeyAtPosition(document: vscode.TextDocument, position: vscode.Position): string | null {
		const line = document.lineAt(position.line).text;
		const regex = /d\(['"]([^'"]+)['"]\)/g;
		
		let match;
		while ((match = regex.exec(line)) !== null) {
			const startPos = match.index;
			const endPos = startPos + match[0].length;
			
			// Check if the position is within this d() call
			if (position.character >= startPos && position.character <= endPos) {
				return match[1];
			}
		}
		
		return null;
	}

	function findParentObject(obj: DictionaryData, path: string[]): DictionaryData | null {
		let current: DictionaryData = obj;
		
		// Navigate through all but the last segment
		for (let i = 0; i < path.length - 1; i++) {
			const segment = path[i];
			if (typeof current[segment] === 'object' && current[segment] !== null) {
				current = current[segment] as DictionaryData;
			} else {
				return null; // Parent path doesn't exist
			}
		}
		
		return current;
	}

    // Find and load dictionary.json
    function loadDictionary() {
        // First try to load from stored path
        const storedPath = loadStoredDictionaryPath();
        if (storedPath && fs.existsSync(storedPath)) {
            dictionaryFilePath = storedPath;
        } else {
            // Fall back to searching in workspace if no stored path or stored file doesn't exist
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showWarningMessage('No workspace folder found. Please select a dictionary.json file manually.');
                return;
            }

            const findDictionaryFile = (dir: string): string | null => {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    const stat = fs.statSync(filePath);
                    if (stat.isDirectory()) {
                        const found = findDictionaryFile(filePath);
                        if (found) {return found;}
                    } else if (file === 'dictionary.json') {
                        return filePath;
                    }
                }
                return null;
            };

            const rootPath = workspaceFolders[0].uri.fsPath;
            const dictPath = findDictionaryFile(rootPath);
            
            if (dictPath) {
                dictionaryFilePath = dictPath;
                storeDictionaryPath(dictPath); // Store the found path
            } else {
                vscode.window.showWarningMessage(
                    'No dictionary.json found. Please select it manually.',
                    'Select File'
                ).then(selection => {
                    if (selection === 'Select File') {
                        vscode.commands.executeCommand('dictionary-intellisense.selectDictionary');
                    }
                });
                return;
            }
        }

        try {
            const content = fs.readFileSync(dictionaryFilePath, 'utf8');
            dictionaryData = JSON.parse(content);
            paths = getAllPaths(dictionaryData);
        } catch (error) {
            console.error('Error loading dictionary.json:', error);
            vscode.window.showErrorMessage('Error loading dictionary.json. Please select a valid file.');
        }
    }

    // Add status bar item to show current dictionary path
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'dictionary-intellisense.selectDictionary';
    statusBarItem.tooltip = 'Click to select dictionary.json file';
    context.subscriptions.push(statusBarItem);

    // Update status bar with current dictionary path
    function updateStatusBar() {
        if (dictionaryFilePath) {
            statusBarItem.text = `$(file) ${path.basename(path.dirname(dictionaryFilePath))}/${path.basename(dictionaryFilePath)}`;
            statusBarItem.show();
        } else {
            statusBarItem.text = '$(file) Select dictionary.json';
            statusBarItem.show();
        }
    }

    // Generate all possible paths from dictionary
    function getAllPaths(obj: DictionaryData, prefix = ''): Map<string, DictionaryEntry> {
        const pathsMap = new Map<string, DictionaryEntry>();
        
        function traverse(obj: DictionaryData, currentPath: string, content: string[], currentLine: number) {
            for (const [key, value] of Object.entries(obj)) {
                const newPath = currentPath ? `${currentPath}.${key}` : key;
                
                if (typeof value === 'string') {
                    const line = content.findIndex(l => l.includes(`"${key}": "${value}"`));
                    const column = content[line]?.indexOf(`"${value}"`) ?? 0;
                    pathsMap.set(newPath, { 
                        value: value as string,
                        line: line !== -1 ? line : currentLine,
                        column
                    });
                } else {
                    traverse(value as DictionaryData, newPath, content, currentLine + 1);
                }
            }
        }

        const content = fs.readFileSync(dictionaryFilePath, 'utf8').split('\n');
        traverse(obj, prefix, content, 0);
        return pathsMap;
    }

    // Update dictionary value
    async function updateDictionaryValue(key: string, newValue: string): Promise<boolean> {
        try {
            const entry = paths.get(key);
            if (!entry) {return false;}

            const content = fs.readFileSync(dictionaryFilePath, 'utf8');
            const lines = content.split('\n');
            
            const line = lines[entry.line];
            const keyParts = key.split('.');
            const lastKey = keyParts[keyParts.length - 1];
            
            const newLine = line.replace(`"${lastKey}": "${entry.value}"`, `"${lastKey}": "${newValue}"`);
            lines[entry.line] = newLine;
            
            fs.writeFileSync(dictionaryFilePath, lines.join('\n'));
            
            loadDictionary(); // This will also update the paths Map
            return true;
        } catch (error) {
            console.error('Error updating dictionary:', error);
            return false;
        }
    }

    // Load dictionary on startup
    loadDictionary();

    // Watch for changes in dictionary.json
    if (dictionaryFilePath) {
        fs.watch(dictionaryFilePath, (eventType) => {
            if (eventType === 'change') {
                loadDictionary();
            }
        });
    }

	function findParentObjectWithPath(obj: DictionaryData, path: string[]): ParentInfo {
		let current: DictionaryData = obj;
		let i = 0;
		
		// Navigate as far as we can through the path
		for (; i < path.length - 1; i++) {
			const segment = path[i];
			if (typeof current[segment] === 'object' && current[segment] !== null) {
				current = current[segment] as DictionaryData;
			} else {
				break; // Stop at the first non-existent segment
			}
		}
		
		return {
			obj: current,
			existingPath: path.slice(0, i),
			remainingPath: path.slice(i, -1) // Exclude the final key
		};
	}

	async function createDictionaryKey(keyPath: string, newValue: string): Promise<boolean> {
		try {
			const pathParts = keyPath.split('.');
			const key = pathParts[pathParts.length - 1];
			
			// Find the deepest existing parent and get path information
			const parentInfo = findParentObjectWithPath(dictionaryData, pathParts);
			
			// Read current file content
			const content = fs.readFileSync(dictionaryFilePath, 'utf8');
			const lines = content.split('\n');
			
			// Find insertion point by looking for the last existing parent
			let parentLine = -1;
			if (parentInfo.existingPath.length > 0) {
				const parentKey = parentInfo.existingPath[parentInfo.existingPath.length - 1];
				parentLine = lines.findIndex(l => l.includes(`"${parentKey}": {`));
			} else {
				// If no parent exists, find the root level insertion point
				parentLine = lines.findIndex(l => l.includes('"ui": {'));
			}
			
			if (parentLine === -1) {
				vscode.window.showErrorMessage(`Cannot find appropriate location to insert new key`);
				return false;
			}
	
			// Get base indentation from the parent line
			const baseIndent = lines[parentLine].match(/^\s*/)?.[0] || '';
			const indentUnit = '  '; // Two spaces for each level
			
			// Create the missing parent objects
			let currentIndent = baseIndent + indentUnit;
			let insertLine = parentLine + 1;
			const newLines: string[] = [];
			
			for (const segment of parentInfo.remainingPath) {
				newLines.push(`${currentIndent}"${segment}": {`);
				currentIndent += indentUnit;
			}
			
			// Add the final key-value pair
			newLines.push(`${currentIndent}"${key}": "${newValue}",`);
			
			// Add closing braces for each new object
			for (let i = parentInfo.remainingPath.length - 1; i >= 0; i--) {
				currentIndent = baseIndent + indentUnit.repeat(i + 1);
				newLines.push(`${currentIndent}},`);
			}
			
			// Insert all new lines
			lines.splice(insertLine, 0, ...newLines);
			
			// Write back to file
			fs.writeFileSync(dictionaryFilePath, lines.join('\n'));
			
			// Reload dictionary
			loadDictionary();
			return true;
		} catch (error) {
			console.error('Error creating dictionary key:', error);
			return false;
		}
	}

    // Register hover provider
	const hoverProvider = vscode.languages.registerHoverProvider(
		['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
		{
			provideHover(document: vscode.TextDocument, position: vscode.Position) {
				const key = getDictionaryKeyAtPosition(document, position);
				if (!key) {return;}
	
				const entry = paths.get(key);
				const content = new vscode.MarkdownString('', true);
				content.isTrusted = true;
				content.supportHtml = true;
				
				if (entry) {
					// Existing key
					const params = {
						key: key,
						value: entry.value
					};
					
					const commandUri = encodeURIComponent(JSON.stringify(params));
					content.appendMarkdown(`Key: ${entry.value} `);
					content.appendMarkdown(`[$(edit) Edit](command:dictionary-intellisense.editValue?${commandUri})`);
				} else {
					// Non-existent key
					const params = { key: key };
					const commandUri = encodeURIComponent(JSON.stringify(params));
					content.appendMarkdown(`Key does not exist. `);
					content.appendMarkdown(`[$(plus) Create Key](command:dictionary-intellisense.createKey?${commandUri})`);
				}
	
				return new vscode.Hover(content);
			}
		}
	);

    // Register definition provider
    const definitionProvider = vscode.languages.registerDefinitionProvider(
        ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
        {
            provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
                const key = getDictionaryKeyAtPosition(document, position);
                if (!key) {return;}

                const entry = paths.get(key);
                
                if (entry && dictionaryFilePath) {
                    const uri = vscode.Uri.file(dictionaryFilePath);
                    const pos = new vscode.Position(entry.line, entry.column);
                    return new vscode.Location(uri, pos);
                }
            }
        }
    );

    // Register completion provider
	const completionProvider = vscode.languages.registerCompletionItemProvider(
		['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
		{
			provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
				const linePrefix = document.lineAt(position).text.substring(0, position.character);
				const dCallMatch = linePrefix.match(/d\(['"]([^'"]*)/);
				
				if (!dCallMatch) {
					return undefined;
				}

				const currentPath = dCallMatch[1];
				const parts = currentPath.split('.');
				const parentPath = parts.slice(0, -1).join('.');
				const parentPathWithDot = parentPath ? `${parentPath}.` : '';
				
				// Get unique next segments for the current path
				const completions = new Set<string>();
				
				for (const [key] of paths.entries()) {
					if (parentPath) {
						// If we have a parent path, only show children of that path
						if (key.startsWith(parentPathWithDot)) {
							const remainingPath = key.slice(parentPathWithDot.length);
							const nextSegment = remainingPath.split('.')[0];
							if (nextSegment) {
								completions.add(nextSegment);
							}
						}
					} else {
						// At root level, show first segments
						const firstSegment = key.split('.')[0];
						completions.add(firstSegment);
					}
				}

				return Array.from(completions).map(segment => {
					const item = new vscode.CompletionItem(segment, vscode.CompletionItemKind.Property);
					// If it's a partial path, show what this completes to
					const fullPath = parentPath ? `${parentPath}.${segment}` : segment;
					const possibleCompletions = Array.from(paths.entries())
						.filter(([key]) => key.startsWith(fullPath))
						.map(([_, entry]) => entry.value);
					
					if (possibleCompletions.length > 0) {
						item.detail = `→ ${possibleCompletions[0]}${possibleCompletions.length > 1 ? ` (+${possibleCompletions.length - 1} more)` : ''}`;
					}
					
					// Add the dot at the end if this segment has children
					const hasChildren = Array.from(paths.keys()).some(key => 
						key.startsWith(fullPath + '.')
					);
					if (hasChildren) {
						item.insertText = segment + '.';
						item.command = {
							command: 'editor.action.triggerSuggest',
							title: 'Re-trigger completions'
						};
					}
					
					return item;
				});
			}
		},
		'.' // Trigger on dot
	);

    // Register edit command
	const editCommand = vscode.commands.registerCommand(
		'dictionary-intellisense.editValue', 
		async (params: string | { key: string; value: string }) => {
			// Parse params if it's a string
			const { key, value } = typeof params === 'string' 
				? JSON.parse(params) 
				: params;
				
			const newValue = await vscode.window.showInputBox({
				prompt: `Edit value for key: ${key}`,
				value: value,
				validateInput: (text) => {
					return text.length === 0 ? 'Value cannot be empty' : null;
				}
			});
	
			if (newValue !== undefined && newValue !== value) {
				const success = await updateDictionaryValue(key, newValue);
				if (success) {
					vscode.window.showInformationMessage(`Updated value for ${key}`);
				} else {
					vscode.window.showErrorMessage(`Failed to update value for ${key}`);
				}
			}
		}
	);
	const createKeyCommand = vscode.commands.registerCommand(
		'dictionary-intellisense.createKey',
		async (params: string | { key: string }) => {
			const { key } = typeof params === 'string' ? JSON.parse(params) : params;
			
			const newValue = await vscode.window.showInputBox({
				prompt: `Enter value for new key: ${key}`,
				placeHolder: 'Enter value',
				validateInput: (text) => {
					return text.length === 0 ? 'Value cannot be empty' : null;
				}
			});
	
			if (newValue !== undefined) {
				const success = await createDictionaryKey(key, newValue);
				if (success) {
					vscode.window.showInformationMessage(`Created new key: ${key}`);
				} else {
					vscode.window.showErrorMessage(`Failed to create key: ${key}`);
				}
			}
		}
	);

	loadDictionary();
    updateStatusBar();

    // Watch for changes in dictionary.json
    let fileWatcher: fs.FSWatcher | null = null;
    function setupFileWatcher() {
        if (fileWatcher) {
            fileWatcher.close();
        }
        if (dictionaryFilePath) {
            fileWatcher = fs.watch(dictionaryFilePath, (eventType) => {
                if (eventType === 'change') {
                    loadDictionary();
                }
            });
        }
    }
    setupFileWatcher();

    context.subscriptions.push(
        hoverProvider, 
        definitionProvider, 
        completionProvider,
        editCommand,
		createKeyCommand,
		selectDictionaryCommand,
        statusBarItem,
    );
}

export function deactivate() {}