const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const axios = require('axios');
const fs = require('fs');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

module.exports = async (req, res) => {
  try {
    const video_url = req.query.video_url || req.body?.video_url;
    const audio_base64 = req.query.audio_base64 || req.body?.audio_base64;

    if (!video_url) {
      return res.status(400).json({ error: 'video_url is required' });
    }

    if (!audio_base64) {
      return res.status(400).json({ error: 'audio_base64 is required' });
    }

    // Download video
    const videoResponse = await axios.get(video_url, { responseType: 'arraybuffer' });
    const videoPath = `/tmp/input_video_${Date.now()}.mp4`;
    await writeFile(videoPath, videoResponse.data);

    // Decode base64 audio and save
    const audioBuffer = Buffer.from(audio_base64, 'base64');
    const audioPath = `/tmp/input_audio_${Date.now()}.mp3`;
    await writeFile(audioPath, audioBuffer);

    // Output path
    const outputPath = `/tmp/output_${Date.now()}.mp4`;

    // Merge video and audio
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-shortest'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Read merged video
    const mergedVideo = await fs.promises.readFile(outputPath);
    
    // Cleanup
    await Promise.all([
      unlink(videoPath),
      unlink(audioPath),
      unlink(outputPath)
    ]).catch(() => {});

    // Return as base64
    res.status(200).json({
      success: true,
      video: mergedVideo.toString('base64'),
      size: mergedVideo.length
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
};
