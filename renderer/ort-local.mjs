// transformers.js, with ONNX Runtime's WebAssembly taken from the app itself rather than a CDN: it
// works offline, starts sooner, and can't time out on a slow download. (The files are
// onnxruntime-web's, the very version transformers.js was built with.) The voice's worker and the
// ears' worker both load transformers.js through this.

import { env } from '/node_modules/@huggingface/transformers/dist/transformers.min.js';

export * from '/node_modules/@huggingface/transformers/dist/transformers.min.js';

env.backends.onnx.wasm.wasmPaths = new URL('/node_modules/onnxruntime-web/dist/', import.meta.url).href;
