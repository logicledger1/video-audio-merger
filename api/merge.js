const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { video_url, audio_url } = req.body;

    if (!video_url || !audio_url) {
      return res.status(400).json({ error: 'video_url and audio_url are required' });
    }

    // Download video
    const videoResponse = await axios.get(video_url, { responseType: 'arraybuffer' });
    const videoPath = `/tmp/input_video_${Date.now()}.mp4`;
    await writeFile(videoPath, videoResponse.data);

    // Download audio
    const audioResponse = await axios.get(audio_url, { responseType: 'arraybuffer' });
    const audioPath = `/tmp/input_audio_${Date.now()}.mp3`;
    await writeFile(audioPath, audioResponse.data);

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
