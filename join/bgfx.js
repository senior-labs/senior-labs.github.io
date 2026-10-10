/* senior-labs Hintergrund-Effekte (Unschaerfe / Bild) mit Google MediaPipe – genutzt von Gastseite und Studio.
   Nimmt einen Kamera-Track, gibt einen bearbeiteten Video-Track zurueck. Laeuft im Browser, nichts geht an einen Server.
   - Antrieb ueber die Kamerabilder selbst (MediaStreamTrackProcessor/-Generator, Chrome/Edge): laeuft auch weiter,
     wenn das Fenster verdeckt ist (z. B. hinter dem Spiel). Andere Browser: Fallback ueber Canvas + Timer.
   - Weiche Kanten: zeitliche Glaettung der Maske (gegen Flimmern), weiche Schwelle, Hochskalieren + Weichzeichnen.
   API:  const fx = await SLFX.create(cameraTrack);  fx.track (Ausgabe) · fx.canvas (Vorschau) · fx.set({mode,blur,image}) · fx.stop()
         mode: 'none' | 'blur' | 'image'   blur: 2..30   image: HTMLImageElement / ImageBitmap */
(function () {
  var MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35';
  var MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite';
  var W = 1280, H = 720, FEATHER = 4, SMOOTH = 0.55;
  var segP = null;   // Modell nur einmal laden (wird von allen Instanzen geteilt)

  function loadSeg() {
    if (segP) return segP;
    segP = import(MP + '/vision_bundle.mjs').then(function (m) {
      return m.FilesetResolver.forVisionTasks(MP + '/wasm').then(function (fs) {
        var o = function (d) { return { baseOptions: { modelAssetPath: MODEL, delegate: d }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false }; };
        return m.ImageSegmenter.createFromOptions(fs, o('GPU')).catch(function () { return m.ImageSegmenter.createFromOptions(fs, o('CPU')); });
      });
    });
    segP.catch(function () { segP = null; });
    return segP;
  }

  function create(camTrack) {
    var st = { mode: 'none', blur: 12, image: null };
    var out = document.createElement('canvas'); out.width = W; out.height = H; var octx = out.getContext('2d');
    var mask = document.createElement('canvas'), mctx = mask.getContext('2d', { willReadFrequently: true });
    var soft = document.createElement('canvas'); soft.width = W; soft.height = H; var sctx = soft.getContext('2d');
    var person = document.createElement('canvas'); person.width = W; person.height = H; var pctx = person.getContext('2d');
    var small = document.createElement('canvas'); small.width = 320; small.height = 180; var smctx = small.getContext('2d');
    var seg = null, prev = null, stopped = false, lastT = 0;
    loadSeg().then(function (s) { seg = s; }).catch(function () {});

    function drawCover(ctx, src, sw0, sh0, w, h) {
      var r = Math.max(w / sw0, h / sh0), sw = w / r, sh = h / r;
      ctx.drawImage(src, (sw0 - sw) / 2, (sh0 - sh) / 2, sw, sh, 0, 0, w, h);
    }
    // ein Bild bearbeiten: src = VideoFrame oder <video>
    function frame(src, sw0, sh0) {
      if (st.mode === 'none' || !seg) { drawCover(octx, src, sw0, sh0, W, H); return; }
      var now = performance.now(); if (now <= lastT) now = lastT + 1; lastT = now;
      try {
        var res = seg.segmentForVideo(src, now), cm = res.confidenceMasks && res.confidenceMasks[0];
        if (cm) {
          var mw = cm.width, mh = cm.height, data = cm.getAsFloat32Array();
          if (mask.width !== mw || mask.height !== mh) { mask.width = mw; mask.height = mh; prev = null; }
          if (!prev || prev.length !== data.length) prev = new Float32Array(data);
          else for (var i = 0; i < data.length; i++) prev[i] = prev[i] * SMOOTH + data[i] * (1 - SMOOTH);
          var id = mctx.createImageData(mw, mh), px = id.data;
          for (var j = 0; j < prev.length; j++) { var v = (prev[j] - 0.3) / 0.4; v = v < 0 ? 0 : v > 1 ? 1 : v; px[j * 4 + 3] = v * v * (3 - 2 * v) * 255; }
          mctx.putImageData(id, 0, 0);
          if (res.close) res.close();
        }
      } catch (e) { drawCover(octx, src, sw0, sh0, W, H); return; }
      sctx.clearRect(0, 0, W, H); sctx.filter = 'blur(' + FEATHER + 'px)'; sctx.drawImage(mask, 0, 0, mask.width, mask.height, 0, 0, W, H); sctx.filter = 'none';
      pctx.globalCompositeOperation = 'source-over'; pctx.clearRect(0, 0, W, H); drawCover(pctx, src, sw0, sh0, W, H);
      pctx.globalCompositeOperation = 'destination-in'; pctx.drawImage(soft, 0, 0);
      if (st.mode === 'blur') {
        smctx.filter = 'blur(' + (st.blur / 4) + 'px)';
        var r = Math.max(336 / sw0, 196 / sh0), sw = 336 / r, sh = 196 / r;
        smctx.drawImage(src, (sw0 - sw) / 2, (sh0 - sh) / 2, sw, sh, -8, -8, 336, 196); smctx.filter = 'none';
        octx.imageSmoothingQuality = 'high'; octx.drawImage(small, 0, 0, W, H);
      } else if (st.image) { var im = st.image; drawCover(octx, im, im.width || im.videoWidth, im.height || im.videoHeight, W, H); }
      else { octx.fillStyle = '#000'; octx.fillRect(0, 0, W, H); }
      octx.drawImage(person, 0, 0);
    }

    var api = { canvas: out, track: null, set: function (o) { Object.keys(o || {}).forEach(function (k) { st[k] = o[k]; }); if (st.mode !== 'none') loadSeg().then(function (s) { seg = s; }).catch(function () {}); }, ready: loadSeg(),
      stop: function () { stopped = true; try { camTrack.stop(); } catch (_) {} try { api.track && api.track.stop(); } catch (_) {} } };

    if (window.MediaStreamTrackProcessor && window.MediaStreamTrackGenerator && window.VideoFrame) {
      // Chrome/Edge: Bild fuer Bild aus der Kamera lesen und bearbeitet weitergeben (nicht an den Bildschirm-Takt gebunden)
      var reader = new MediaStreamTrackProcessor({ track: camTrack }).readable.getReader();
      var gen = new MediaStreamTrackGenerator({ kind: 'video' }), writer = gen.writable.getWriter();
      api.track = gen;
      (function pump() {
        reader.read().then(function (r) {
          if (r.done || stopped) { if (r.value) r.value.close(); return; }
          var vf = r.value;
          try {
            frame(vf, vf.displayWidth, vf.displayHeight);
            var outF = new VideoFrame(out, { timestamp: vf.timestamp });
            writer.write(outF).catch(function () {}).then(function () { try { outF.close(); } catch (_) {} });
          } catch (e) {}
          vf.close(); pump();
        }).catch(function () {});
      })();
    } else {
      // Fallback (Firefox/Safari): Kamera in ein <video>, bearbeiten im Timer, Canvas als Stream ausgeben
      var v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = new MediaStream([camTrack]); v.play().catch(function () {});
      var t = setInterval(function () { if (stopped) { clearInterval(t); return; } if (v.videoWidth) frame(v, v.videoWidth, v.videoHeight); }, 1000 / 30);
      api.track = out.captureStream(30).getVideoTracks()[0];
    }
    return api;
  }
  window.SLFX = { create: create, preload: loadSeg };
})();
