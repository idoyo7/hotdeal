// Backward-compatible entrypoint — delegates to K8s runtime.
// `node dist/index.js` continues to work as before.
import './entrypoints/k8s.js';
