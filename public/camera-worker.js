/* Camera input never leaves this worker. All model/runtime URLs are local. */
let detector = null;
let initializing = null;
let mode = null;

function initialize(requestedMode = 'body') {
  if (requestedMode !== 'body' && requestedMode !== 'face') return Promise.reject(new Error('Unknown tracking mode.'));
  if (initializing) return mode === requestedMode ? initializing : Promise.reject(new Error('Restart the worker to change tracking mode.'));
  mode = requestedMode;
  initializing = (async () => {
    importScripts(new URL('./mediapipe/vision_bundle.js', self.location.href).href);
    const files = await Vision.FilesetResolver.forVisionTasks(
      new URL('./mediapipe/wasm', self.location.href).href,
    );
    const options = {
      baseOptions: {
        modelAssetPath: new URL(`./mediapipe/${mode === 'face' ? 'face_landmarker.task' : 'pose_landmarker_lite.task'}`, self.location.href).href,
        delegate: 'CPU',
      },
      canvas: new OffscreenCanvas(1, 1),
      runningMode: 'VIDEO',
      minTrackingConfidence: 0.6,
    };
    detector = mode === 'face'
      ? await Vision.FaceLandmarker.createFromOptions(files, {
        ...options,
        numFaces: 1,
        minFaceDetectionConfidence: 0.6,
        minFacePresenceConfidence: 0.6,
        outputFacialTransformationMatrixes: true,
        outputFaceBlendshapes: false,
      })
      : await Vision.PoseLandmarker.createFromOptions(files, {
        ...options,
        numPoses: 1,
        minPoseDetectionConfidence: 0.6,
        minPosePresenceConfidence: 0.6,
        outputSegmentationMasks: false,
      });
  })();
  return initializing;
}

self.onmessage = async event => {
  const message = event.data;
  if (message?.type === 'init') {
    try {
      await initialize(message.mode);
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  } else if (message?.type === 'frame') {
    const { bitmap, timestamp } = message;
    try {
      if (!detector) throw new Error('Tracking model is not ready.');
      const frame = { type: 'result', mode, width: bitmap.width, height: bitmap.height, timestamp };
      if (mode === 'face') {
        // FaceLandmarker returns synchronously; unlike PoseLandmarker it has no callback overload.
        const result = detector.detectForVideo(bitmap, timestamp);
        self.postMessage({
          ...frame,
          landmarks: result.faceLandmarks[0] ?? [],
          matrix: result.facialTransformationMatrixes[0] ?? null,
        });
      } else {
        detector.detectForVideo(bitmap, timestamp, result => {
          self.postMessage({ ...frame, landmarks: result.landmarks[0] ?? [] });
        });
      }
    } catch (error) {
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      bitmap?.close();
    }
  }
};
