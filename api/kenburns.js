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

function buildFilter({ motion, width, height, duration, fps }) {
  // We avoid zoompan because it often causes jitter/strobe on stills.
  // Instead we animate with scale=eval=frame and then crop center.

  const zoomAmount = 0.06; // 6% total zoom over the clip
  const durationSec = duration;

  let scaleExprW;
  let scaleExprH;

  if (motion === 'slow_zoom_out') {
    // Start slightly zoomed in, then slowly zoom out to 1.0
    scaleExprW = `'${Math.round(width * (1 + zoomAmount))} - (${Math.round(width * zoomAmount)}*t/${durationSec})'`;
    scaleExprH = `'${Math.round(height * (1 + zoomAmount))} - (${Math.round(height * zoomAmount)}*t/${durationSec})'`;
  } else {
    // Start normal, then slowly zoom in
    scaleExprW = `'${width} + (${Math.round(width * zoomAmount)}*t/${durationSec})'`;
    scaleExprH = `'${height} + (${Math.round(height * zoomAmount)}*t/${durationSec})'`;
  }

  return [
    `fps=${fps}`,
    `scale=w=${scaleExprW}:h=${scaleExprH}:eval=frame:flags=lanczos`,
    `crop=${width}:${height}:(iw-${width})/2:(ih-${height})/2`,
    `setsar=1`
  ].join(',');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    const body = req.body || {};

    const image_url = normalizeString(body.image_url);
    const requestedMotion = normalizeString(body.motion, 'slow_zoom_in');
    const output_name = normalizeString(body.output_name, '');

    const duration = clamp(Number(body.duration) || 6, 3, 12);
    const width = clamp(Number(body.width) || 1920, 640, 3840);
    const height = clamp(Number(body.height) || 1080, 360, 2160);

    const fps = 60;

    if (!image_url) {
      return res.status(400).json({
        success: false,
        error: 'Missing image_url'
      });
    }

    const motion =
      requestedMotion === 'slow_zoom_out' ? 'slow_zoom_out' : 'slow_zoom_in';

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
        motion,
        width,
        height,
        duration,
        fps
      });

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(inputPath)
          .inputOptions([
            '-loop', '1',
            '-framerate', String(fps)
          ])
          .outputOptions([
            '-vf', filter,
            '-t', String(duration),
            '-r', String(fps),
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '18',
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
        duration,
        motion
      });
    } finally {
      try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
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
