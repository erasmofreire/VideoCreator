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

console.log('====================================================');
console.log('   VIDEOCREATOR V5 - FLUX ZEROGPU + ROTEIRISTA IA   ');
console.log('====================================================');

const credentialsPath = path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS || 'credentials.json');

if (!fs.existsSync(credentialsPath)) {
  console.error('Arquivo de credenciais do Google Cloud nao encontrado:', credentialsPath);
  process.exit(1);
}

// Define o caminho absoluto na variavel de ambiente oficial do Google e instancia sem parametros (zero avisos de depreciacao!)
process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
const ttsClient = new textToSpeech.TextToSpeechClient();

const rawHfToken = (process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '').trim();
if (rawHfToken) {
  console.log(`[Status .env] HF_TOKEN detectado (${rawHfToken.substring(0, 6)}...${rawHfToken.slice(-4)})`);
}

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
  '1': { name: 'TikTok / Shorts / Reels (9:16)', size: '1080x1920', width: 720, height: 1280, aspectRatio: '9:16' },
  '2': { name: 'YouTube Tradicional (16:9)', size: '1920x1080', width: 1280, height: 720, aspectRatio: '16:9' }
};

const topicInput = getUserInput('\nTema ou texto do video', 'Ferrari');
const videoLength = parseFloat(getUserInput('Digite a duracao do video em segundos', '30')) || 30;

console.log('\nEscolha o formato do video:');
Object.keys(formats).forEach(key => console.log(`${key}: ${formats[key].name}`));

const formatChoice = getUserInput('Opcao', '1');
const selectedFormat = formats[formatChoice] || formats['1'];

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Traduz automaticamente o tema de Portugues para Ingles
const translateToEnglish = async (textPt) => {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=pt&tl=en&dt=t&q=${encodeURIComponent(textPt)}`;
    const res = await axios.get(url, { timeout: 10000 });
    const translated = res.data?.[0]?.map(item => item[0]).join('') || textPt;
    return translated.trim();
  } catch (e) {
    return textPt;
  }
};

// Gera roteiro local ajustado proporcionalmente a duracao do video (15s, 30s, 60s)
const buildDynamicLocalScript = (topic, durationSeconds) => {
  if (topic.trim().length > 40) return topic.trim();

  const part1 = `Descubra tudo sobre ${topic}. Muito mais do que imaginamos no dia a dia, ${topic} reúne história, inovação e detalhes impressionantes que transformam a nossa visão de mundo.`;
  const part2 = `Desde a sua criação até os dias atuais, cada elemento foi pensado para entregar máxima performance, estilo inconfundível e uma experiência verdadeiramente única para quem admira a perfeição.`;
  const part3 = `Não é por acaso que ${topic} continua despertando tanta fascinação ao redor do planeta, tornando-se uma referência absoluta em sua categoria. Acompanhe cada detalhe dessa jornada surpreendente!`;

  if (durationSeconds <= 18) return part1;
  if (durationSeconds <= 35) return `${part1} ${part2}`;
  return `${part1} ${part2} ${part3}`;
};

// Passo 0: Traduz o tema para Ingles e cria roteiro inedito
const generateScriptAndPrompts = async (topic, durationSeconds) => {
  const englishTopic = await translateToEnglish(topic);
  console.log(`\n[Tradutor IA] Tema convertido para Ingles: "${topic}" -> "${englishTopic}"`);

  const defaultScenes = [
    `Close-up cinematic photorealistic shot of ${englishTopic}, dramatic natural lighting, ultra detailed, 8k resolution`,
    `Wide angle panoramic view of ${englishTopic} in motion, breathtaking scenery, movie scene, masterpiece photography`,
    `Aerial golden hour perspective of ${englishTopic}, vibrant colors, award winning automotive and lifestyle photo`
  ];

  // Se o proprio usuario ja digitou um texto longo de narracao, usa direto
  if (topic.trim().length > 40) {
    return { narration: topic.trim(), scenes: defaultScenes };
  }

  const wordCount = Math.max(25, Math.floor(durationSeconds * 2.3));

  // Tenta buscar curiosidades reais na Wikipedia em Portugues para enriquecer a narracao gratuitamente!
  try {
    console.log(`[IA Roteirista] Pesquisando fatos reais sobre "${topic}" para a narracao...`);
    const wikiUrl = `https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.trim())}`;
    const wikiRes = await axios.get(wikiUrl, {
      headers: { 'User-Agent': 'VideoCreatorBot/5.0 (NodeJS)' },
      timeout: 8000
    });

    const extract = wikiRes.data?.extract;
    if (extract && extract.length > 60) {
      // Ajusta o tamanho do resumo para caber nos segundos do video (~14 caracteres por segundo de fala)
      const maxChars = Math.floor(durationSeconds * 13.5);
      const sentences = extract.split(/(?<=[.!?])\s+/);
      let finalScript = '';

      for (const s of sentences) {
        if ((finalScript + ' ' + s).length <= maxChars || finalScript.length < 80) {
          finalScript = (finalScript + ' ' + s).trim();
        } else {
          break;
        }
      }

      if (finalScript.length > 40) {
        console.log(`[Roteiro Real Criado (${finalScript.split(' ').length} palavras)]: "${finalScript}"`);
        return { narration: finalScript, scenes: defaultScenes };
      }
    }
  } catch (_) {
    // Se nao achar artigo exato, usa o gerador dinamico por tempo
  }

  const fallbackText = buildDynamicLocalScript(topic, durationSeconds);
  console.log(`[Roteiro Automatico (${durationSeconds}s)]: "${fallbackText}"`);
  return { narration: fallbackText, scenes: defaultScenes };
};

// Passo 1: Gera audio localmente via Google Cloud TTS
const generateNarration = async (textToSynthesize) => {
  const voiceConfigs = [
    { languageCode: 'pt-BR', name: 'pt-BR-Neural2-B', ssmlGender: 'MALE' },
    { languageCode: 'pt-BR', ssmlGender: 'MALE' }
  ];

  for (const voice of voiceConfigs) {
    try {
      const [response] = await ttsClient.synthesizeSpeech({
        input: { text: textToSynthesize },
        voice: voice,
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 }
      });

      if (response && response.audioContent) {
        const narrationPath = path.resolve(__dirname, 'narration.mp3');
        await util.promisify(fs.writeFile)(narrationPath, response.audioContent, 'binary');
        const stats = fs.statSync(narrationPath);
        console.log(`Audio narration.mp3 gerado com sucesso! (${(stats.size / 1024).toFixed(1)} KB)`);
        return narrationPath;
      }
    } catch (error) {
      console.warn(`Tentando outra voz TTS:`, error.message);
    }
  }
  return null;
};

// MOTOR PRINCIPAL: Hugging Face ZeroGPU Gradio Space (FLUX.1-schnell Oficial - Funcionando 100%!)
const generateWithHFZeroGPUSpace = async (prompt, outputPath, width, height) => {
  const spaceUrl = 'https://black-forest-labs-flux-1-schnell.hf.space';
  const headers = { 'Content-Type': 'application/json' };
  if (rawHfToken) headers['Authorization'] = `Bearer ${rawHfToken}`;

  const w = width > height ? 1024 : 768;
  const h = height > width ? 1024 : 768;

  const callRes = await axios.post(
    `${spaceUrl}/gradio_api/call/infer`,
    {
      data: [prompt, 0, true, w, h, 4]
    },
    { headers, timeout: 20000 }
  );

  const eventId = callRes.data?.event_id;
  if (!eventId) throw new Error('Space ZeroGPU ocupado');

  const streamRes = await axios.get(`${spaceUrl}/gradio_api/call/infer/${eventId}`, {
    headers,
    responseType: 'text',
    timeout: 50000
  });

  const lines = streamRes.data.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const parsed = JSON.parse(line.replace('data: ', '').trim());
        const fileUrl = parsed?.[0]?.url;
        if (fileUrl) {
          const imgRes = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 25000 });
          await util.promisify(fs.writeFile)(outputPath, Buffer.from(imgRes.data));
          return 'FLUX.1-schnell (ZeroGPU Space)';
        }
      } catch (_) {}
    }
  }

  throw new Error('ZeroGPU Space nao retornou imagem');
};

// MOTOR SECUNDARIO DE BACKUP: AI Horde (Cluster Stable Diffusion 100% Gratuito)
const generateWithStableHorde = async (prompt, outputPath, width, height) => {
  const sdWidth = width > height ? 576 : 384;
  const sdHeight = height > width ? 576 : 384;

  const submitRes = await axios.post(
    'https://stablehorde.net/api/v2/generate/async',
    {
      prompt: `${prompt} ### blurry, ugly, deformed, bad anatomy, text, watermark`,
      params: {
        width: sdWidth,
        height: sdHeight,
        steps: 22,
        cfg_scale: 7.5,
        sampler_name: 'k_euler_a'
      },
      nsfw: false,
      censor_nsfw: true
    },
    {
      headers: {
        'apikey': process.env.HORDE_API_KEY || '0000000000',
        'Client-Agent': 'VideoCreatorCLI:5.0:NodeJS'
      },
      timeout: 15000
    }
  );

  const jobId = submitRes.data.id;
  for (let check = 0; check < 22; check++) {
    await delay(3500);
    const statusRes = await axios.get(`https://stablehorde.net/api/v2/generate/status/${jobId}`, {
      headers: { 'Client-Agent': 'VideoCreatorCLI:5.0:NodeJS' }
    });

    if (statusRes.data.done && statusRes.data.generations?.length > 0) {
      const imgUrl = statusRes.data.generations[0].img;
      const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 25000 });
      await util.promisify(fs.writeFile)(outputPath, Buffer.from(imgRes.data));
      return true;
    }
  }
  throw new Error('Fila do AI Horde demorou muito');
};

// Passo 2: Orquestrador de Imagens (Direto no FLUX.1-schnell ZeroGPU -> Backup AI Horde)
const generateImagesWithAI = async (scenes, formatObj) => {
  const localImagePaths = [];

  for (let i = 0; i < scenes.length; i++) {
    const scenePrompt = scenes[i];
    const localImagePath = path.resolve(__dirname, `ai_img_${i + 1}.webp`);
    let saved = false;

    console.log(`\nGerando cena ${i + 1}/${scenes.length} via FLUX.1-schnell...`);

    // 1. Vai direto no Hugging Face ZeroGPU Space (que funcionou perfeitamente na sua conta!)
    try {
      const spaceUsed = await generateWithHFZeroGPUSpace(scenePrompt, localImagePath, formatObj.width, formatObj.height);
      saved = true;
      console.log(` -> SUCESSO! Cena ${i + 1} gerada via ${spaceUsed}!`);
    } catch (e) {
      console.warn(` -> Aviso ZeroGPU (${e.message}). Acionando backup AI Horde...`);
    }

    // 2. Fallback Garantido: AI Horde
    if (!saved) {
      try {
        await generateWithStableHorde(scenePrompt, localImagePath, formatObj.width, formatObj.height);
        saved = true;
        console.log(` -> Cena ${i + 1} gerada com sucesso via AI Horde!`);
      } catch (e) {
        console.warn(` -> Aviso AI Horde: ${e.message}`);
      }
    }

    if (saved) {
      localImagePaths.push(localImagePath);
    } else if (localImagePaths.length > 0) {
      localImagePaths.push(localImagePaths[localImagePaths.length - 1]);
    }
  }

  return localImagePaths;
};

// Passo 3: Transforma cada imagem em um clipe animado (Efeito Camera em Movimento / Ken Burns)
const createAnimatedClips = async (imagePaths, clipDuration, resolution) => {
  const [width, height] = resolution.split('x');
  const fps = 25;
  const totalFrames = Math.ceil(clipDuration * fps);
  const clipPaths = [];

  for (let i = 0; i < imagePaths.length; i++) {
    const clipPath = path.resolve(__dirname, `temp_clip_${i + 1}.mp4`);
    console.log(`Animando cena ${i + 1}/${imagePaths.length} com movimento de camera...`);

    let zoomExpr = `min(zoom+0.0015,1.35)`;
    if (i === 1) zoomExpr = `if(eq(on,1),1.35,max(1.05,zoom-0.0015))`;
    if (i === 2) zoomExpr = `min(zoom+0.0018,1.40)`;

    await new Promise((resolve, reject) => {
      ffmpeg(imagePaths[i])
        .loop(clipDuration)
        .fps(fps)
        .outputOptions([
          '-c:v libx264',
          '-preset veryfast',
          '-pix_fmt yuv420p',
          `-vf scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps},format=yuv420p`,
          `-t ${clipDuration}`
        ])
        .output(clipPath)
        .on('end', () => {
          clipPaths.push(clipPath);
          resolve();
        })
        .on('error', (err) => reject(err))
        .run();
    });
  }

  return clipPaths;
};

// Passo 4: Junta os clipes animados com a narracao
const buildVideoWithFFmpeg = async (imagePaths, audioPath, outputPath, resolution, totalDuration) => {
  const clipDuration = parseFloat((totalDuration / imagePaths.length).toFixed(2));
  const clipPaths = await createAnimatedClips(imagePaths, clipDuration, resolution);

  return new Promise((resolve, reject) => {
    const listFilePath = path.resolve(__dirname, 'clips.txt');

    let fileContent = '';
    clipPaths.forEach(clip => {
      fileContent += `file '${clip.replace(/\\/g, '/')}'\n`;
    });

    fs.writeFileSync(listFilePath, fileContent);

    ffmpeg()
      .input(listFilePath)
      .inputOptions(['-f concat', '-safe 0'])
      .input(audioPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        '-c:v copy',
        '-c:a aac',
        '-b:a 192k',
        `-t ${totalDuration}`
      ])
      .output(outputPath)
      .on('start', () => {
        console.log(`\nUnindo animacoes e narracao no video final...`);
      })
      .on('end', () => {
        if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath);
        clipPaths.forEach(clip => { if (fs.existsSync(clip)) fs.unlinkSync(clip); });

        console.log(`\nVideo animado finalizado com sucesso: ${outputPath}`);
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
    const safeTitle = sanitizeFileName(topicInput);
    const outputFileName = `video-${safeTitle || 'final'}.mp4`;
    const outputPath = path.resolve(__dirname, outputFileName);

    console.log(`\nArquivo final sera salvo como: ${outputFileName}`);

    const scriptData = await generateScriptAndPrompts(topicInput, videoLength);

    console.log('\n[1/3] Gerando audio da narracao...');
    const audioPath = await generateNarration(scriptData.narration);
    if (!audioPath) return;

    console.log(`\n[2/3] Gerando 3 imagens de alta definicao via FLUX.1-schnell...`);
    const imagePaths = await generateImagesWithAI(scriptData.scenes, selectedFormat);

    if (imagePaths.length === 0) {
      console.error('Nenhuma imagem foi gerada.');
      return;
    }

    console.log('\n[3/3] Criando animacoes de camera e compilando o video final...');
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