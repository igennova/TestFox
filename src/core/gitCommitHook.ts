import * as vscode from 'vscode';
import { runBackgroundTests, BackgroundTestResult } from './backgroundTestRunner';
import { HeadSnapshot, isNewCommit } from './commitDetection';

/**
 * Minimal subset of the built-in vscode.git extension API (v1) used here.
 */
interface GitRepository {
    rootUri: vscode.Uri;
    state: {
        HEAD?: HeadSnapshot;
        onDidChange: vscode.Event<void>;
    };
}

interface GitAPI {
    repositories: GitRepository[];
    onDidOpenRepository: vscode.Event<GitRepository>;
    onDidCloseRepository: vscode.Event<GitRepository>;
}

/**
 * Git Commit Hook - Automatically triggers tests on git commit
 *
 * Listens to repository state changes from the built-in Git extension
 * (no polling) and prompts to run tests when a new commit lands on the
 * current branch. Controlled by the `testfox.autoRunOnCommit` setting.
 */
export class GitCommitHook implements vscode.Disposable {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private isWatching: boolean = false;
    private apiListeners: vscode.Disposable[] = [];
    private repoListeners = new Map<string, vscode.Disposable>();
    private lastHeads = new Map<string, HeadSnapshot>();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('TestFox Git Hook');
    }

    /**
     * Start or stop watching to match the current `testfox.autoRunOnCommit` setting
     */
    async refresh(): Promise<void> {
        const config = vscode.workspace.getConfiguration('testfox');
        if (config.get<boolean>('autoRunOnCommit', false)) {
            await this.startWatching();
        } else {
            this.stopWatching();
        }
    }

    /**
     * Start watching for git commits
     */
    async startWatching(): Promise<void> {
        if (this.isWatching) {
            return;
        }
        this.isWatching = true;

        const git = await this.getGitAPI();
        if (!this.isWatching) {
            return; // Stopped while the Git extension was activating
        }
        if (!git) {
            this.isWatching = false;
            this.outputChannel.appendLine('⚠️ VS Code Git extension not available - auto-run on commit is inactive');
            return;
        }

        git.repositories.forEach(repo => this.watchRepository(repo));
        this.apiListeners.push(
            git.onDidOpenRepository(repo => this.watchRepository(repo)),
            git.onDidCloseRepository(repo => this.unwatchRepository(repo))
        );

        this.outputChannel.appendLine('🔍 Watching for git commits...');
    }

    /**
     * Stop watching for git commits
     */
    stopWatching(): void {
        if (!this.isWatching) {
            return;
        }
        this.isWatching = false;

        this.apiListeners.forEach(listener => listener.dispose());
        this.apiListeners = [];
        this.repoListeners.forEach(listener => listener.dispose());
        this.repoListeners.clear();
        this.lastHeads.clear();

        this.outputChannel.appendLine('🛑 Stopped watching for git commits');
    }

    /**
     * Get the built-in Git extension API, activating the extension if needed
     */
    private async getGitAPI(): Promise<GitAPI | undefined> {
        const gitExtension = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
        if (!gitExtension) {
            return undefined;
        }

        try {
            const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
            return exports.getAPI(1);
        } catch (error) {
            console.error('TestFox: Failed to get VS Code Git API:', error);
            return undefined;
        }
    }

    private watchRepository(repo: GitRepository): void {
        const key = repo.rootUri.toString();
        if (this.repoListeners.has(key)) {
            return;
        }

        this.lastHeads.set(key, { ...repo.state.HEAD });
        this.repoListeners.set(key, repo.state.onDidChange(() => this.onRepositoryChanged(repo)));
    }

    private unwatchRepository(repo: GitRepository): void {
        const key = repo.rootUri.toString();
        this.repoListeners.get(key)?.dispose();
        this.repoListeners.delete(key);
        this.lastHeads.delete(key);
    }

    /**
     * Detect a new commit on the current branch
     */
    private onRepositoryChanged(repo: GitRepository): void {
        const key = repo.rootUri.toString();
        const previous = this.lastHeads.get(key);
        const current: HeadSnapshot = { ...repo.state.HEAD };

        if (!current.commit || current.commit === previous?.commit) {
            return;
        }

        // Record the new HEAD before prompting, so further state change
        // events for the same commit don't trigger duplicate prompts
        this.lastHeads.set(key, current);

        if (!isNewCommit(previous, current)) {
            return;
        }

        this.outputChannel.appendLine(`📝 New commit detected: ${current.commit.substring(0, 7)}`);
        this.onNewCommit(current.commit).catch(error => {
            console.error('TestFox: Error handling new commit:', error);
        });
    }

    /**
     * Handle new commit - trigger background tests
     */
    private async onNewCommit(commitHash: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('testfox');
        const autoRunWithoutPrompts = config.get<boolean>('automation.autoRunWithoutPrompts', false);

        if (autoRunWithoutPrompts) {
            await this.startBackgroundTestRun(commitHash, true);
            return;
        }

        this.outputChannel.appendLine(`🚀 Triggering background tests for commit ${commitHash.substring(0, 7)}...`);

        // Show notification to user
        const selection = await vscode.window.showInformationMessage(
            `🦊 TestFox: New commit detected (${commitHash.substring(0, 7)}). Run tests?`,
            'Run Full Cycle',
            'Quick Test',
            'Skip'
        );

        if (selection === 'Run Full Cycle' || selection === 'Quick Test') {
            await this.startBackgroundTestRun(commitHash, selection === 'Run Full Cycle');
        } else {
            this.outputChannel.appendLine('⏭️ User skipped tests for this commit');
        }
    }

    /**
     * Start background test run
     */
    private async startBackgroundTestRun(commitHash: string, isFullCycle: boolean): Promise<void> {
        try {
            this.outputChannel.appendLine(`▶️ Starting ${isFullCycle ? 'full cycle' : 'quick'} background test run...`);
            this.outputChannel.show(true);

            await runBackgroundTests({
                context: this.context,
                commitHash,
                isFullCycle,
                outputChannel: this.outputChannel,
                onProgress: (progress) => {
                    this.updateStatusBar(progress);
                },
                onComplete: (result) => {
                    this.onTestRunComplete(result);
                }
            });
        } catch (error) {
            this.outputChannel.appendLine(`❌ Background test run failed: ${error}`);
            vscode.window.showErrorMessage(`TestFox: Background tests failed - ${error}`);
        }
    }

    /**
     * Update status bar with progress
     */
    private updateStatusBar(progress: { completed: number; total: number; currentTest?: string }): void {
        const percent = Math.round((progress.completed / progress.total) * 100);

        // Update status bar item if available
        vscode.commands.executeCommand('testfox.updateStatus', {
            status: 'running',
            progress: percent,
            currentTest: progress.currentTest
        }).then(undefined, () => {
            // Status update failed, ignore
        });
    }

    /**
     * Handle test run completion
     */
    private async onTestRunComplete(result: BackgroundTestResult): Promise<void> {
        const { total, passed, failed, skipped, reportPath } = result;

        this.outputChannel.appendLine(`\n✅ Test Run Complete!`);
        this.outputChannel.appendLine(`   Total: ${total}`);
        this.outputChannel.appendLine(`   Passed: ${passed}`);
        this.outputChannel.appendLine(`   Failed: ${failed}`);
        this.outputChannel.appendLine(`   Skipped: ${skipped}`);

        if (reportPath) {
            this.outputChannel.appendLine(`   Report: ${reportPath}`);
        }

        // Show completion notification
        const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
        const icon = failed === 0 ? '✅' : '⚠️';

        const selection = await vscode.window.showInformationMessage(
            `${icon} TestFox: Background tests complete - ${passRate}% passed (${passed}/${total})`,
            'View Report',
            'Open Dashboard',
            'Dismiss'
        );

        if (selection === 'View Report' && reportPath) {
            const uri = vscode.Uri.file(reportPath);
            await vscode.env.openExternal(uri);
        } else if (selection === 'Open Dashboard') {
            vscode.commands.executeCommand('testfox.openDashboard');
        }
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.stopWatching();
        this.outputChannel.dispose();
    }
}
