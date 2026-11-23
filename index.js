require('dotenv').config();
const { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl');

if (!process.env.DISCORD_TOKEN) {
  console.error('Не найден DISCORD_TOKEN. Скопируй .env.example в .env и заполни настройки.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queues = new Map();
const IDLE_DISCONNECT_MS = 60_000;
let youtubeClientPromise;

function getYoutubeClient() {
  if (!youtubeClientPromise) {
    youtubeClientPromise = import('@distube/ytdl-core').then(module => ({
      client: new module.Ytdl({ lang: 'ru', country: 'RU', cookie: process.env.YOUTUBE_COOKIE || undefined }),
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
    queue = { player, connection: null, tracks: [], textChannel: null, starting: false, idleTimer: null, ffmpegProcess: null };
    player.on(AudioPlayerStatus.Idle, () => { queue.starting = false; stopEncoder(queue); queue.tracks.shift(); void playNext(guildId); });
    player.on('error', error => {
      console.error('Ошибка воспроизведения:', error.message);
      queue.starting = false;
      stopEncoder(queue);
      queue.tracks.shift();
      void playNext(guildId);
    });
    queues.set(guildId, queue);
  }
  return queue;
}

function stopEncoder(queue) {
  const process = queue.ffmpegProcess;
  queue.ffmpegProcess = null;
  if (process && process.exitCode === null && !process.killed) process.kill();
}

function clearIdleTimer(queue) {
  if (queue.idleTimer) clearTimeout(queue.idleTimer);
  queue.idleTimer = null;
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
      const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
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
  if (isUrl(input) && (play.yt_validate(input) === 'video' || play.yt_validate(input) === 'playlist')) {
    if (play.yt_validate(input) === 'playlist') {
      const playlist = await play.playlist_info(input, { incomplete: true });
      const videos = await playlist.all_videos();
      return videos.map(video => ({ title: video.title, author: video.channel?.name, url: video.url, duration: video.durationRaw }));
    }
    const info = await play.video_basic_info(input);
    return [{ title: info.video_details.title, author: info.video_details.channel?.name, url: info.video_details.url, duration: info.video_details.durationRaw }];
  }

  if (isUrl(input) && /soundcloud\.com\//i.test(input)) {
    const info = await play.soundcloud(input);
    return [{ title: info.name, author: info.user?.name, url: info.url, duration: null }];
  }

  // Spotify and Yandex links provide track metadata, but not a playable stream.
  // Resolve their title to a playable YouTube result.
  const query = isUrl(input) ? await getSearchText(input) : input;
  const { client: youtube, SearchType } = await getYoutubeClient();
  const options = { limit: 1, signal: AbortSignal.timeout(15_000) };
  let results;
  try {
    results = await youtube.search(query, { ...options, type: SearchType.Song });
    if (!results.length) results = await youtube.search(query, options);
  } catch (error) {
    console.error('Не удалось выполнить поиск на YouTube:', error.message);
    throw new Error('Не удалось найти трек. Попробуй другое название или ссылку.');
  }
  const video = results.find(item => item.url);
  if (!video) throw new Error('Не удалось найти трек. Попробуй другое название или ссылку.');
  const duration = Number.isFinite(video.lengthSeconds)
    ? `${Math.floor(video.lengthSeconds / 60)}:${String(video.lengthSeconds % 60).padStart(2, '0')}`
    : null;
  return [{ title: video.title, author: video.author?.name, url: video.url, duration }];
}

async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue || queue.starting) return;
  if (!queue.tracks.length) { scheduleIdleDisconnect(guildId, queue); return; }
  clearIdleTimer(queue);
  queue.starting = true;
  const track = queue.tracks[0];
  try {
    const { client: youtube, Quality } = await getYoutubeClient();
    if (queues.get(guildId) !== queue || queue.tracks[0] !== track) return;
    // Discord can forward Opus packets directly; selecting WebM/Opus avoids
    // probing/transcoding the stream and does not require an FFmpeg install.
    if (!ffmpegPath) throw new Error('Не найден FFmpeg. Повтори установку зависимостей через start.bat.');
    const audioStream = youtube.download(track.url, { quality: Quality.HighestAudio, filter: { hasAudio: true, hasVideo: false, audioCodec: 'opus' } });
    // The queue may have been stopped while the stream URL was being resolved.
    if (queues.get(guildId) !== queue || queue.tracks[0] !== track) { audioStream.destroy(); return; }
    const encoder = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-vn',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-application', 'audio',
      '-f', 'ogg', 'pipe:1',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    queue.ffmpegProcess = encoder;
    let encoderError = '';
    encoder.stderr.setEncoding('utf8');
    encoder.stderr.on('data', chunk => { encoderError = (encoderError + chunk).slice(-4000); });
    encoder.stdin.on('error', error => { if (error.code !== 'EPIPE') console.error('Ошибка входного потока FFmpeg:', error.message); });
    audioStream.on('error', error => encoder.stdin.destroy(error));
    encoder.on('error', error => encoder.stdout.destroy(error));
    encoder.on('close', code => {
      if (code !== 0 && !encoder.stdout.destroyed) {
        encoder.stdout.destroy(new Error(encoderError.trim() || `FFmpeg завершился с кодом ${code}`));
      }
    });
    audioStream.pipe(encoder.stdin);
    queue.player.play(createAudioResource(encoder.stdout, { inputType: StreamType.OggOpus, metadata: track }));
    queue.starting = false;
    await queue.textChannel?.send(`▶️ Сейчас играет: **${track.title}**${track.author ? ` — ${track.author}` : ''}${track.duration ? ` (${track.duration})` : ''}`);
  } catch (error) {
    console.error(`Не удалось включить «${track.title}»:`, error.message);
    queue.starting = false;
    queue.tracks.shift();
    await queue.textChannel?.send(`Не получилось включить **${track.title}**. Перехожу дальше.`).catch(() => {});
    await playNext(guildId);
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Бот запущен: ${readyClient.user.tag}`);
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
      stopEncoder(queue);
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
    try {
      const tracks = await resolveTrack(input);
      const queue = getQueue(interaction.guildId);
      if (!queue.connection || queue.connection.state.status === 'destroyed') {
        queue.connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: interaction.guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true });
        queue.connection.subscribe(queue.player);
      } else if (queue.connection.joinConfig.channelId !== voiceChannel.id) {
        return interaction.editReply('Бот уже играет в другом голосовом канале.');
      }
      queue.textChannel = interaction.channel;
      clearIdleTimer(queue);
      queue.tracks.push(...tracks);
      const first = tracks[0];
      await interaction.editReply(tracks.length > 1
        ? `Добавлен плейлист: **${tracks.length} треков** (первый — **${first.title}**).`
        : `Добавлено в очередь: **${first.title}**`);
      if (queue.player.state.status !== AudioPlayerStatus.Playing && !queue.starting) void playNext(interaction.guildId);
    } catch (error) {
      console.error('Ошибка поиска:', error);
      await interaction.editReply(error.message || 'Не удалось найти или открыть этот трек.');
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
