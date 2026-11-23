require('dotenv').config();
const { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const play = require('play-dl');

if (!process.env.DISCORD_TOKEN) {
  console.error('Не найден DISCORD_TOKEN. Скопируй .env.example в .env и заполни настройки.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queues = new Map();
const IDLE_DISCONNECT_MS = 60_000;
const YOUTUBE_LOOKUP_TIMEOUT_MS = 5_000;
const AUDIO_PREFETCH_TIMEOUT_MS = 5_000;
const TRACK_CACHE_TTL_MS = 300_000;
let youtubeClientPromise;
const trackCache = new Map();

function getYoutubeClient() {
  if (!youtubeClientPromise) {
    youtubeClientPromise = import('@distube/ytdl-core').then(module => ({
      // These clients accept an authenticated cookie and do not require PO-token minting.
      // A signed-in cookie can help when YouTube blocks requests from datacenter IPs.
      client: new module.Ytdl({
        lang: 'ru',
        country: 'RU',
        cookie: process.env.YOUTUBE_COOKIE || undefined,
        clients: [module.Client.WebEmbedded, module.Client.Tv],
      }),
      Quality: module.Quality,
      SearchType: module.SearchType,
    }));
  }
  return youtubeClientPromise;
}

function getQueue(guildId) {
  let queue = queues.get(guildId);
  if (!queue) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    queue = { player, connection: null, tracks: [], currentTrack: null, textChannel: null, starting: false, idleTimer: null, retryTimer: null };
    player.on(AudioPlayerStatus.Idle, () => {
      queue.starting = false;
      if (queue.currentTrack && queue.tracks[0] === queue.currentTrack) queue.tracks.shift();
      queue.currentTrack = null;
      void playNext(guildId);
    });
    player.on('error', error => {
      console.error('Ошибка воспроизведения:', error.message);
      queue.starting = false;
      const failedTrack = error.resource?.metadata || queue.currentTrack;
      if (retryPrematureStream(queue, guildId, failedTrack, error)) return;
      queue.currentTrack = null;
      if (queue.tracks[0] === failedTrack && failedTrack?.alternatives?.length) {
        const nextTrack = failedTrack.alternatives.shift();
        nextTrack.alternatives = failedTrack.alternatives;
        queue.tracks[0] = nextTrack;
        console.warn(`Источник недоступен, пробую следующий результат: ${nextTrack.title} (${nextTrack.source || 'youtube'})`);
        void playNext(guildId);
        return;
      }
      if (/cookie.*(signed out|expired|invalid)|treats the cookie as signed out/i.test(error.message)) {
        queue.tracks.length = 0;
        queue.player.stop(true);
        void queue.textChannel?.send('⏹️ YouTube отклонил cookie: он устарел или аккаунт вышел из него. Обнови `YOUTUBE_COOKIE` на хостинге или удали переменную, затем перезапусти бота.').catch(() => {});
        return;
      }
      queue.tracks.shift();
      void playNext(guildId);
    });
    queues.set(guildId, queue);
  }
  return queue;
}

function clearIdleTimer(queue) {
  if (queue.idleTimer) clearTimeout(queue.idleTimer);
  queue.idleTimer = null;
}

function retryPrematureStream(queue, guildId, track, error) {
  if (!track || !/premature close/i.test(error.message)) return false;
  if (track._retryScheduled) return true;
  if (track._prematureCloseRetried) return false;
  track._prematureCloseRetried = true;
  track._retryScheduled = true;
  queue.currentTrack = null;
  queue.starting = false;
  queue.retryTimer = setTimeout(() => {
    queue.retryTimer = null;
    track._retryScheduled = false;
    if (queues.get(guildId) === queue && queue.tracks[0] === track) void playNext(guildId);
  }, 500);
  queue.retryTimer.unref?.();
  queue.player.stop(true);
  return true;
}

function scheduleIdleDisconnect(guildId, queue) {
  clearIdleTimer(queue);
  if (!queue.connection || queue.tracks.length || queue.starting) return;
  queue.idleTimer = setTimeout(() => {
    if (queues.get(guildId) !== queue || queue.tracks.length || queue.starting) return;
    queue.connection?.destroy();
    queues.delete(guildId);
  }, IDLE_DISCONNECT_MS);
}

function isUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

async function getSearchText(url) {
  try {
    if (/open\.spotify\.com\/track\//i.test(url)) {
      const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(6000) });
      if (response.ok) {
        const data = await response.json();
        if (data.title) return data.title;
      }
    }
    if (/music\.yandex\.(ru|com)\//i.test(url)) {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const html = await response.text();
        const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]
          || html.match(/<title>([^<]+)/i)?.[1];
        if (title) return title.replace(/&amp;/g, '&').replace(/&#39;|&quot;/g, '');
      }
    }
    if (/deezer\.com\//i.test(url)) {
      const track = await play.deezer(url);
      if (track?.type === 'track' && track.title) return `${track.artist?.name || ''} ${track.title}`.trim();
    }
  } catch { /* Use the URL as a search query below. */ }
  return url;
}

async function resolveTrack(input) {
  const cacheKey = isUrl(input) ? null : input.trim().toLocaleLowerCase('ru-RU');
  if (cacheKey) {
    const cached = trackCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return [{ ...cached.track, alternatives: cached.track.alternatives.map(item => ({ ...item })), announced: false }];
    }
    if (cached) trackCache.delete(cacheKey);
  }
  const youtubeType = isUrl(input) ? play.yt_validate(input) : false;
  const youtubeUrl = isUrl(input) ? new URL(input) : null;
  const isRadioMix = youtubeType === 'playlist'
    && youtubeUrl?.searchParams.has('v')
    && /^RD/i.test(youtubeUrl.searchParams.get('list') || '');
  if (isUrl(input) && (youtubeType === 'video' || youtubeType === 'playlist')) {
    const { client: youtube } = await getYoutubeClient();
    if (youtubeType === 'playlist' && !isRadioMix) {
      const playlist = await youtube.getPlaylist(input, { limit: 100, signal: AbortSignal.timeout(20_000) });
      return playlist.videos.map(video => ({
        title: video.title,
        author: video.author?.name,
        url: video.url,
        duration: Number.isFinite(video.lengthSeconds)
          ? `${Math.floor(video.lengthSeconds / 60)}:${String(video.lengthSeconds % 60).padStart(2, '0')}`
          : null,
      }));
    }
    const info = await youtube.getInfo(input, { signal: AbortSignal.timeout(YOUTUBE_LOOKUP_TIMEOUT_MS) });
    const video = info.videoDetails;
    return [{
      title: video.title,
      author: video.author?.name,
      url: video.url,
      source: 'youtube',
      info,
      duration: Number.isFinite(video.lengthSeconds)
        ? `${Math.floor(video.lengthSeconds / 60)}:${String(video.lengthSeconds % 60).padStart(2, '0')}`
        : null,
    }];
  }

  if (isUrl(input) && /soundcloud\.com\//i.test(input)) {
    const info = await play.soundcloud(input);
    return [{ title: info.name, author: info.user?.name, url: info.url, source: 'soundcloud', duration: Number.isFinite(info.durationInSec) ? `${Math.floor(info.durationInSec / 60)}:${String(info.durationInSec % 60).padStart(2, '0')}` : null }];
  }

  // Spotify, Yandex Music and Deezer links provide track metadata, not a full
  // stream for this bot. Match their title against playable YouTube/SoundCloud results.
  const query = isUrl(input) ? await getSearchText(input) : input;
  const { client: youtube, SearchType } = await getYoutubeClient();
  const options = { limit: 3, signal: AbortSignal.timeout(YOUTUBE_LOOKUP_TIMEOUT_MS), type: SearchType.Video };
  const startedAt = Date.now();
  const [youtubeResult, soundCloudResult, deezerResult] = await Promise.allSettled([
    youtube.search(query, options).then(items => ({ source: 'youtube', items, elapsed: Date.now() - startedAt })),
    Promise.race([
      play.search(query, { limit: 3, source: { soundcloud: 'tracks' } }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('SoundCloud search timed out')), YOUTUBE_LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).then(items => ({ source: 'soundcloud', items, elapsed: Date.now() - startedAt })),
    Promise.race([
      play.search(query, { limit: 3, source: { deezer: 'track' } }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Deezer search timed out')), YOUTUBE_LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).then(items => ({ source: 'deezer', items, elapsed: Date.now() - startedAt })),
  ]);
  const searchResults = [youtubeResult, soundCloudResult]
    .filter(result => result.status === 'fulfilled' && result.value.items?.length)
    .map(result => result.value)
    .sort((a, b) => a.elapsed - b.elapsed);
  const toYoutubeTrack = item => {
    const seconds = Number.isFinite(item.lengthSeconds) ? item.lengthSeconds : item.durationInSec;
    return {
      title: item.title,
      author: item.author?.name || item.channel?.name || item.channel?.title,
      url: item.url,
      source: 'youtube',
      duration: Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : item.durationRaw || null,
    };
  };
  const toSoundCloudTrack = item => ({
    title: item.name || item.title,
    author: item.user?.name || item.publisher?.artist || item.author?.name,
    url: item.permalink || item.url,
    source: 'soundcloud',
    duration: Number.isFinite(item.durationInSec) ? `${Math.floor(item.durationInSec / 60)}:${String(item.durationInSec % 60).padStart(2, '0')}` : null,
  });
  const candidates = searchResults.flatMap(result => result.source === 'youtube'
    ? result.items.filter(item => item.url && !item.isLive && !item.isUpcoming).slice(0, 3).map(toYoutubeTrack)
    : result.items.filter(item => item.permalink || item.url).slice(0, 3).map(toSoundCloudTrack));
  if (!candidates.length) throw new Error('Не удалось найти трек в YouTube или SoundCloud. Попробуй другое название или ссылку.');
  const deezerItems = deezerResult.status === 'fulfilled' ? deezerResult.value.items : [];
  const referenceTrack = deezerItems[0];
  if (referenceTrack) {
    const words = `${referenceTrack.artist?.name || ''} ${referenceTrack.title || ''}`
      .toLocaleLowerCase('ru-RU').split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1);
    const score = candidate => {
      const text = `${candidate.title || ''} ${candidate.author || ''}`.toLocaleLowerCase('ru-RU');
      return words.length ? words.filter(word => text.includes(word)).length / words.length : 0;
    };
    candidates.sort((a, b) => score(b) - score(a));
  }
  let track;
  let infoError;
  while (candidates.length) {
    const candidate = candidates.shift();
    if (candidate.source === 'youtube') {
      try {
        const info = await youtube.getInfo(candidate.url, { signal: AbortSignal.timeout(YOUTUBE_LOOKUP_TIMEOUT_MS) });
        candidate.info = info;
        candidate.title = info.videoDetails.title || candidate.title;
        candidate.author = info.videoDetails.author?.name || candidate.author;
        if (Number.isFinite(info.videoDetails.lengthSeconds)) {
          candidate.duration = `${Math.floor(info.videoDetails.lengthSeconds / 60)}:${String(info.videoDetails.lengthSeconds % 60).padStart(2, '0')}`;
        }
        track = candidate;
        break;
      } catch (error) {
        infoError = error;
        console.warn('YouTube result unavailable, trying another source:', error.message);
      }
    } else {
      track = candidate;
      break;
    }
  }
  if (!track) {
    if (infoError?.code === 'HPE_HEADER_OVERFLOW') throw new Error('YouTube вернул некорректный ответ. Попробуй ещё раз или вставь прямую ссылку.');
    throw new Error('Не удалось открыть найденные треки. Попробуй другое название или ссылку.');
  }
  track.alternatives = candidates;
  if (cacheKey) {
    trackCache.set(cacheKey, {
      track: { ...track, alternatives: track.alternatives.map(item => ({ ...item })), preparedStream: null, announced: false },
      expiresAt: Date.now() + TRACK_CACHE_TTL_MS,
    });
    if (trackCache.size > 100) trackCache.delete(trackCache.keys().next().value);
  }
  return [track];
}

function waitForReadableData(stream, timeoutMs) {
  if (stream.readableLength > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    const onReadable = () => {
      if (stream.readableLength > 0) { cleanup(); resolve(); }
    };
    const onEnd = () => { cleanup(); reject(new Error('Источник завершил поток до получения аудио')); };
    const onError = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Источник долго готовил аудиопоток. Попробуй ещё раз.')); }, timeoutMs);
    timer.unref?.();
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

async function prepareTrackStream(track) {
  let youtube;
  let Quality;
  if (track.source !== 'soundcloud') {
    ({ client: youtube, Quality } = await getYoutubeClient());
    if (!track.info) track.info = await youtube.getInfo(track.url, { signal: AbortSignal.timeout(YOUTUBE_LOOKUP_TIMEOUT_MS) });
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let stream;
    let inputType;
    if (track.source === 'soundcloud') {
      const result = await play.stream(track.url, { discordPlayerCompatibility: true });
      stream = result.stream;
      inputType = Object.values(StreamType).includes(result.type) ? result.type : StreamType.Arbitrary;
    } else {
      stream = youtube.download(track.info, {
        quality: Quality.HighestAudio,
        filter: { hasAudio: true, hasVideo: false, audioCodec: 'opus' },
      });
      inputType = StreamType.WebmOpus;
    }
    try {
      await waitForReadableData(stream, AUDIO_PREFETCH_TIMEOUT_MS);
      track.preparedStream = stream;
      track.preparedInputType = inputType;
      return;
    } catch (error) {
      stream.destroy();
      if (attempt === 0 && /premature close/i.test(error.message)) continue;
      throw error;
    }
  }
}

async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue || queue.starting || queue.retryTimer) return;
  if (!queue.tracks.length) { scheduleIdleDisconnect(guildId, queue); return; }
  clearIdleTimer(queue);
  queue.starting = true;
  const track = queue.tracks[0];
  try {
    if (queues.get(guildId) !== queue || queue.tracks[0] !== track) return;
    let audioStream = track.preparedStream;
    let inputType = track.preparedInputType;
    if (!audioStream && track.source === 'soundcloud') {
      const result = await play.stream(track.url, { discordPlayerCompatibility: true });
      audioStream = result.stream;
      inputType = Object.values(StreamType).includes(result.type) ? result.type : StreamType.Arbitrary;
    } else if (!audioStream) {
      const { client: youtube, Quality } = await getYoutubeClient();
      audioStream = youtube.download(track.info || track.url, { quality: Quality.HighestAudio, filter: { hasAudio: true, hasVideo: false, audioCodec: 'opus' } });
      inputType = StreamType.WebmOpus;
    }
    track.preparedStream = null;
    track.preparedInputType = null;
    // The queue may have been stopped while the stream URL was being resolved.
    if (queues.get(guildId) !== queue || queue.tracks[0] !== track) { audioStream.destroy(); return; }
    audioStream.on('error', error => {
      console.error(`Ошибка аудиопотока (${track.source || 'youtube'}):`, error.message);
      retryPrematureStream(queue, guildId, track, error);
    });
    queue.currentTrack = track;
    if (!track.announced) {
      await queue.textChannel?.send(`▶️ Сейчас играет: **${track.title}**${track.author ? ` — ${track.author}` : ''}${track.duration ? ` (${track.duration})` : ''}`).catch(() => {});
    }
    track.announced = false;
    if (queues.get(guildId) !== queue || queue.tracks[0] !== track) {
      audioStream.destroy();
      if (queue.currentTrack === track) queue.currentTrack = null;
      return;
    }
    queue.player.play(createAudioResource(audioStream, { inputType, metadata: track }));
    queue.starting = false;
  } catch (error) {
    console.error(`Не удалось включить «${track.title}»:`, error.message);
    queue.starting = false;
      const failedTrack = track;
      queue.currentTrack = null;
      if (queue.tracks[0] === failedTrack && failedTrack.alternatives?.length) {
        const nextTrack = failedTrack.alternatives.shift();
        nextTrack.alternatives = failedTrack.alternatives;
        queue.tracks[0] = nextTrack;
        await queue.textChannel?.send(`Трек недоступен, пробую другой результат: **${nextTrack.title}**`).catch(() => {});
        await playNext(guildId);
        return;
      }
      queue.tracks.shift();
    await queue.textChannel?.send(`Не получилось включить **${track.title}**. Перехожу дальше.`).catch(() => {});
    await playNext(guildId);
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Бот запущен: ${readyClient.user.tag}`);
  console.log(`YouTube cookie: ${process.env.YOUTUBE_COOKIE ? 'задана' : 'не задана'}`);
  // Remove a stale voice state left behind if the previous process was killed abruptly.
  for (const guild of readyClient.guilds.cache.values()) {
    try {
      const self = guild.members.me ?? await guild.members.fetchMe();
      if (self.voice.channelId) {
        const canMove = self.voice.channel?.permissionsFor(self).has(PermissionFlagsBits.MoveMembers)
          ?? self.permissions.has(PermissionFlagsBits.MoveMembers);
        if (!canMove) {
          console.warn(`Бот всё ещё числится в голосовом канале сервера ${guild.id}. Для очистки после аварийного перезапуска выдайте ему право «Перемещать участников» в этом канале.`);
          continue;
        }
        await self.voice.disconnect('Очистка голосового подключения после перезапуска бота');
      }
    } catch (error) {
      console.warn(`Не удалось очистить старое голосовое подключение на сервере ${guild.id}:`, error.message);
    }
  }
});

let shutdownPromise;
function gracefulShutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`Получен ${signal}, закрываю голосовые подключения...`);
    for (const queue of queues.values()) {
      clearIdleTimer(queue);
      queue.tracks.length = 0;
      queue.player.stop(true);
      try { queue.connection?.destroy(); } catch (error) { console.warn('Не удалось закрыть голосовое подключение:', error.message); }
    }
    queues.clear();
    client.destroy();
  })();
  return shutdownPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void gracefulShutdown(signal).finally(() => process.exit(0));
  });
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return interaction.reply({ content: 'Эта команда доступна на сервере.', flags: MessageFlags.Ephemeral });
  const voiceChannel = interaction.member.voice?.channel;

  if (interaction.commandName === 'play') {
    if (!voiceChannel) return interaction.reply({ content: 'Сначала зайди в голосовой канал.', flags: MessageFlags.Ephemeral });
    const input = interaction.options.getString('запрос', true).trim();
    await interaction.deferReply();
    await interaction.editReply('🔎 Ищу трек в YouTube, SoundCloud и Deezer…');
    const queue = getQueue(interaction.guildId);
    try {
      if (!queue.connection || queue.connection.state.status === 'destroyed') {
        queue.connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: interaction.guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true });
        queue.connection.subscribe(queue.player);
      } else if (queue.connection.joinConfig.channelId !== voiceChannel.id) {
        return interaction.editReply('Бот уже играет в другом голосовом канале.');
      }
      queue.textChannel = interaction.channel;
      clearIdleTimer(queue);
      const tracks = await resolveTrack(input);
      if (tracks[0]) await prepareTrackStream(tracks[0]);
      const startsImmediately = queue.tracks.length === 0
        && !queue.starting
        && queue.player.state.status !== AudioPlayerStatus.Playing;
      queue.tracks.push(...tracks);
      const first = tracks[0];
      const firstLabel = `**${first.title}**${first.author ? ` — ${first.author}` : ''}`;
      if (startsImmediately) {
        first.announced = true;
        await interaction.editReply(`▶️ Сейчас играет: ${firstLabel}${first.duration ? ` (${first.duration})` : ''}`);
      } else {
        await interaction.editReply(tracks.length > 1
          ? `Добавлен плейлист: **${tracks.length} треков** (первый — ${firstLabel}).`
          : `Добавлено в очередь: ${firstLabel}`);
      }
      if (queue.player.state.status !== AudioPlayerStatus.Playing && !queue.starting) void playNext(interaction.guildId);
    } catch (error) {
      console.error('Ошибка поиска:', error.message);
      const message = error.code === 'HPE_HEADER_OVERFLOW'
        ? 'YouTube вернул некорректный ответ. Попробуй ещё раз позже или вставь прямую ссылку на видео.'
        : (error.message || 'Не удалось найти или открыть этот трек.');
      await interaction.editReply(message);
      if (!queue.tracks.length) scheduleIdleDisconnect(interaction.guildId, queue);
      if (!queue.connection && !queue.tracks.length) queues.delete(interaction.guildId);
    }
    return;
  }

  const queue = queues.get(interaction.guildId);
  if (!queue || !queue.connection) return interaction.reply({ content: 'Сейчас ничего не играет.', flags: MessageFlags.Ephemeral });
  if (voiceChannel && queue.connection.joinConfig.channelId !== voiceChannel.id) {
    return interaction.reply({ content: 'Зайди в тот же голосовой канал, где находится бот.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.commandName === 'skip') {
    if (!queue.tracks.length) return interaction.reply({ content: 'Очередь уже пуста.', flags: MessageFlags.Ephemeral });
    if (queue.starting && queue.player.state.status === AudioPlayerStatus.Idle) {
      const pendingTrack = queue.tracks.shift();
      queue.currentTrack = null;
      queue.starting = false;
      if (pendingTrack?.preparedStream) pendingTrack.preparedStream.destroy();
      void playNext(interaction.guildId);
      return interaction.reply('⏭️ Переключаю трек.');
    }
    queue.player.stop(true);
    return interaction.reply('⏭️ Переключаю трек.');
  }
  if (interaction.commandName === 'stop') {
    clearIdleTimer(queue);
    queue.tracks = [];
    queue.starting = false;
    queue.player.stop(true);
    queue.connection.destroy();
    queues.delete(interaction.guildId);
    return interaction.reply('⏹️ Воспроизведение остановлено, очередь очищена.');
  }
});

client.login(process.env.DISCORD_TOKEN);
