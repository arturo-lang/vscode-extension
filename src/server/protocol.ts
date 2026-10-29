export const refreshCommand = 'arturo.runtime.refresh';
export const cancelCommand = 'arturo.runtime.cancel';
export const statusNotification = 'arturo/runtimeStatus';

export interface RuntimeSettings {
    executable: string;
    entrypoint: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
}

export interface Binding {
    name: string;
    kind: string;
    description?: string;
    args?: Record<string, string[]>;
    attrs?: Record<string, { types: string[]; description?: string }>;
    returns?: string[];
    source?: string;
    line?: number;
}

export interface Snapshot {
    schemaVersion: 1;
    runtimeVersion: string;
    bindings: Binding[];
}

export interface RuntimeStatus {
    workspaceUri: string;
    generation: number;
    state: 'idle' | 'running' | 'ready' | 'stale' | 'failed' | 'cancelled';
    timestamp?: string;
    staleReason?: string;
    message?: string;
    entrypoint?: string;
}
