# Local body and face tracking assets

カメラ画像を端末内で解析するための実行ファイルとモデルです。アプリ実行時は同じローカルサーバーから読み込み、CDNを参照しません。

## Sources and licences

- Runtime: [`@mediapipe/tasks-vision@0.10.32`](https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.32), Apache-2.0. Package is pinned in `package-lock.json`. [`LICENSE`](LICENSE) is copied from the [matching MediaPipe tag](https://github.com/google-ai-edge/mediapipe/blob/v0.10.32/LICENSE).
- Model: [Pose Landmarker Lite, float16, version 1](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task), unchanged. The [BlazePose GHUM 3D model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf), page 2, identifies Apache License 2.0.
- Model: [Face Landmarker, float16, version 1](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task), unchanged. Its official [BlazeFace short-range](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf), [Face Mesh V2](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf), and [Blendshape V2](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf) model cards each identify Apache License 2.0 on page 1. Blendshape output is disabled in this app.
- Model documentation: [Pose Landmarker guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker).
- Face documentation: [Face Landmarker guide](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker).

## Reproduction

After `npm ci`, `npm run prepare:camera` copies both SIMD and non-SIMD WASM files from the pinned npm package. It wraps the package's CommonJS bundle in a local `Vision` namespace for `importScripts()` in the classic camera worker. No package logic is changed; the unavailable source-map reference is removed. The script verifies both bundled model checksums. `predev` and `prebuild` run this preparation automatically, without downloading assets.

The `.task` model and licence are already included. Model replacement or a package-version update requires reviewing the licence, network behaviour, worker compatibility, and model checksum; preparation intentionally fails for a different package version.

## SHA-256

| File | SHA-256 |
|---|---|
| `pose_landmarker_lite.task` | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` |
| `face_landmarker.task` | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |
| `vision_bundle.js` | `448da2f13174b8d663fac55dbf6890db8f36863af2dd9a3daf99497595556f74` |
| `wasm/vision_wasm_internal.js` | `6f6b86509cf9e163ea1cfec7edc8cf53732699c04781e4c21c557c1ba402310e` |
| `wasm/vision_wasm_internal.wasm` | `cb3ec20026a9aecc2a81a93c25630ceb5389297ddb7a5f0bd61dd09cde606b9b` |
| `wasm/vision_wasm_nosimd_internal.js` | `9f8fc960e363f0fb2f42f7937b97ae9cf9a5630490f71031fa90caa9bb121938` |
| `wasm/vision_wasm_nosimd_internal.wasm` | `924274fcd5ac8985f6570a8573e7971b7bd2d580ba1b8f3beb0ba8f95db6347c` |
