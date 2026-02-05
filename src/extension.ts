import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('OpenCodeSpec extension is now active');

  const disposable = vscode.commands.registerCommand('opencodespec.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from OpenCodeSpec!');
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
