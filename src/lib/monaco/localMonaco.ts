// Bundles Monaco locally so the editor works fully offline, and points
// @monaco-editor/react at this instance instead of its CDN loader.
// Workers come from monacoWorkers.ts (single mockable boundary for tests).
import * as monaco from "monaco-editor";
import loader from "@monaco-editor/loader";
import {
  editorWorker,
  jsonWorker,
  cssWorker,
  htmlWorker,
  tsWorker,
} from "./monacoWorkers";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment =
  {
    getWorker(_workerId, label) {
      switch (label) {
        case "json":
          return new jsonWorker();
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

loader.config({ monaco });

export { monaco };
