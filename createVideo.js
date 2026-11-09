require('dotenv').config();
const readline = require('readline-sync');
const fs = require('fs');
const path = require('path');
const textToSpeech = require('@google-cloud/text-to-speech');
const util = require('util');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const axios = require('axios');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const credentialsPath = path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS || 'credentials.json');

if (!fs.existsSync(credentialsPath)) {
  console.error('Arquivo de credenciais do Google Cloud nao encontrado:', credentialsPath);
  process.exit(1);
}

// Inicializacao do TTS
const ttsClient = new textToSpeech.TextToSpeechClient({ keyFile: credentialsPath });

const getUserInput = (question, defaultValue) => {
  const input = readline.question(`${question} (default: ${defaultValue}): `);
  return input.trim() === '' ? defaultValue : input;
};

const sanitizeFileName = (text) => {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

const formats = {
  '1': { name: 'TikTok / Shorts / Reels (9:16)', size: '1080x1920', width: 720, height: 1280 },
  '2': { name: 'YouTube Tradicional (16:9)', size: '1920x1080', width: 1280, height: 720 }
};

const text = getUserInput('Texto do titulo e narracao', 'Viagem');
const videoLength = parseFloat(getUserInput('Digite a duracao do video em segundos', '15'));

console.log('\nEscolha o formato do video:');
Object.keys(formats).forEach(key => console.log(`${key}: ${formats[key].name}`));

const formatChoice = getUserInput('Opcao', '1');
const selectedFormat = formats[formatChoice] || formats['1'];

// O tema das imagens assume automaticamente o proprio texto digitado
const themePrompt = text;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 1. Gera audio localmente via Google Cloud TTS
const generateNarration = async (textToSynthesize) => {
  const request = {
    input: { text: textToSynthesize },
    voice: { languageCode: 'pt-BR', ssmlGender: 'MALE' },
    audioConfig: { audioEncoding: 'MP3' },
  };

  try {
    const [response] = await ttsClient.synthesizeSpeech(request);
    const narrationPath = path.resolve(__dirname, 'narration.mp3');
    await util.promisify(fs.writeFile)(narrationPath, response.audioContent, 'binary');
    return narrationPath;
  } catch (error) {
    console.error('Erro na narracao:', error.message);
    return null;
  }
};

// 2. Gera imagens por IA usando o motor Turbo gratuito (sem 402 e sem 404)
const generateImagesWithAI = async (prompt, count = 3, width = 720, height = 1280) => {
  const localImagePaths = [];

  for (let i = 0; i < count; i++) {
    try {
      console.log(`Gerando imagem ${i + 1}/${count} via IA para o tema "${prompt}"...`);

      const seed = Math.floor(Math.random() * 9999999);
      const variations = [
        'cenario deslumbrante, close up em detalhes',
        'vista panoramica angular, cinematografico',
        'fotografia realista, iluminacao de cinema, 8k'
      ];
      const styleModifier = variations[i % variations.length];
      const enhancedPrompt = encodeURIComponent(`${prompt}, ${styleModifier}`);

      // Usando o modelo "turbo", que e 100% gratuito e nao tem o bloqueio 402 do flux
      const imageUrl = `https://image.pollinations.ai/prompt/${enhancedPrompt}?width=${width}&height=${height}&seed=${seed}&nologo=true&model=turbo`;

      const response = await axios({
        url: imageUrl,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 45000
      });

      const localImagePath = path.resolve(__dirname, `ai_img_${i + 1}.jpg`);
      await util.promisify(fs.writeFile)(localImagePath, Buffer.from(response.data));

      localImagePaths.push(localImagePath);
      console.log(`Imagem ${i + 1} gerada com sucesso!`);

      if (i < count - 1) {
        await delay(2000);
      }
    } catch (err) {
      console.error(`Falha ao gerar imagem ${i + 1}:`, err.message);

      if (localImagePaths.length > 0) {
        console.log(`Duplicando imagem anterior como fallback para a cena ${i + 1}...`);
        localImagePaths.push(localImagePaths[0]);
      }
    }
  }

  return localImagePaths;
};

// 3. Monta o video final com FFmpeg
const buildVideoWithFFmpeg = (imagePaths, audioPath, outputPath, resolution, totalDuration) => {
  return new Promise((resolve, reject) => {
    const listFilePath = path.resolve(__dirname, 'images.txt');
    const imageDuration = (totalDuration / imagePaths.length).toFixed(2);

    let fileContent = '';
    imagePaths.forEach(imgPath => {
      const normalizedPath = imgPath.replace(/\\/g, '/');
      fileContent += `file '${normalizedPath}'\nduration ${imageDuration}\n`;
    });
    fileContent += `file '${imagePaths[imagePaths.length - 1].replace(/\\/g, '/')}'\n`;

    fs.writeFileSync(listFilePath, fileContent);

    const [width, height] = resolution.split('x');

    ffmpeg()
      .input(listFilePath)
      .inputOptions(['-f concat', '-safe 0'])
      .input(audioPath)
      .outputOptions([
        '-c:v libx264',
        '-pix_fmt yuv420p',
        `-vf scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        `-t ${totalDuration}`,
        '-c:a aac',
        '-b:a 192k'
      ])
      .output(outputPath)
      .on('start', () => {
        console.log(`\nProcessando video de ${totalDuration}s localmente com FFmpeg...`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          process.stdout.write(`Progresso: ${Math.round(progress.percent)}%\r`);
        }
      })
      .on('end', () => {
        if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath);
        console.log(`\nVideo finalizado com sucesso: ${outputPath}`);
        resolve();
      })
      .on('error', (err) => {
        if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath);
        console.error('\nErro no FFmpeg:', err.message);
        reject(err);
      })
      .run();
  });
};

// Fluxo principal
const createVideo = async () => {
  try {
    const safeTitle = sanitizeFileName(text);
    const outputFileName = `video-${safeTitle || 'final'}.mp4`;
    const outputPath = path.resolve(__dirname, outputFileName);

    console.log(`\nArquivo final sera salvo como: ${outputFileName}`);

    console.log('\n[1/3] Gerando audio da narracao...');
    const audioPath = await generateNarration(text);
    if (!audioPath) return;

    console.log(`\n[2/3] Gerando imagens via IA com o tema automatico: "${themePrompt}"...`);
    const imagePaths = await generateImagesWithAI(
      themePrompt,
      3,
      selectedFormat.width,
      selectedFormat.height
    );

    if (imagePaths.length === 0) {
      console.error('Nenhuma imagem foi gerada.');
      return;
    }

    console.log('\n[3/3] Compilando o video final...');
    await buildVideoWithFFmpeg(
      imagePaths,
      audioPath,
      outputPath,
      selectedFormat.size,
      videoLength
    );
  } catch (error) {
    console.error('Falha geral no processo:', error.message);
  }
};

createVideo();