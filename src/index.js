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
const YOUTUBE_LOOKUP_TIMEOUT_MS = 8_000;
const AUDIO_PREFETCH_TIMEOUT_MS = 8_000;
let youtubeClientPromise;

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
      if (/cookie.*(signed out|expired|invalid)|treats the cookie as signed out/i.test(error.message)) {
        queue.tracks.length = 0;
        queue.player.stop(true);
        void queue.textChannel?.send('⏹️ YouTube отклонил cookie: он устарел или аккаунт вышел из него. Обнови `YOUTUBE_COOKIE` на хостинге или удали переменную, затем перезапусти бота.').catch(() => {});
        return;
      }
      if (queue.tracks[0] === failedTrack && failedTrack?.alternatives?.length) {
        const nextTrack = failedTrack.alternatives.shift();
        nextTrack.alternatives = failedTrack.alternatives;
        queue.tracks[0] = nextTrack;
        console.warn(`Видео недоступно, пробую следующий результат: ${nextTrack.title}`);
        void playNext(guildId);
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
  } catch { /* Use the URL as a search query below. */ }
  return url;
}

async function resolveTrack(input) {
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
      info,
      duration: Number.isFinite(video.lengthSeconds)
        ? `${Math.floor(video.lengthSeconds / 60)}:${String(video.lengthSeconds % 60).padStart(2, '0')}`
        : null,
    }];
  }

  if (isUrl(input) && /soundcloud\.com\//i.test(input)) {
    const info = await play.soundcloud(input);
    return [{ title: info.name, author: info.user?.name, url: info.url, duration: null }];
  }

  // Spotify and Yandex links provide track metadata, but not a playable stream.
  // Resolve their title to a playable YouTube result.
  const query = isUrl(input) ? await getSearchText(input) : input;
  const { client: youtube, SearchType } = await getYoutubeClient();
  const options = { limit: 3, signal: AbortSignal.timeout(YOUTUBE_LOOKUP_TIMEOUT_MS), type: SearchType.Video };
  let results;
  let searchError;
  try {
    results = await youtube.search(query, options);
  } catch (error) {
    searchError = error;
    console.warn('Поиск через ytdl не сработал, пробую резервный поиск:', error.message);
    try {
      results = await Promise.race([
        play.search(query, { limit: 3, source: { youtube: 'video' } }),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Резервный поиск превысил лимит времени')), 5000);
          timer.unref?.();
        }),
      ]);
    }
    catch (fallbackError) {
      console.error('Не удалось выполнить поиск на YouTube:', fallbackError.message);
      throw new Error(searchError.code === 'HPE_HEADER_OVERFLOW'
        ? 'YouTube вернул некорректный ответ. Попробуй ещё раз через минуту или вставь прямую ссылку.'
        : 'Не удалось найти трек. Попробуй другое название или ссылку.');
    }
  }
  const candidates = results.filter(item => item.url && !item.isLive && !item.isUpcoming).slice(0, 3);
  const video = candidates[0];
  if (!video) throw new Error('Не удалось найти трек. Попробуй другое название или ссылку.');
  const toTrack = item => {
    const seconds = Number.isFinite(item.lengthSeconds) ? item.lengthSeconds : item.durationInSec;
    return {
      title: item.title,
      author: item.author?.name || item.channel?.name || item.channel?.title,
      url: item.url,
      duration: Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : item.durationRaw || null,
    };
  };
  const track = toTrack(video);
  // Resolve media formats before acknowledging the queue entry so playback does not
  // perform this separate YouTube lookup after the user sees "Сейчас играет".
  track.info = await youtube.getInfo(track.url, { signal: AbortSignal.timeout(YOUTUBE_LOOKUP_TIMEOUT_MS) });
  const details = track.info.videoDetails;
  track.title = details.title || track.title;
  track.author = details.author?.name || track.author;
  if (Number.isFinite(details.lengthSeconds)) {
    track.duration = `${Math.floor(details.lengthSeconds / 60)}:${String(details.lengthSeconds % 60).padStart(2, '0')}`;
  }
  track.alternatives = candidates.slice(1).map(toTrack);
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
    const onEnd = () => { cleanup(); reject(new Error('YouTube завершил поток до получения аудио')); };
    const onError = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('YouTube долго готовил аудиопоток. Попробуй ещё раз.')); }, timeoutMs);
    timer.unref?.();
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

async function prepareTrackStream(track) {
  const { client: youtube, Quality } = await getYoutubeClient();
  if (!track.info) track.info = await youtube.getInfo(track.url, { signal: AbortSignal.timeout(YOUTUBE_LOOKUP_TIMEOUT_MS) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const stream = youtube.download(track.info, {
      quality: Quality.HighestAudio,
      filter: { hasAudio: true, hasVideo: false, audioCodec: 'opus' },
    });
    try {
      await waitForReadableData(stream, AUDIO_PREFETCH_TIMEOUT_MS);
      track.preparedStream = stream;
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
    const { client: youtube, Quality } = await getYoutubeClient();
    if (queues.get(guildId) !== queue || queue.tracks[0] !== track) return;
    // Pass YouTube's Opus stream straight to Discord to avoid FFmpeg startup and transcoding delay.
    const audioStream = track.preparedStream || youtube.download(track.info || track.url, { quality: Quality.HighestAudio, filter: { hasAudio: true, hasVideo: false, audioCodec: 'opus' } });
    track.preparedStream = null;
    // The queue may have been stopped while the stream URL was being resolved.
    if (queues.get(guildId) !== queue || queue.tracks[0] !== track) { audioStream.destroy(); return; }
    audioStream.on('error', error => {
      console.error('Ошибка потока YouTube:', error.message);
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
    queue.player.play(createAudioResource(audioStream, { inputType: StreamType.WebmOpus, metadata: track }));
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
    await interaction.editReply('🔎 Ищу трек и подготавливаю аудио…');
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
