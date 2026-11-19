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
console.log('   VIDEOCREATOR V11 - PIXABAY -> IA FLUX -> UNSPLASH');
console.log('====================================================');

const credentialsPath = path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS || 'credentials.json');

if (!fs.existsSync(credentialsPath)) {
  console.error('Arquivo de credenciais do Google Cloud nao encontrado:', credentialsPath);
  process.exit(1);
}

process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
const ttsClient = new textToSpeech.TextToSpeechClient();

const rawPixabayKey = (process.env.PIXABAY_API_KEY || '').trim();
const rawHfToken = (process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '').trim();
const rawUnsplashKey = (process.env.UNSPLASH_ACCESS_KEY || '').trim();

if (rawPixabayKey) console.log('[Status .env] 1. PIXABAY_API_KEY detectada');
if (rawHfToken) console.log('[Status .env] 2. HF_TOKEN detectado (IA FLUX ativa)');
if (rawUnsplashKey) console.log('[Status .env] 3. UNSPLASH_ACCESS_KEY detectada');

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
  '1': { name: 'TikTok / Shorts / Reels (9:16)', size: '1080x1920', width: 720, height: 1280, orientation: 'vertical' },
  '2': { name: 'YouTube Tradicional (16:9)', size: '1920x1080', width: 1280, height: 720, orientation: 'horizontal' }
};

const topicInput = getUserInput('\nTema ou texto completo da narracao', 'Ferrari');
const targetLength = parseFloat(getUserInput('Duracao desejada do video em segundos', '30')) || 30;

console.log('\nEscolha o formato do video:');
Object.keys(formats).forEach(key => console.log(`${key}: ${formats[key].name}`));
const formatChoice = getUserInput('Opcao', '1');
const selectedFormat = formats[formatChoice] || formats['1'];

// Mede a duracao exata do audio MP3 gerado usando o proprio FFmpeg
const getAudioDuration = (audioPath) => {
  return new Promise((resolve) => {
    let stderrOutput = '';

    ffmpeg(audioPath)
      .outputOptions(['-f null'])
      .output('-')
      .on('stderr', (line) => {
        stderrOutput += line + '\n';
      })
      .on('end', () => {
        const match = stderrOutput.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
        if (match) {
          const hours = parseFloat(match[1]);
          const minutes = parseFloat(match[2]);
          const seconds = parseFloat(match[3]);
          resolve((hours * 3600) + (minutes * 60) + seconds);
        } else {
          resolve(null);
        }
      })
      .on('error', () => resolve(null))
      .run();
  });
};

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

// MOTOR ROTEIRISTA 1: LLM Criativo Gratuito
const generateCreativeScriptWithAI = async (topic, durationSeconds, englishTopic) => {
  const targetWords = Math.max(25, Math.floor(durationSeconds * 2.3));
  const randomSeed = Math.floor(Math.random() * 999999);

  const systemPrompt = `Você é um roteirista criativo de vídeos educativos e documentários curtos (estilo YouTube Shorts e TikTok).
Sua missão é explicar o assunto pedido de forma cativante, clara, informativa e original, trazendo curiosidades, como funciona ou sua importância histórica.
Nunca use frases genéricas como "Descubra tudo sobre..." ou "Muito mais do que imaginamos...". Vá direto ao conteúdo explicando o tema!`;

  const userPrompt = `Crie um roteiro para um vídeo de ${durationSeconds} segundos sobre o tema: "${topic}".
Retorne APENAS um JSON válido (sem markdown, sem \`\`\`json) exatamente com esta estrutura:
{
  "narration": "Texto corrido em português do Brasil com aproximadamente ${targetWords} palavras, pronto para ser lido por um locutor, sem emojis, sem asteriscos e sem indicações de cena.",
  "searchKeywords": "${englishTopic}",
  "scenes": [
    "Detailed photorealistic prompt in English for scene 1 specific to ${englishTopic}, cinematic lighting, 8k",
    "Detailed photorealistic prompt in English for scene 2 showing another angle or aspect of ${englishTopic}, 8k",
    "Detailed photorealistic prompt in English for scene 3 showing the impact or epic view of ${englishTopic}, 8k"
  ]
}`;

  const response = await axios.post(
    'https://text.pollinations.ai/openai',
    {
      model: 'openai',
      seed: randomSeed,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' }
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 25000
    }
  );

  const rawContent = response.data?.choices?.[0]?.message?.content || '';
  const cleanedJson = rawContent.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleanedJson);

  if (!parsed.narration || parsed.narration.length < 30 || !Array.isArray(parsed.scenes) || parsed.scenes.length < 3) {
    throw new Error('Resposta incompleta do roteirista IA');
  }

  return {
    narration: parsed.narration.replace(/[*#"`]/g, '').trim(),
    searchKeywords: parsed.searchKeywords || englishTopic,
    scenes: parsed.scenes.slice(0, 3)
  };
};

// MOTOR ROTEIRISTA 2 (Fallback): Busca Inteligente na Wikipedia
const generateScriptFromSmartWikipedia = async (topic, durationSeconds, englishTopic) => {
  const targetChars = Math.floor(durationSeconds * 14.2);
  let collectedText = '';

  const searchUrl = `https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&srlimit=1&format=json`;
  const searchRes = await axios.get(searchUrl, {
    headers: { 'User-Agent': 'VideoCreatorBot/11.0 (NodeJS)' },
    timeout: 8000
  });

  const bestTitle = searchRes.data?.query?.search?.[0]?.title || topic;

  const extractUrl = `https://pt.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exchars=2500&redirects=1&format=json&titles=${encodeURIComponent(bestTitle)}`;
  const extractRes = await axios.get(extractUrl, {
    headers: { 'User-Agent': 'VideoCreatorBot/11.0 (NodeJS)' },
    timeout: 8000
  });

  const pages = extractRes.data?.query?.pages || {};
  const pageId = Object.keys(pages)[0];
  const fullExtract = pageId && pageId !== '-1' ? pages[pageId].extract : '';

  if (fullExtract && fullExtract.length > 60) {
    const cleanText = fullExtract
      .replace(/==+[^=]+==+/g, ' ')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const sentences = cleanText.split(/(?<=[.!?])\s+/);

    for (const s of sentences) {
      if ((collectedText + ' ' + s).length <= targetChars + 35) {
        collectedText = (collectedText + ' ' + s).trim();
      } else {
        break;
      }
    }
  }

  if (collectedText.length < 40) {
    collectedText = `${topic} é um tema fascinante que despertou grande interesse ao longo da história pela sua importância e impacto direto na sociedade e na ciência. Compreender seus detalhes revela como cada elemento funciona de maneira extraordinária.`;
  }

  const defaultScenes = [
    `Close-up cinematic photorealistic shot of ${englishTopic}, dramatic natural lighting, ultra detailed, 8k resolution`,
    `Wide angle panoramic view of ${englishTopic}, breathtaking scenery, movie scene, masterpiece photography`,
    `Aerial golden hour perspective of ${englishTopic}, vibrant colors, award winning national geographic style photo`
  ];

  return { narration: collectedText, searchKeywords: englishTopic, scenes: defaultScenes };
};

// Passo 0: Orquestrador do Roteiro e Cenas Visuais
const generateScriptAndPrompts = async (topic, durationSeconds) => {
  const isCustomLongText = topic.trim().length > 50;
  const visualSubject = isCustomLongText
    ? topic.trim().split(/\s+/).slice(0, 5).join(' ')
    : topic.trim();

  const englishTopic = await translateToEnglish(visualSubject);

  if (isCustomLongText) {
    console.log(`\n[Roteiro Personalizado Detectado]: "${topic.trim()}"`);
    return {
      narration: topic.trim(),
      searchKeywords: englishTopic,
      scenes: [
        `Close-up cinematic photorealistic shot of ${englishTopic}, dramatic lighting, 8k`,
        `Wide angle panoramic view of ${englishTopic}, breathtaking atmosphere, masterpiece`,
        `Epic detailed perspective of ${englishTopic}, vibrant colors, award winning photography`
      ]
    };
  }

  try {
    console.log(`\n[IA Roteirista] Criando explicacao unica e roteiro visual sobre "${topic}"...`);
    const creativeResult = await generateCreativeScriptWithAI(topic, durationSeconds, englishTopic);
    const wordCount = creativeResult.narration.split(/\s+/).length;
    console.log(`[Roteiro Criativo Gerado (${wordCount} palavras)]:\n"${creativeResult.narration}"`);
    return creativeResult;
  } catch (err) {
    console.warn(`[Aviso Roteirista IA]: ${err.message}. Acionando Busca Inteligente Wikipedia...`);
  }

  try {
    const wikiResult = await generateScriptFromSmartWikipedia(topic, durationSeconds, englishTopic);
    const wordCount = wikiResult.narration.split(/\s+/).length;
    console.log(`[Roteiro Enciclopedico Gerado (${wordCount} palavras)]:\n"${wikiResult.narration}"`);
    return wikiResult;
  } catch (err) {
    console.warn(`[Aviso Wikipedia]: ${err.message}`);
  }

  return {
    narration: `Vamos explorar os detalhes essenciais sobre ${topic}, entendendo sua origem, suas principais características e por que esse assunto chama tanta atenção nos dias de hoje.`,
    searchKeywords: englishTopic,
    scenes: [
      `Close-up cinematic shot of ${englishTopic}, 8k`,
      `Wide angle view of ${englishTopic}, cinematic lighting`,
      `Detailed perspective of ${englishTopic}, photorealistic`
    ]
  };
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

// =========================================================================
// FONTES DE IMAGENS EM ORDEM AUTOMÁTICA: 1. PIXABAY -> 2. IA FLUX -> 3. UNSPLASH
// =========================================================================

// Fonte 1: Pixabay API
const fetchFromPixabay = async (query, neededCount, startIndex, orientation) => {
  if (!rawPixabayKey) throw new Error('PIXABAY_API_KEY nao configurada');

  const url = `https://pixabay.com/api/?key=${rawPixabayKey}&q=${encodeURIComponent(query)}&image_type=photo&orientation=${orientation}&safesearch=true&per_page=${neededCount + 4}`;
  const res = await axios.get(url, { timeout: 15000 });
  const hits = res.data?.hits || [];

  if (hits.length === 0) throw new Error('Nenhuma foto encontrada no Pixabay');

  const downloaded = [];
  for (let i = 0; i < Math.min(neededCount, hits.length); i++) {
    const sceneNum = startIndex + i + 1;
    const imgUrl = hits[i].largeImageURL || hits[i].webformatURL;
    const imgPath = path.resolve(__dirname, `scene_img_${sceneNum}.jpg`);
    const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 25000 });
    await util.promisify(fs.writeFile)(imgPath, Buffer.from(imgRes.data));
    downloaded.push(imgPath);
    console.log(` -> [1. Pixabay] Cena ${sceneNum}/3 baixada (ID: ${hits[i].id})!`);
  }
  return downloaded;
};

// Fonte 2: IA FLUX.1-schnell (Hugging Face ZeroGPU)
const generateWithHFZeroGPUSpace = async (prompt, outputPath, width, height) => {
  const spaceUrl = 'https://black-forest-labs-flux-1-schnell.hf.space';
  const headers = { 'Content-Type': 'application/json' };
  if (rawHfToken) headers['Authorization'] = `Bearer ${rawHfToken}`;

  const w = width > height ? 1024 : 768;
  const h = height > width ? 1024 : 768;

  const callRes = await axios.post(
    `${spaceUrl}/gradio_api/call/infer`,
    { data: [prompt, 0, true, w, h, 4] },
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
          return true;
        }
      } catch (_) {}
    }
  }

  throw new Error('ZeroGPU Space nao retornou imagem');
};

// Fonte 3: Unsplash API
const fetchFromUnsplash = async (query, neededCount, startIndex, orientation) => {
  if (!rawUnsplashKey) throw new Error('UNSPLASH_ACCESS_KEY nao configurada');

  const unsplashOrient = orientation === 'vertical' ? 'portrait' : 'landscape';
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=${unsplashOrient}&per_page=${neededCount + 2}`;

  const res = await axios.get(url, {
    headers: { 'Authorization': `Client-ID ${rawUnsplashKey}` },
    timeout: 15000
  });

  const results = res.data?.results || [];
  if (results.length === 0) throw new Error('Nenhuma foto encontrada no Unsplash');

  const downloaded = [];
  for (let i = 0; i < Math.min(neededCount, results.length); i++) {
    const sceneNum = startIndex + i + 1;
    const imgUrl = results[i].urls?.regular || results[i].urls?.full;
    const imgPath = path.resolve(__dirname, `scene_img_${sceneNum}.jpg`);
    const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 25000 });
    await util.promisify(fs.writeFile)(imgPath, Buffer.from(imgRes.data));
    downloaded.push(imgPath);
    console.log(` -> [3. Unsplash] Cena ${sceneNum}/3 baixada (Foto por ${results[i].user?.name})!`);
  }
  return downloaded;
};

// Orquestrador Automatico: 1. Pixabay -> 2. IA FLUX -> 3. Unsplash
const collectVisualAssetsAutomatic = async (scriptData, formatObj) => {
  const totalNeeded = 3;
  const collectedPaths = [];

  // ETAPA 1: PIXABAY (Primeira Opcao)
  if (collectedPaths.length < totalNeeded) {
    try {
      console.log(`[Fonte 1/3 - Pixabay] Buscando imagens para "${scriptData.searchKeywords}"...`);
      const pixabayImgs = await fetchFromPixabay(
        scriptData.searchKeywords,
        totalNeeded - collectedPaths.length,
        collectedPaths.length,
        formatObj.orientation
      );
      collectedPaths.push(...pixabayImgs);
    } catch (e) {
      console.warn(` -> Pixabay pulado/incompleto (${e.message}).`);
    }
  }

  // ETAPA 2: IA FLUX.1-SCHNELL (Segunda Opcao - completa o que faltar)
  while (collectedPaths.length < totalNeeded) {
    const currentIndex = collectedPaths.length;
    const scenePrompt = scriptData.scenes[currentIndex] || scriptData.scenes[0];
    const imgPath = path.resolve(__dirname, `scene_img_${currentIndex + 1}.jpg`);

    try {
      console.log(`[Fonte 2/3 - IA FLUX] Gerando cena ${currentIndex + 1}/${totalNeeded} via Inteligencia Artificial...`);
      await generateWithHFZeroGPUSpace(scenePrompt, imgPath, formatObj.width, formatObj.height);
      collectedPaths.push(imgPath);
      console.log(` -> [2. IA FLUX] Cena ${currentIndex + 1}/3 gerada com sucesso!`);
    } catch (e) {
      console.warn(` -> IA FLUX falhou na cena ${currentIndex + 1} (${e.message}). Passando para Unsplash...`);
      break;
    }
  }

  // ETAPA 3: UNSPLASH (Terceira e Ultima Opcao - completa o restante)
  if (collectedPaths.length < totalNeeded) {
    try {
      console.log(`[Fonte 3/3 - Unsplash] Buscando ${totalNeeded - collectedPaths.length} imagem(ns) restante(s) para "${scriptData.searchKeywords}"...`);
      const unsplashImgs = await fetchFromUnsplash(
        scriptData.searchKeywords,
        totalNeeded - collectedPaths.length,
        collectedPaths.length,
        formatObj.orientation
      );
      collectedPaths.push(...unsplashImgs);
    } catch (e) {
      console.warn(` -> Aviso Unsplash (${e.message}).`);
    }
  }

  // Seguranca final: se conseguiu pelo menos 1 imagem, duplica caso tenha faltado alguma para fechar 3 cenas
  while (collectedPaths.length > 0 && collectedPaths.length < totalNeeded) {
    collectedPaths.push(collectedPaths[collectedPaths.length - 1]);
  }

  return collectedPaths;
};

// Passo 3: Transforma cada imagem em um clipe animado (Efeito Camera em Movimento / Ken Burns)
const createAnimatedClips = async (imagePaths, clipDuration, resolution) => {
  const [width, height] = resolution.split('x');
  const fps = 25;
  const totalFrames = Math.ceil(clipDuration * fps);
  const clipPaths = [];

  for (let i = 0; i < imagePaths.length; i++) {
    const clipPath = path.resolve(__dirname, `temp_clip_${i + 1}.mp4`);
    console.log(`Animando cena ${i + 1}/${imagePaths.length} (${clipDuration}s) com movimento de camera...`);

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
        console.log(`\nUnindo animacoes e narracao no video final (${totalDuration}s)...`);
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
    const safeTitle = sanitizeFileName(topicInput.split(/\s+/).slice(0, 4).join(' '));
    const outputFileName = `video-${safeTitle || 'final'}.mp4`;
    const outputPath = path.resolve(__dirname, outputFileName);

    console.log(`\nArquivo final sera salvo como: ${outputFileName}`);

    const scriptData = await generateScriptAndPrompts(topicInput, targetLength);

    console.log('\n[1/3] Gerando audio da narracao...');
    const audioPath = await generateNarration(scriptData.narration);
    if (!audioPath) return;

    const exactAudioDuration = await getAudioDuration(audioPath);
    const finalVideoDuration = exactAudioDuration
      ? parseFloat(Math.max(targetLength, exactAudioDuration + 0.8).toFixed(2))
      : targetLength;

    if (exactAudioDuration) {
      console.log(`[Sincronizacao] Fala real: ${exactAudioDuration.toFixed(2)}s | Solicitado: ${targetLength}s -> Duracao final: ${finalVideoDuration}s`);
    }

    console.log(`\n[2/3] Coletando 3 imagens (Pixabay -> IA FLUX -> Unsplash)...`);
    const imagePaths = await collectVisualAssetsAutomatic(scriptData, selectedFormat);

    if (imagePaths.length === 0) {
      console.error('Nenhuma imagem foi encontrada ou gerada em nenhuma das 3 fontes.');
      return;
    }

    console.log('\n[3/3] Criando animacoes de camera e compilando o video final...');
    await buildVideoWithFFmpeg(
      imagePaths,
      audioPath,
      outputPath,
      selectedFormat.size,
      finalVideoDuration
    );
  } catch (error) {
    console.error('Falha geral no processo:', error.message);
  }
};

createVideo();