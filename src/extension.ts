import * as vscode from 'vscode';
import { ChatPanelProvider } from './chat/chatPanel';

export function activate(context: vscode.ExtensionContext) {
  console.log('OpenCodeSpec Chat extension is now active');

  // Register the chat panel provider
  const chatPanelProvider = new ChatPanelProvider(context.extensionUri, context);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatPanelProvider.viewType,
      chatPanelProvider
    )
  );

  // Register command to open chat
  const openChatCommand = vscode.commands.registerCommand('opencodespec.openChat', () => {
    vscode.commands.executeCommand('workbench.view.extension.opencodeChat');
  });

  // Register command to send message to chat
  const sendMessageCommand = vscode.commands.registerCommand('opencodespec.sendMessage', (text: string) => {
    chatPanelProvider.sendMessage(text);
  });

  const startServerCommand = vscode.commands.registerCommand('opencodespec.startServer', () => {
    void chatPanelProvider.startLocalServer();
  });

  const stopServerCommand = vscode.commands.registerCommand('opencodespec.stopServer', () => {
    void chatPanelProvider.stopLocalServer();
  });

  context.subscriptions.push(openChatCommand, sendMessageCommand, startServerCommand, stopServerCommand);
}

export function deactivate() {}
