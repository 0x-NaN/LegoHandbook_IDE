# WSL Bashrc Fix - Handbook IDE Alias

This documents the alias that should be added to ~/.bashrc in WSL (Ubuntu-24.04):

```bash
alias handbook-ide="cd /mnt/c/Users/asmit/Desktop/CPI_V2/prototype/handbook-ide && npm run compile && code --extensions-dir ~/.vscode-extensions --force-save-events"
```

To install this alias manually in WSL:

1. Start WSL: `wsl`
2. Edit your bashrc: `nano ~/.bashrc` or `vim ~/.bashrc`
3. Add the alias line at the end of the file
4. Save and exit
5. Reload bashrc: `source ~/.bashrc`
6. Test: type `handbook-ide`

The alias does the following:
- Navigates to the handbook-ide workspace
- Compiles the TypeScript extension (copies mermaid.min.js and compiles extension.ts)
- Opens VS Code with the extension loaded

Note: The `code --extensions-dir ~/.vscode-extensions` part assumes you have a custom extensions directory. If not, you can use just `code` or `code .` to open VS Code with your default extensions.