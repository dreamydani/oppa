// Worker constructors isolated in their own module so test environments can
// mock a single boundary instead of every `?worker` import (which vitest
// cannot even resolve).
//
// Specifier note: monaco-editor's exports map maps `<sub>.js` →
// `./esm/vs/<sub>.js`, so worker files must be imported WITHOUT the
// `esm/vs` prefix (e.g. `monaco-editor/editor/editor.worker.js?worker`).
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

export { editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker };
