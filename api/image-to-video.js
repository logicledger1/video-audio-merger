const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const axios = require('axios');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image_urls, duration_per_image = 10 } = req.body;

  if (!image_urls || !Array.isArray(image_urls)) {
    return res.status(400).json({ 
      error: 'Missing image_urls array' 
    });
  }

  const tempDir = '/tmp';
  const listFilePath = `${tempDir}/imagelist_${Date.now()}.txt`;
  const outputPath = `${tempDir}/images_video_${Date.now()}.mp4`;

  try {
    // Download each image
    const imagePaths = [];
    for (let i = 0; i < image_urls.length; i++) {
      const imagePath = `${tempDir}/image_${i}_${Date.now()}.jpg`;
      
      const imageResponse = await axios.get(image_urls[i], {
        responseType: 'arraybuffer'
      });
      fs.writeFileSync(imagePath, imageResponse.data);
      imagePaths.push(imagePath);
    }

    // Convert images to video with Ken Burns effect
    const videoSegments = [];
    
    for (let i = 0; i < imagePaths.length; i++) {
      const segmentPath = `${tempDir}/segment_${i}_${Date.now()}.mp4`;
      
      await new Promise((resolve, reject) => {
        // Ken Burns effect: slow zoom and pan
        const zoompan = 'zoompan=z=\'min(zoom+0.0015,1.5)\':d=' + (duration_per_image * 25) + ':s=1920x1080:fps=25';
        
        ffmpeg()
          .input(imagePaths[i])
          .inputOptions([
            '-loop', '1',
            '-t', duration_per_image.toString()
          ])
          .outputOptions([
            '-vf', zoompan,
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'medium'
          ])
          .output(segmentPath)
          .on('start', (cmd) => console.log(`Image ${i} to video:`, cmd))
          .on('end', () => {
            console.log(`Segment ${i} complete`);
            videoSegments.push(segmentPath);
            resolve();
          })
          .on('error', reject)
          .run();
      });
    }

    // Create concat list
    const listContent = videoSegments.map(path => `file '${path}'`).join('\n');
    fs.writeFileSync(listFilePath, listContent);

    // Concatenate all segments
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Read result
    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');

    // Cleanup
    imagePaths.forEach(path => fs.unlinkSync(path));
    videoSegments.forEach(path => fs.unlinkSync(path));
    fs.unlinkSync(listFilePath);
    fs.unlinkSync(outputPath);

    res.json({
      success: true,
      video_base64: videoBase64,
      duration: image_urls.length * duration_per_image,
      size: videoBuffer.length
    });

  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
};
