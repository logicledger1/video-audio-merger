const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { put } = require('@vercel/blob');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

function getImageTypeConfig(imageType) {
  switch (imageType) {
    case 'portrait':
      return {
        zoomStart: 1.03,
        zoomEnd: 1.12,
        moveSpeed: 0.18
      };
    case 'detail':
      return {
        zoomStart: 1.05,
        zoomEnd: 1.16,
        moveSpeed: 0.16
      };
    case 'chart':
      return {
        zoomStart: 1.0,
        zoomEnd: 1.06,
        moveSpeed: 0.1
      };
    case 'wide':
    default:
      return {
        zoomStart: 1.0,
        zoomEnd: 1.1,
        moveSpeed: 0.14
      };
  }
}

function buildZoomPanFilter({
  width,
  height,
  duration,
  fps,
  motion,
  imageType
}) {
  const frames = duration * fps;
  const cfg = getImageTypeConfig(imageType);

  const zoomStart = cfg.zoomStart;
  const zoomEnd = cfg.zoomEnd;
  const zoomStep = (zoomEnd - zoomStart) / frames;
  const moveSpeed = cfg.moveSpeed;

  let zExpr;
  let xExpr;
  let yExpr;

  switch (motion) {
    case 'slow_zoom_out':
      zExpr = `'if(lte(on,1),${zoomEnd.toFixed(4)},max(${zoomStart.toFixed(
        4
      )},zoom-${zoomStep.toFixed(6)}))'`;
      xExpr = `'iw/2-(iw/zoom/2)'`;
      yExpr = `'ih/2-(ih/zoom/2)'`;
      break;

    case 'pan_left':
      zExpr = `'${Math.max(1.04, zoomStart).toFixed(4)}'`;
      xExpr = `'max(0,iw/2-(iw/zoom/2)-on*${moveSpeed.toFixed(3)})'`;
      yExpr = `'ih/2-(ih/zoom/2)'`;
      break;

    case 'pan_right':
      zExpr = `'${Math.max(1.04, zoomStart).toFixed(4)}'`;
      xExpr = `'min(iw-iw/zoom,iw/2-(iw/zoom/2)+on*${moveSpeed.toFixed(3)})'`;
      yExpr = `'ih/2-(ih/zoom/2)'`;
      break;

    case 'drift_up':
      zExpr = `'${Math.max(1.04, zoomStart).toFixed(4)}'`;
      xExpr = `'iw/2-(iw/zoom/2)'`;
      yExpr = `'max(0,ih/2-(ih/zoom/2)-on*${moveSpeed.toFixed(3)})'`;
      break;

    case 'drift_down':
      zExpr = `'${Math.max(1.04, zoomStart).toFixed(4)}'`;
      xExpr = `'iw/2-(iw/zoom/2)'`;
      yExpr = `'min(ih-ih/zoom,ih/2-(ih/zoom/2)+on*${moveSpeed.toFixed(3)})'`;
      break;

    case 'diagonal_soft':
      zExpr = `'if(lte(on,1),${zoomStart.toFixed(4)},min(${zoomEnd.toFixed(
        4
      )},zoom+${zoomStep.toFixed(6)}))'`;
      xExpr = `'min(iw-iw/zoom,iw/2-(iw/zoom/2)+on*${(moveSpeed * 0.55).toFixed(3)})'`;
      yExpr = `'max(0,ih/2-(ih/zoom/2)-on*${(moveSpeed * 0.45).toFixed(3)})'`;
      break;

    case 'slow_zoom_in':
    default:
      zExpr = `'if(lte(on,1),${zoomStart.toFixed(4)},min(${zoomEnd.toFixed(
        4
      )},zoom+${zoomStep.toFixed(6)}))'`;
      xExpr = `'iw/2-(iw/zoom/2)'`;
      yExpr = `'ih/2-(ih/zoom/2)'`;
      break;
  }

  return (
    `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},` +
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
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    image_url,
    duration = 6,
    width = 1920,
    height = 1080,
    motion = 'slow_zoom_in',
    image_type = 'wide',
    output_name
  } = req.body || {};

  if (!image_url) {
    return res.status(400).json({ error: 'Missing image_url' });
  }

  const safeDuration = Math.max(3, Math.min(12, Number(duration) || 6));
  const safeWidth = Math.max(640, Number(width) || 1920);
  const safeHeight = Math.max(360, Number(height) || 1080);
  const fps = 30;

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
  const finalImageType = supportedImageTypes.includes(image_type)
    ? image_type
    : 'wide';

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenburns-'));
  const inputPath = path.join(tempDir, 'input.jpg');
  const outputPath = path.join(tempDir, 'output.mp4');

  try {
    const imageResp = await axios.get(image_url, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    fs.writeFileSync(inputPath, imageResp.data);

    const filter = buildZoomPanFilter({
      width: safeWidth,
      height: safeHeight,
      duration: safeDuration,
      fps,
      motion: finalMotion,
      imageType: finalImageType
    });

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(inputPath)
        .inputOptions(['-loop', '1'])
        .outputOptions([
          '-vf', filter,
          '-t', String(safeDuration),
          '-r', String(fps),
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '20',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const videoBuffer = fs.readFileSync(outputPath);

    const fileName =
      output_name ||
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
      duration: safeDuration,
      motion: finalMotion,
      image_type: finalImageType
    });
  } catch (error) {
    console.error('Ken Burns error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Unknown error'
    });
  } finally {
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
  }
};
