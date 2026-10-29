import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import { cancelCommand, refreshCommand, RuntimeStatus, statusNotification } from './server/protocol';

let client: LanguageClient | undefined;

export async function startLanguageClient(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('Arturo Language Server');
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    status.name = 'Arturo Runtime'; status.command = refreshCommand;
    const states = new Map<string, RuntimeStatus>();
    const render = () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !['art', 'art-test', 'art-config'].includes(editor.document.languageId)) { status.hide(); return; }
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const state = folder && states.get(folder.uri.toString());
        status.text = `$(symbol-variable) Arturo: ${state?.state ?? 'no snapshot'}`;
        status.tooltip = state
            ? `${folder!.name}: ${state.entrypoint ?? ''}\n${state.timestamp ?? ''}\n${state.message ?? state.staleReason ?? 'Observed globals from the completed harness run'}`
            : 'Refresh runtime to observe globals from your configured entrypoint';
        status.show();
    };
    const module = context.asAbsolutePath('out/server/main.js');
    client = new LanguageClient('arturo', 'Arturo Language Server', {
        run: { module, transport: TransportKind.stdio },
        debug: { module, transport: TransportKind.stdio },
    }, {
        documentSelector: ['art', 'art-test', 'art-config'].map(language => ({ language, scheme: 'file' })),
        outputChannel: output,
        initializationOptions: { runtimeTrusted: vscode.workspace.isTrusted },
        synchronize: { configurationSection: 'arturo.runtime', fileEvents: watcher },
        // The official client registers the server's executeCommandProvider commands.
        // Route those through the workspace picker instead of registering duplicate commands.
        middleware: { executeCommand: (command, args, next) =>
            command === refreshCommand || command === cancelCommand
                ? execute(command, typeof args[0] === 'string' ? args[0] : undefined)
                : next(command, args) },
    });
    const execute = async (command: string, workspaceUri?: string) => {
        if (command === refreshCommand && !vscode.workspace.isTrusted) {
            void vscode.window.showWarningMessage('Trust this workspace before executing its Arturo entrypoint.'); return;
        }
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
        const active = vscode.window.activeTextEditor;
        const folder = (workspaceUri ? folders.find(folder => folder.uri.toString() === workspaceUri)
            : active && vscode.workspace.getWorkspaceFolder(active.document.uri))
            ?? (folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(
                folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
                { placeHolder: 'Select Arturo runtime workspace' }))?.folder);
        if (!folder) return;
        const result = await client!.sendRequest<RuntimeStatus>('workspace/executeCommand', {
            command, arguments: [folder.uri.toString()],
        });
        if (result?.state === 'failed') {
            output.show(true);
            void vscode.window.showErrorMessage(result.message ?? 'Arturo runtime refresh failed');
        }
    };
    context.subscriptions.push(output, watcher, status,
        vscode.window.onDidChangeActiveTextEditor(render),
        vscode.workspace.onDidGrantWorkspaceTrust(() => client!.sendNotification('arturo/workspaceTrust', { trusted: true })),
    );
    await client.start();
    context.subscriptions.push(client.onNotification(statusNotification, (state: RuntimeStatus) => {
        states.set(state.workspaceUri, state); render();
    }));
    render();
}

export async function stopLanguageClient(): Promise<void> { await client?.stop(); client = undefined; }
