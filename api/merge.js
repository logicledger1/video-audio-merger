const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const axios = require('axios');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { video_url, audio_base64 } = req.body;

  if (!video_url || !audio_base64) {
    return res.status(400).json({ 
      error: 'Missing video_url or audio_base64' 
    });
  }

  const tempDir = '/tmp';
  const videoPath = `${tempDir}/video_${Date.now()}.mp4`;
  const audioPath = `${tempDir}/audio_${Date.now()}.mp3`;
  const mergedPath = `${tempDir}/merged_${Date.now()}.mp4`;

  try {
    // Download video
    const videoResponse = await axios.get(video_url, {
      responseType: 'arraybuffer'
    });
    fs.writeFileSync(videoPath, videoResponse.data);

    // Save audio
    const audioBuffer = Buffer.from(audio_base64, 'base64');
    fs.writeFileSync(audioPath, audioBuffer);

    // Merge with FFmpeg - explicitly map video and audio streams
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          '-map', '0:v:0',          // Use video from first input
          '-map', '1:a:0',          // Use audio from second input
          '-c:v', 'copy',           // Copy video codec
          '-c:a', 'aac',            // Convert audio to AAC
          '-b:a', '128k',           // Audio bitrate
          '-shortest',              // Match shortest stream
          '-strict', 'experimental'
        ])
        .output(mergedPath)
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine);
        })
        .on('end', () => {
          console.log('Merge complete');
          resolve();
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err.message);
          reject(err);
        })
        .run();
    });

    // Read the merged video
    const videoBuffer = fs.readFileSync(mergedPath);

    // Check if binary format is requested
    const returnBinary = req.query.format === 'binary';

    if (returnBinary) {
      // Return as binary file (for direct upload to Dropbox)
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', videoBuffer.length);
      res.send(videoBuffer);
    } else {
      // Return as base64 JSON (default behavior)
      const videoBase64 = videoBuffer.toString('base64');
      
      res.json({
        success: true,
        video: videoBase64,
        size: videoBuffer.length
      });
    }

    // Cleanup
    fs.unlinkSync(videoPath);
    fs.unlinkSync(audioPath);
    fs.unlinkSync(mergedPath);

  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
};
