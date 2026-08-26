// Type shims for deep worker imports from monaco-editor's exports map.
// The package ships no declarations for these subpaths.
declare module "monaco-editor/editor/editor.worker.js?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
declare module "monaco-editor/language/json/json.worker.js?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
declare module "monaco-editor/language/css/css.worker.js?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
declare module "monaco-editor/language/html/html.worker.js?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
declare module "monaco-editor/language/typescript/ts.worker.js?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
