/** 
 * @module commands/runtime
 * @fileoverview Arturo Runtime related commands.
 */

import * as vscode from 'vscode'

import {selectScript} from './helper/ui'
import { arturo } from './helper/arturo'
import { ensure } from './helper/error'


/** Opens the Arturo REPL in a new terminal window. */
export const openRepl = () => {
    arturo('REPL', '--repl')
}

/** Prompts the user to select an Arturo script and runs it.
 * 
 * Runtime output appears in the terminal. Snapshot diagnostics use Refresh Runtime.
 * If no file is selected, the function exits without action.
 * */
export const runFile = async () => {
    const file: string = ensure({
        that: await selectScript(),
        reason: 'No Arturo file selected to run.',
    })

    arturo("Execute", file)
}

/** Runs the currently active Arturo file in the editor.
 * 
 * Runtime output appears in the terminal. Snapshot diagnostics use Refresh Runtime.
 * If no active editor or the file is not an Arturo file, it shows a warning.
 * If the file is unsaved or has unsaved changes, it prompts to save before running.
 */
export const runCurrentFile = async () => {

    const editor = ensure({
        that: vscode.window.activeTextEditor,
        reason: 'No active editor to run.',
    })

    ensure({
        that: editor.document.languageId == 'art',
        reason: 'Open an Arturo file to run it.',
    })

    ensure({
        that: !editor.document.isUntitled,
        reason: 'Save the Arturo file before running it.'
    })

    if (editor.document.isDirty) 
        await editor.document.save()

    const file = editor.document.fileName
    arturo("Execute", file)
}

/** Prompts the user to select an Arturo script and bundles it.
 * 
 * The user can specify the output bundle name. 
 * If no file is selected, the function exits without action.
 */
export const bundleFile = async () => {
    const file = ensure({
        that: await selectScript(),
        reason: 'No Arturo file selected to bundle.',
    })

    const asName = await vscode.window.showInputBox({
        prompt: 'Enter the bundle name',
        placeHolder: 'output.exe'
    })

    if (asName) {
        arturo('Bundle', `--bundle --as:"${asName}" "${file}"`)
    } else {
        arturo('Bundle', `--bundle "${file}"`)
    }

}
