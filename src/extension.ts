import { command, Context } from "./helper"

import { bundleFile, openRepl, runCurrentFile, runFile } from "./commands/runtime"
import { openDocs, reportIssue } from "./commands/meta"
import { managePackages } from "./commands/package"
import { startLanguageClient, stopLanguageClient } from "./languageClient"


/** Register commands for the Arturo VS Code extension on activate.
 * 
 * @param context - The extension context provided by VS Code.
 */
export const activate = async (context: Context) => {

    command(context, "arturo.runtime.repl", openRepl)
    command(context, "arturo.runtime.run", runFile)
    command(context, "arturo.runtime.run-current", runCurrentFile)
    command(context, "arturo.runtime.bundle", bundleFile)

    command(context, "arturo.package.manage", managePackages)

    command(context, "arturo.meta.report-issue", reportIssue)
    command(context, "arturo.meta.open-docs", openDocs)
    await startLanguageClient(context)
    
}

/** Stop the language server and its active runtime processes. */
export const deactivate = stopLanguageClient
