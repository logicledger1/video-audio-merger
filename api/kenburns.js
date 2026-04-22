const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { put } = require('@vercel/blob');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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
    output_name
  } = req.body || {};

  if (!image_url) {
    return res.status(400).json({ error: 'Missing image_url' });
  }

  const safeDuration = Math.max(3, Math.min(12, Number(duration) || 6));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenburns-'));
  const inputPath = path.join(tempDir, 'input.jpg');
  const outputPath = path.join(tempDir, 'output.mp4');

  try {
    const imageResp = await axios.get(image_url, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    fs.writeFileSync(inputPath, imageResp.data);

    const fps = 30;
    const totalFrames = safeDuration * fps;

    let zoompan;

    if (motion === 'slow_zoom_out') {
      zoompan = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='if(lte(on,1),1.12,max(1.0,zoom-0.0007))':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
    } else if (motion === 'pan_left') {
      zoompan = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='1.06':d=${totalFrames}:x='max(0,iw/2-(iw/zoom/2)-on*0.6)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
    } else if (motion === 'pan_right') {
      zoompan = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='1.06':d=${totalFrames}:x='min(iw-iw/zoom,iw/2-(iw/zoom/2)+on*0.6)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
    } else {
      zoompan = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='min(1.12,zoom+0.0007)':d=${totalFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
    }

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(inputPath)
        .inputOptions(['-loop', '1'])
        .outputOptions([
          '-vf', zoompan,
          '-t', String(safeDuration),
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-preset', 'veryfast',
          '-crf', '22',
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
      motion
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
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
  }
};
