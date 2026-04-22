const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { put } = require('@vercel/blob');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

function normalizeString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  let v = String(value).trim();

  // Remove wrapping quotes if Make sends values like: "slow_zoom_out"
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }

  return v || fallback;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function getProfile(imageType) {
  switch (imageType) {
    case 'detail':
      return {
        zoomStart: 1.06,
        zoomEnd: 1.12,
        panSpeed: 0.12
      };
    case 'chart':
      return {
        zoomStart: 1.01,
        zoomEnd: 1.04,
        panSpeed: 0.08
      };
    case 'portrait':
      return {
        zoomStart: 1.04,
        zoomEnd: 1.10,
        panSpeed: 0.10
      };
    case 'wide':
    default:
      return {
        zoomStart: 1.02,
        zoomEnd: 1.08,
        panSpeed: 0.10
      };
  }
}

function buildFilter({ motion, imageType, width, height, duration, fps }) {
  const frames = duration * fps;
  const profile = getProfile(imageType);

  // Use a slightly larger virtual canvas to reduce visible jitter
  // and give room for pan/crop movement.
  const canvasW = Math.round(width * 1.18);
  const canvasH = Math.round(height * 1.18);

  const zoomStart = profile.zoomStart;
  const zoomEnd = profile.zoomEnd;
  const zoomStep = (zoomEnd - zoomStart) / frames;
  const panSpeed = profile.panSpeed;

  let zExpr;
  let xExpr;
  let yExpr;

  switch (motion) {
    case 'slow_zoom_out':
      zExpr = `'if(lte(on,1),${zoomEnd.toFixed(5)},max(${zoomStart.toFixed(5)},zoom-${zoomStep.toFixed(7)}))'`;
      xExpr = `'${((canvasW - width) / 2).toFixed(2)}'`;
      yExpr = `'${((canvasH - height) / 2).toFixed(2)}'`;
      break;

    case 'pan_left':
      zExpr = `'${Math.max(1.02, zoomStart).toFixed(5)}'`;
      xExpr = `'max(0,${(canvasW - width).toFixed(2)} / 2 - on*${panSpeed.toFixed(4)})'`;
      yExpr = `'${((canvasH - height) / 2).toFixed(2)}'`;
      break;

    case 'pan_right':
      zExpr = `'${Math.max(1.02, zoomStart).toFixed(5)}'`;
      xExpr = `'min(${(canvasW - width).toFixed(2)},${(canvasW - width).toFixed(2)} / 2 + on*${panSpeed.toFixed(4)})'`;
      yExpr = `'${((canvasH - height) / 2).toFixed(2)}'`;
      break;

    case 'drift_up':
      zExpr = `'${Math.max(1.02, zoomStart).toFixed(5)}'`;
      xExpr = `'${((canvasW - width) / 2).toFixed(2)}'`;
      yExpr = `'max(0,${(canvasH - height).toFixed(2)} / 2 - on*${panSpeed.toFixed(4)})'`;
      break;

    case 'drift_down':
      zExpr = `'${Math.max(1.02, zoomStart).toFixed(5)}'`;
      xExpr = `'${((canvasW - width) / 2).toFixed(2)}'`;
      yExpr = `'min(${(canvasH - height).toFixed(2)},${(canvasH - height).toFixed(2)} / 2 + on*${panSpeed.toFixed(4)})'`;
      break;

    case 'diagonal_soft':
      zExpr = `'if(lte(on,1),${zoomStart.toFixed(5)},min(${zoomEnd.toFixed(5)},zoom+${zoomStep.toFixed(7)}))'`;
      xExpr = `'min(${(canvasW - width).toFixed(2)},${(canvasW - width).toFixed(2)} / 2 + on*${(panSpeed * 0.55).toFixed(4)})'`;
      yExpr = `'max(0,${(canvasH - height).toFixed(2)} / 2 - on*${(panSpeed * 0.40).toFixed(4)})'`;
      break;

    case 'slow_zoom_in':
    default:
      zExpr = `'if(lte(on,1),${zoomStart.toFixed(5)},min(${zoomEnd.toFixed(5)},zoom+${zoomStep.toFixed(7)}))'`;
      xExpr = `'${((canvasW - width) / 2).toFixed(2)}'`;
      yExpr = `'${((canvasH - height) / 2).toFixed(2)}'`;
      break;
  }

  return (
    `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,` +
    `crop=${canvasW}:${canvasH},` +
    `zoompan=` +
    `z=${zExpr}:` +
    `d=${frames}:` +
    `x=${xExpr}:` +
    `y=${yExpr}:` +
    `s=${width}x${height}:` +
    `fps=${fps}`
  );
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};

    const image_url = normalizeString(body.image_url);
    const motion = normalizeString(body.motion, 'slow_zoom_in');
    const image_type = normalizeString(body.image_type, 'wide');

    const duration = clamp(Number(body.duration) || 6, 3, 12);
    const width = clamp(Number(body.width) || 1920, 640, 3840);
    const height = clamp(Number(body.height) || 1080, 360, 2160);
    const fps = 30;

    if (!image_url) {
      return res.status(400).json({
        success: false,
        error: 'Missing image_url'
      });
    }

    const supportedMotions = [
      'slow_zoom_in',
      'slow_zoom_out',
      'pan_left',
      'pan_right',
      'drift_up',
      'drift_down',
      'diagonal_soft'
    ];

    const supportedImageTypes = ['wide', 'detail', 'chart', 'portrait'];

    const finalMotion = supportedMotions.includes(motion) ? motion : 'slow_zoom_in';
    const finalImageType = supportedImageTypes.includes(image_type) ? image_type : 'wide';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenburns-'));
    const inputPath = path.join(tmpDir, 'input.jpg');
    const outputPath = path.join(tmpDir, 'output.mp4');

    try {
      const imageResp = await axios.get(image_url, {
        responseType: 'arraybuffer',
        timeout: 30000
      });

      fs.writeFileSync(inputPath, imageResp.data);

      const filter = buildFilter({
        motion: finalMotion,
        imageType: finalImageType,
        width,
        height,
        duration,
        fps
      });

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(inputPath)
          .inputOptions(['-loop', '1'])
          .outputOptions([
            '-vf', filter,
            '-t', String(duration),
            '-r', String(fps),
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '18',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-tune', 'stillimage'
          ])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      const videoBuffer = fs.readFileSync(outputPath);

      const fileName =
        normalizeString(body.output_name) ||
        `kenburns/${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;

      const blob = await put(fileName, videoBuffer, {
        access: 'public',
        addRandomSuffix: true,
        contentType: 'video/mp4'
      });

      return res.status(200).json({
        success: true,
        video_url: blob.url,
        pathname: blob.pathname,
        duration,
        motion: finalMotion,
        image_type: finalImageType
      });
    } finally {
      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }
    }
  } catch (error) {
    console.error('Ken Burns error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Unknown error'
    });
  }
};
