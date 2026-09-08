/**
 * Monaco ships no types for its internals, and `lsp-session.test.ts` needs the real `URI`
 * class. Declares only what that test uses, so it can't become a licence for app code.
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
