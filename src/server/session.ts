import { RuntimeSettings, RuntimeStatus, Snapshot } from './protocol';
import { runRuntime, RuntimeFailure } from './runtime';

export interface Observation {
    snapshot: Snapshot;
    generation: number;
    revision: number;
    configuration: string;
    entrypoint: string;
    cwd: string;
    timestamp: string;
}

export class RuntimeSession {
    revision = 0;
    generation = 0;
    observation?: Observation;
    status: RuntimeStatus;
    private active?: AbortController;
    private readonly pending = new Set<Promise<unknown>>();

    constructor(public readonly workspaceUri: string,
        private readonly notify: (status: RuntimeStatus) => void,
        private readonly log: (output: string) => void) {
        this.status = { workspaceUri, generation: 0, state: 'idle' };
    }

    private update(status: Partial<RuntimeStatus>) {
        this.status = { ...this.status, ...status, generation: this.generation };
        this.notify(this.status);
    }

    invalidate(reason: string) {
        this.revision++;
        this.update({ state: this.status.state === 'running' ? 'running' : this.observation ? 'stale' : this.status.state,
            staleReason: reason });
    }

    cancel() {
        if (!this.active) return;
        this.active.abort(); this.active = undefined;
        this.generation++;
        this.update({ state: 'cancelled', staleReason: 'Runtime refresh cancelled', message: undefined });
    }

    async dispose() {
        this.cancel();
        await Promise.allSettled([...this.pending]);
    }

    fail(message: string) {
        this.cancel();
        this.update({ state: 'failed', staleReason: message, message });
    }

    async refresh(settings: RuntimeSettings, dirty: boolean): Promise<RuntimeFailure | undefined> {
        this.active?.abort();
        const controller = new AbortController();
        this.active = controller;
        const generation = ++this.generation, revision = this.revision;
        this.update({ state: 'running', entrypoint: settings.entrypoint,
            staleReason: 'Refresh in progress', message: undefined });
        const execution = runRuntime(settings, controller.signal);
        this.pending.add(execution);
        try {
            const result = await execution;
            if (generation !== this.generation) return;
            const timestamp = new Date().toISOString();
            this.observation = { snapshot: result.snapshot, generation, revision,
                configuration: JSON.stringify(settings), entrypoint: settings.entrypoint, cwd: settings.cwd, timestamp };
            this.log(result.output);
            const staleReason = revision !== this.revision ? 'Workspace changed during execution'
                : dirty ? 'Unsaved buffers differ from the executed files' : undefined;
            this.update({ state: staleReason ? 'stale' : 'ready', timestamp, staleReason });
        } catch (error) {
            if (generation !== this.generation) return;
            const failure = error instanceof RuntimeFailure ? error : new RuntimeFailure(String(error));
            this.log(failure.output);
            this.update({ state: controller.signal.aborted ? 'cancelled' : 'failed',
                staleReason: failure.message, message: failure.message });
            return failure;
        } finally {
            this.pending.delete(execution);
            if (generation === this.generation) this.active = undefined;
        }
    }

    get evidence(): string | undefined {
        const observation = this.observation;
        if (!observation) return;
        return `Observed globals after ${observation.entrypoint} completed at ${observation.timestamp}`
            + ` (Arturo ${observation.snapshot.runtimeVersion}, generation ${observation.generation}).`
            + (this.status.state !== 'ready' ? ` STALE: ${this.status.staleReason ?? this.status.state}.` : '')
            + ' This does not establish the binding at this cursor or inside an uncalled function.';
    }
}
