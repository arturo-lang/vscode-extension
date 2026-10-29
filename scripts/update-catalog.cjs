// Run with Bun after compiling. Executes only the bundled harness, never project code.
const fs = require('node:fs/promises');
const { runRuntime } = require('../out/server/runtime');

(async () => {
    const { snapshot } = await runRuntime({ executable: process.env.ARTURO || 'arturo',
        entrypoint: '', args: [], cwd: process.cwd(), timeoutMs: 30000 }, new AbortController().signal, true);
    snapshot.bindings.sort((a, b) => a.name.localeCompare(b.name));
    await fs.writeFile('resources/builtins.json', JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`Wrote ${snapshot.bindings.length} builtin records from Arturo ${snapshot.runtimeVersion}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
