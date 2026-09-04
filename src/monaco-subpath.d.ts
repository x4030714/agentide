/**
 * Monaco ships no declarations for its internal modules, only for the public `monaco`
 * namespace. `lsp-session.test.ts` reaches past that on purpose: it checks our URI
 * helpers against Monaco's *real* `URI` class rather than against a copy of what we
 * believe it does, and the public entry point cannot be imported outside a DOM.
 *
 * Narrow on purpose. Only what the test uses is declared, so this cannot quietly become
 * a licence to use Monaco internals in app code.
 */
declare module "monaco-editor/base/common/uri.js" {
  export class URI {
    static parse(value: string): URI;
    static file(path: string): URI;
    readonly scheme: string;
    readonly path: string;
    readonly fsPath: string;
    toString(skipEncoding?: boolean): string;
  }
}
